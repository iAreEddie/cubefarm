import fs from 'node:fs';
import path from 'node:path';
import { playwrightCore } from './browser.ts';
import type { LivePlaytestStatus, LiveServerMessage } from '../shared/types.ts';

// Watching an agent's actual test browser live (#16). The office doesn't launch or drive anything of its own: each
// browser-testing session's pinned Playwright MCP still launches and owns the browser, but through a config file it
// keeps a profile on disk and opens a loopback-only CDP port Chrome records in DevToolsActivePort. When someone opens
// the Live playtest view for that agent, the office attaches to that exact browser over CDP and screencasts its page,
// read-only. Closing the view stops the screencast. A frame is JPEG/bounded, only the latest is kept, and nothing of
// the office's snapshot or log channels carries frame data.
//
// The capture core (LiveCaptureHub) takes its browser from an injectable LiveBackend, so its lifecycle is tested
// offline without Chrome (server/liveCapture.test.ts).

/** A viewer of one agent's live browser: its websocket, as far as streaming cares. */
export interface LiveSink {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
}

/** The profile folder the MCP keeps inside a session's browser output folder (server/browser.ts). */
export const BROWSER_PROFILE_DIR = 'browser-profile';
export const profileDirFor = (browserDir: string) => path.join(browserDir, BROWSER_PROFILE_DIR);

/** Frames pushed to a viewer per second at most; the screencast may produce more and the extra ones are dropped. */
export const LIVE_MAX_FPS = 10;
/** A viewer this far behind is skipped entirely (frames are dropped, never queued) until its socket drains. */
export const LIVE_STALE_BYTES = 2 * 1024 * 1024;
/** A JPEG larger than this is dropped, so a busy page can't flood a viewer's socket. */
export const LIVE_MAX_FRAME_BYTES = 900 * 1024;
/** How long a finished capture keeps its last frame around, so a viewer can still see it labelled as ended. */
export const LIVE_ENDED_KEEP_MS = 2 * 60_000;
/** How often the office checks a session's profile folder for the browser's CDP port while a viewer waits. */
export const ATTACH_POLL_MS = 400;

/** The screencast's own limits: a capped, lightly compressed JPEG (per-frame, not the saved QA screenshots). */
export function screencastParams() {
  return { format: 'jpeg' as const, quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 };
}

/** The CDP port Chrome wrote into a profile's DevToolsActivePort file, or null while there's no browser yet. */
export function devToolsPort(profileDir: string): number | null {
  try {
    const port = Number(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/, 1)[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** The loopback-only CDP endpoint for a watched session's profile folder, or null while there's no browser. */
export function cdpEndpoint(profileDir: string): string | null {
  const port = devToolsPort(profileDir);
  return port ? `http://127.0.0.1:${port}` : null;
}

/** Whether a frame may go out now, given the last one's time: the frame-rate cap for a watched browser. */
export const frameDue = (lastAt: number, now: number, maxFps = LIVE_MAX_FPS) => now - lastAt >= 1000 / maxFps;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- what a browser capture looks like, injectable for tests ----------

/** One screencasted frame, as it goes on the wire (base64 so it can travel as JSON on the live socket). */
export interface LiveFrame {
  data: string; // base64
  mime: string;
  at: number;
}

/** A live page the office can screencast, read-only. */
export interface LiveConnection {
  /** The page's URL right now, or null before there is one. */
  url(): string | null;
  /** Start screencasting the agent's current page; returns a function that stops it. */
  stream(onFrame: (f: LiveFrame) => void, onUrl: (url: string) => void): Promise<() => void>;
  /** Disconnect from the browser. Never closes it: the agent's own browser keeps running. */
  close(): Promise<void>;
}

/** How the hub reaches a session's browser. The real one uses CDP; the demo and tests bring their own. */
export interface LiveBackend {
  /**
   * Wait for `profileDir`'s browser to appear, then attach read-only. Resolves null when the office can't watch at all
   * (playwright-core missing); rejects on an attach failure after the browser was found. `cancelled` becomes true when
   * the last viewer left or the session ended, so a wait doesn't outlive demand.
   */
  attach(profileDir: string, cancelled: () => boolean): Promise<LiveConnection | null>;
  /** The demo's synthetic browser: a moving test page with no Chrome at all. `name` labels it. */
  fake?(name?: string): LiveConnection;
}

/** The real backend: attach to the MCP's own browser over its loopback CDP port and screencast its active page. */
export function realLiveBackend(): LiveBackend {
  return {
    async attach(profileDir, cancelled) {
      const pw = playwrightCore();
      if (!pw) return null; // no playwright-core: nothing to attach with
      let failures = 0;
      while (!cancelled()) {
        const endpoint = cdpEndpoint(profileDir);
        if (endpoint) {
          try {
            const browser = await pw.chromium.connectOverCDP(endpoint);
            return cdpConnection(browser);
          } catch {
            // The port file can appear a moment before Chrome accepts connections, or the browser just went away.
            if (++failures > 5) throw new Error('could not attach to the test browser');
          }
        }
        await delay(ATTACH_POLL_MS);
      }
      return null;
    },
  };
}

/** A read-only CDP connection to the MCP's browser: screencast whichever page it is driving, following new tabs. */
function cdpConnection(browser: import('playwright-core').Browser): LiveConnection {
  const context = () => browser.contexts()[0] ?? null;
  let cdp: import('playwright-core').CDPSession | null = null;
  let frameCb: ((f: LiveFrame) => void) | null = null;
  let urlCb: ((url: string) => void) | null = null;
  let page: import('playwright-core').Page | null = null;
  let closed = false;

  const stopCurrent = async () => {
    if (!cdp) return;
    const s = cdp;
    cdp = null;
    await s.send('Page.stopScreencast').catch(() => undefined);
    await s.detach().catch(() => undefined);
  };

  const startPage = async (next: import('playwright-core').Page) => {
    if (closed || !next || next.isClosed()) return;
    await stopCurrent();
    page = next;
    try {
      const session = await next.context().newCDPSession(next);
      if (closed) {
        await session.detach().catch(() => undefined);
        return;
      }
      cdp = session;
      session.on('Page.screencastFrame', (frame) => {
        // Acknowledge every frame or Chrome stops sending; read-only otherwise (never forwards input).
        void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
        const url = (frame.metadata as { url?: string } | undefined)?.url;
        if (url) urlCb?.(url);
        frameCb?.({ data: frame.data, mime: 'image/jpeg', at: Date.now() });
      });
      await session.send('Page.startScreencast', screencastParams());
      urlCb?.(next.url());
    } catch {
      // The page closed while starting: the next `page` event or the close path settles it.
    }
  };

  return {
    url: () => page?.url() ?? null,
    async stream(onFrame, onUrl) {
      frameCb = onFrame;
      urlCb = onUrl;
      const ctx = context();
      if (!ctx) return async () => undefined;
      ctx.on('page', (p) => void startPage(p));
      const pages = ctx.pages().filter((p) => !p.isClosed());
      if (pages.length) await startPage(pages[pages.length - 1]);
      else {
        // No page yet: the MCP creates one on the agent's first navigation. Wait briefly, the hub's viewers keep waiting.
        const wait = new Promise<void>((resolve) => {
          const done = () => resolve();
          ctx.once('page', done);
          setTimeout(done, 15_000);
        });
        await wait;
        const now = context()?.pages().filter((p) => !p.isClosed()) ?? [];
        if (now.length) await startPage(now[now.length - 1]);
      }
      return async () => {
        frameCb = null;
        urlCb = null;
        await stopCurrent();
      };
    },
    async close() {
      closed = true;
      frameCb = null;
      urlCb = null;
      await stopCurrent();
      await browser.close().catch(() => undefined); // disconnects this client; leaves the agent's browser running
    },
  };
}

// ---------- the per-agent capture ----------

interface CaptureOpts {
  demo: boolean;
  profileDir?: string;
  /** The agent's name, for the demo's synthetic page. */
  label?: string;
}

class LiveCapture {
  status: LivePlaytestStatus;
  url: string | null = null;
  private readonly viewers = new Set<LiveSink>();
  private latest: LiveFrame | null = null;
  private lastFrameAt = 0;
  private connection: LiveConnection | null = null;
  private dropStream: (() => void) | null = null;
  private attaching: Promise<void> | null = null;
  private cancelled = false;
  private ended = false;
  private endedTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly agentId: string,
    readonly session: number,
    private opts: CaptureOpts,
    private backend: LiveBackend,
    private changed: (status: LivePlaytestStatus) => void,
  ) {
    this.status = opts.demo ? 'live' : 'waiting';
  }

  /** What a fresh viewer gets first: the standing state and, if there is one, the latest frame. */
  private stateMessage(): LiveServerMessage {
    return { t: 'state', status: this.status, url: this.url, session: this.session };
  }

  addViewer(sink: LiveSink) {
    this.viewers.add(sink);
    this.push(sink, this.stateMessage());
    if (this.latest) this.push(sink, { t: 'frame', ...this.latest, session: this.session });
    void this.ensure();
  }

  removeViewer(sink: LiveSink) {
    this.viewers.delete(sink);
    if (!this.viewers.size) void this.stopCapture();
  }

  get viewerCount() {
    return this.viewers.size;
  }

  /** Every sink watching right now, so a capture replacing this one (a new task on the same agent) can inherit them. */
  sinks(): LiveSink[] {
    return [...this.viewers];
  }

  /** Stop without telling the viewers: this capture is being replaced by a fresh one for the same agent. */
  release() {
    this.cancelled = true;
    this.ended = true;
    if (this.endedTimer) clearTimeout(this.endedTimer);
    this.endedTimer = null;
    void this.teardownConnection();
    this.viewers.clear();
  }

  /** Demand-driven: only attach while someone is watching, and only while the session hasn't ended. */
  private async ensure() {
    if (this.ended || this.cancelled || this.connection || this.attaching || !this.viewers.size) return;
    const backend = this.backend;
    this.attaching = (async () => {
      try {
        const connection = this.opts.demo ? (backend.fake?.(this.opts.label) ?? null) : this.opts.profileDir ? await backend.attach(this.opts.profileDir, () => this.cancelled || !this.viewers.size) : null;
        if (this.cancelled || this.ended || !this.viewers.size) {
          await connection?.close().catch(() => undefined);
          return;
        }
        if (!connection) {
          this.setStatus('unavailable');
          return;
        }
        this.connection = connection;
        this.dropStream = await connection.stream(
          (f) => this.onFrame(f),
          (url) => {
            if (this.url === url) return; // the page repainted; only a real navigation is a state change
            this.url = url;
            this.sendAll(this.stateMessage());
          },
        );
        if (this.ended || this.cancelled || !this.viewers.size) {
          await this.teardownConnection();
          return;
        }
        this.setStatus('live');
      } catch {
        this.setStatus(this.ended ? 'ended' : 'unavailable');
      } finally {
        this.attaching = null;
      }
    })();
    await this.attaching;
  }

  private onFrame(f: LiveFrame) {
    const now = Date.now();
    if (f.data.length * 0.75 > LIVE_MAX_FRAME_BYTES) return; // too big to push; keep whatever we had
    if (!frameDue(this.lastFrameAt, now)) return;
    this.lastFrameAt = now;
    this.latest = f;
    const msg: LiveServerMessage = { t: 'frame', ...f, session: this.session };
    for (const sink of this.viewers) {
      if (this.congested(sink)) continue; // slow viewer: the next frame it can take is the latest one
      this.push(sink, msg);
    }
  }

  private congested(sink: LiveSink) {
    return sink.readyState !== sink.OPEN || sink.bufferedAmount > LIVE_STALE_BYTES;
  }

  /** The viewer left or is finished: stop the screencast. The agent's browser itself is untouched. */
  private async stopCapture() {
    this.cancelled = true;
    await this.teardownConnection();
    this.cancelled = false;
    if (!this.ended) this.setStatus('waiting');
  }

  private async teardownConnection() {
    const drop = this.dropStream;
    const connection = this.connection;
    this.dropStream = null;
    this.connection = null;
    try {
      await drop?.();
    } catch {
      // the stream is already gone
    }
    await connection?.close().catch(() => undefined);
  }

  /** The session finished: keep the last frame for a while, labelled as ended, then forget it. */
  end() {
    if (this.ended) return;
    this.ended = true;
    this.cancelled = true;
    this.setStatus('ended');
    void this.teardownConnection();
    this.endedTimer = setTimeout(() => this.forget(), LIVE_ENDED_KEEP_MS);
  }

  private forget() {
    if (this.endedTimer) clearTimeout(this.endedTimer);
    this.endedTimer = null;
    this.latest = null;
    this.connection = null;
    this.dropStream = null;
    this.viewers.clear();
    this.setStatus('off'); // the kept frame is gone: nothing left to watch
  }

  /** The office is stopping, or the agent is gone: close now, no lingering frame or timer. */
  dispose() {
    this.cancelled = true;
    this.ended = true;
    if (this.endedTimer) clearTimeout(this.endedTimer);
    this.endedTimer = null;
    void this.teardownConnection();
    for (const sink of this.viewers) this.push(sink, { t: 'state', status: 'off', url: this.url, session: this.session });
    this.viewers.clear();
  }

  private setStatus(status: LivePlaytestStatus) {
    if (this.status === status) return;
    this.status = status;
    this.sendAll(this.stateMessage());
    this.changed(status);
  }

  private sendAll(msg: LiveServerMessage) {
    for (const sink of this.viewers) this.push(sink, msg);
  }

  private push(sink: LiveSink, msg: LiveServerMessage) {
    if (sink.readyState !== sink.OPEN) return;
    sink.send(JSON.stringify(msg));
  }
}

/** The office's live playtests: one capture per agent, shared by every viewer, torn down when nobody watches. */
export class LiveCaptureHub {
  private captures = new Map<string, LiveCapture>();
  private viewers = new Map<string, Set<LiveSink>>();
  private seq = 1;

  constructor(
    private backend: LiveBackend,
    /** Told when an agent's watchability changes, so the office can show the right tab (never per frame). */
    private onStatus: (agentId: string, status: LivePlaytestStatus) => void = () => undefined,
  ) {}

  /** A browser-testing session started (or, for the demo, a fake one): the agent can now be watched. */
  begin(agentId: string, opts: CaptureOpts) {
    this.captures.get(agentId)?.release(); // a fresh task: no frame from the last one may show as live
    const capture = new LiveCapture(agentId, this.seq++, opts, this.backend, (s) => this.onStatus(agentId, s));
    this.captures.set(agentId, capture);
    for (const sink of this.viewers.get(agentId) ?? []) capture.addViewer(sink);
    this.onStatus(agentId, capture.status);
  }

  /** The session finished. Keeps the last frame briefly, labelled as ended. */
  end(agentId: string) {
    this.captures.get(agentId)?.end();
  }

  /** The agent left, or the office is stopping: forget it entirely and tell any viewer it's off. */
  drop(agentId: string) {
    this.captures.get(agentId)?.dispose();
    this.captures.delete(agentId);
    this.viewers.delete(agentId);
  }

  status(agentId: string): LivePlaytestStatus {
    return this.captures.get(agentId)?.status ?? 'off';
  }

  /** Watch one agent's browser. Returns the unsubscribe. A late viewer still gets the last frame of an ended session. */
  watch(agentId: string, sink: LiveSink): () => void {
    let set = this.viewers.get(agentId);
    if (!set) {
      set = new Set();
      this.viewers.set(agentId, set);
    }
    set.add(sink);
    const capture = this.captures.get(agentId);
    if (capture) capture.addViewer(sink);
    else sink.send(JSON.stringify({ t: 'state', status: 'off', url: null, session: 0 } satisfies LiveServerMessage));
    return () => {
      set!.delete(sink);
      if (!set!.size) this.viewers.delete(agentId);
      this.captures.get(agentId)?.removeViewer(sink);
    };
  }

  /** Number of live captures and viewers, for tests and the benchmark. */
  stats() {
    let viewers = 0;
    for (const set of this.viewers.values()) viewers += set.size;
    return { captures: this.captures.size, viewers };
  }

  stopAll() {
    for (const capture of this.captures.values()) capture.dispose();
    this.captures.clear();
    this.viewers.clear();
  }
}

// ---------- the demo's fake browser ----------

const DEMO_PAGES = ['/dashboard', '/settings/profile', '/checkout', '/dashboard?tab=reports'];
const DEMO_HUES = [210, 150, 20, 285];

/** A made-up test page as SVG: a page that visibly moves and navigates, so the demo shows a live playtest. */
export function demoSvgFrame(tick: number, name: string): { data: string; mime: string; url: string } {
  const page = DEMO_PAGES[Math.floor(tick / 8) % DEMO_PAGES.length];
  const hue = DEMO_HUES[Math.floor(tick / 8) % DEMO_HUES.length];
  const url = `http://localhost:5173${page}`;
  const x = 40 + ((tick * 9) % 520);
  const y = 150 + Math.round(Math.sin(tick / 6) * 40);
  const safe = (s: string) => s.replace(/[<>&"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <rect width="640" height="400" fill="hsl(${hue},45%,96%)"/>
  <rect width="640" height="44" fill="hsl(${hue},60%,50%)"/>
  <circle cx="22" cy="22" r="7" fill="#fff"/><circle cx="44" cy="22" r="7" fill="#fff" opacity="0.6"/>
  <text x="620" y="29" text-anchor="end" font-family="Segoe UI, Arial" font-size="14" fill="#fff">${safe(url)}</text>
  <text x="24" y="86" font-family="Segoe UI, Arial" font-size="20" font-weight="700" fill="hsl(${hue},45%,30%)">${safe(name)}'s live playtest</text>
  <rect x="24" y="104" width="592" height="272" rx="12" fill="#fff" stroke="hsl(${hue},40%,84%)"/>
  <circle cx="${x}" cy="${y}" r="24" fill="hsl(${hue},70%,55%)"/>
  <rect x="24" y="${y + 44}" width="${120 + ((tick * 5) % 380)}" height="14" rx="7" fill="hsl(${hue},35%,80%)"/>
  <text x="320" y="360" text-anchor="middle" font-family="Segoe UI, Arial" font-size="13" fill="hsl(${hue},30%,45%)">frame ${tick} · this is the demo, with no real browser</text>
</svg>`;
  return { data: Buffer.from(svg).toString('base64'), mime: 'image/svg+xml', url };
}

/** The demo backend: a synthetic page that animates while it's watched, with no Chrome and no cost. */
export function demoLiveBackend(): LiveBackend {
  return {
    fake: (name = 'demo') => {
      let timer: NodeJS.Timeout | null = null;
      return {
        url: () => 'http://localhost:5173/dashboard',
        async stream(onFrame, onUrl) {
          let tick = 0;
          timer = setInterval(() => {
            tick += 1;
            const f = demoSvgFrame(tick, name);
            onUrl(f.url);
            onFrame({ data: f.data, mime: f.mime, at: Date.now() });
          }, 140);
          const first = demoSvgFrame(0, name);
          onUrl(first.url);
          onFrame({ data: first.data, mime: first.mime, at: Date.now() });
          return async () => {
            if (timer) clearInterval(timer);
            timer = null;
          };
        },
        async close() {
          if (timer) clearInterval(timer);
          timer = null;
        },
      };
    },
    attach: async () => null,
  };
}
