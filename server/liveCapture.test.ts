import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cdpEndpoint,
  demoLiveBackend,
  devToolsPort,
  demoSvgFrame,
  frameDue,
  LIVE_STALE_BYTES,
  LiveCaptureHub,
  screencastParams,
  type LiveConnection,
  type LiveFrame,
  type LiveSink,
} from './liveCapture.ts';

// Watching a session's own browser live (#16), tested without Chrome: a fake backend stands in for the CDP attach, so
// the demand-driven lifecycle (subscribe, share, backpressure, task restart, teardown) is covered offline.

const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeSink implements LiveSink {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  messages: { t: string; [k: string]: unknown }[] = [];
  send(data: string) {
    this.messages.push(JSON.parse(data) as { t: string });
  }
  frames() {
    return this.messages.filter((m) => m.t === 'frame');
  }
  states() {
    return this.messages.filter((m) => m.t === 'state');
  }
}

/** A backend whose connection is controllable: frames are pushed by the test, attach can resolve or fail. */
function fakeBackend() {
  let emit: ((f: LiveFrame) => void) | null = null;
  let notifyUrl: ((url: string) => void) | null = null;
  const calls = { attaches: 0, streams: 0, stopped: 0, closed: 0 };
  let mode: 'ok' | 'none' | 'reject' = 'ok';
  const connection: LiveConnection = {
    url: () => 'http://localhost:5173/dashboard',
    async stream(onFrame, onUrl) {
      calls.streams += 1;
      emit = onFrame;
      notifyUrl = onUrl;
      onUrl('http://localhost:5173/dashboard');
      return () => {
        calls.stopped += 1;
        emit = null;
        notifyUrl = null;
      };
    },
    async close() {
      calls.closed += 1;
    },
  };
  return {
    calls,
    connection,
    setMode(m: 'ok' | 'none' | 'reject') {
      mode = m;
    },
    push(f: Partial<LiveFrame> = {}) {
      emit?.({ data: 'AA==', mime: 'image/png', at: Date.now(), ...f });
    },
    pushUrl(url: string) {
      notifyUrl?.(url);
    },
    backend: {
      async attach() {
        calls.attaches += 1;
        if (mode === 'reject') throw new Error('no browser');
        if (mode === 'none') return null;
        return connection;
      },
    },
  };
}

describe('live capture profiles', () => {
  it('reads the CDP port Chrome writes, and nothing when there is no browser yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-profile-'));
    expect(devToolsPort(dir)).toBeNull();
    expect(cdpEndpoint(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '57321\n/devtools/browser/abc\n');
    expect(devToolsPort(dir)).toBe(57321);
    expect(cdpEndpoint(dir)).toBe('http://127.0.0.1:57321');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('caps the screencast and rate', () => {
    const p = screencastParams();
    expect(p.format).toBe('jpeg');
    expect(p.maxWidth).toBe(1280);
    expect(p.quality).toBeLessThanOrEqual(60);
    expect(frameDue(1000, 1000)).toBe(false);
    expect(frameDue(1000, 1000 + 1000)).toBe(true);
  });
});

describe('the live capture hub', () => {
  it('starts no capture until someone watches, and shares one capture between viewers', async () => {
    const fake = fakeBackend();
    const hub = new LiveCaptureHub(fake.backend);
    hub.begin('ada', { demo: false, profileDir: 'p' });
    expect(fake.calls.attaches).toBe(0);

    const a = new FakeSink();
    const b = new FakeSink();
    const stopA = hub.watch('ada', a);
    await tick();
    expect(fake.calls.attaches).toBe(1);
    expect(fake.calls.streams).toBe(1);

    const stopB = hub.watch('ada', b);
    await tick();
    expect(fake.calls.attaches).toBe(1); // a second viewer shares the same capture
    expect(hub.stats()).toEqual({ captures: 1, viewers: 2 });

    stopA();
    await tick();
    expect(fake.calls.stopped).toBe(0); // the other viewer keeps it alive
    expect(hub.stats().viewers).toBe(1);

    stopB();
    await tick();
    expect(fake.calls.stopped).toBe(1);
    expect(fake.calls.closed).toBe(1);
  });

  it('stops the screencast when the last viewer leaves, and pushes the latest frame to late viewers', async () => {
    const fake = fakeBackend();
    const hub = new LiveCaptureHub(fake.backend);
    hub.begin('ada', { demo: false, profileDir: 'p' });
    const sink = new FakeSink();
    const stop = hub.watch('ada', sink);
    await tick();
    fake.push();
    expect(sink.frames()).toHaveLength(1);
    expect(sink.states().at(-1)).toMatchObject({ t: 'state', status: 'live' });

    stop();
    await tick();
    expect(fake.calls.stopped).toBe(1);
    expect(fake.calls.closed).toBe(1);
    expect(hub.status('ada')).toBe('waiting');

    // A viewer joining after capture stopped still gets the last frame, without a new attach until it watches.
    const sink2 = new FakeSink();
    const stop2 = hub.watch('ada', sink2);
    expect(sink2.frames()).toHaveLength(1);
    await tick();
    expect(fake.calls.attaches).toBe(2); // watching again re-attaches
    stop2();
  });

  it('never queues frames to a slow viewer: bounded latest, dropped while congested', async () => {
    const fake = fakeBackend();
    const hub = new LiveCaptureHub(fake.backend);
    hub.begin('ada', { demo: false, profileDir: 'p' });
    const sink = new FakeSink();
    hub.watch('ada', sink);
    await tick();
    sink.bufferedAmount = LIVE_STALE_BYTES + 1; // slow
    fake.push();
    expect(sink.frames()).toHaveLength(0);
    sink.bufferedAmount = 0; // drained: the next latest frame goes out
    await new Promise((r) => setTimeout(r, 110)); // past the frame-rate cap
    fake.push();
    expect(sink.frames()).toHaveLength(1);
  });

  it('marks an attach that finds nothing as unavailable', async () => {
    const fake = fakeBackend();
    fake.setMode('none');
    const hub = new LiveCaptureHub(fake.backend);
    hub.begin('ada', { demo: false, profileDir: 'p' });
    const sink = new FakeSink();
    hub.watch('ada', sink);
    await tick();
    expect(hub.status('ada')).toBe('unavailable');
    expect(sink.states().at(-1)).toMatchObject({ status: 'unavailable' });
  });

  it('moves watchers to a fresh capture on a new task, with a new session id and no stale frame', async () => {
    const fake = fakeBackend();
    const hub = new LiveCaptureHub(fake.backend);
    hub.begin('ada', { demo: false, profileDir: 'p' });
    const sink = new FakeSink();
    const stop = hub.watch('ada', sink);
    await tick();
    fake.push();
    const firstSession = (sink.states().at(-1)?.session as number) ?? 0;
    expect(sink.frames()).toHaveLength(1);

    hub.begin('ada', { demo: false, profileDir: 'p' }); // the agent picks up new work
    await tick();
    const last = sink.states().at(-1)!;
    expect(last.t).toBe('state');
    expect(last.session).not.toBe(firstSession); // a new session, so the client drops the old frame
    expect(fake.calls.stopped).toBeGreaterThanOrEqual(1); // the old capture let go of its stream
    stop();
  });

  it('keeps the last frame at end, labelled as ended, and cleans up on drop and stopAll', async () => {
    const fake = fakeBackend();
    const hub = new LiveCaptureHub(fake.backend);
    hub.begin('ada', { demo: false, profileDir: 'p' });
    const sink = new FakeSink();
    hub.watch('ada', sink);
    await tick();
    fake.push();
    hub.end('ada');
    await tick();
    expect(sink.states().at(-1)).toMatchObject({ status: 'ended' });
    expect(sink.frames()).toHaveLength(1); // the last frame stays
    expect(hub.status('ada')).toBe('ended');

    // A viewer arriving after the end still sees the frame, labelled ended.
    const late = new FakeSink();
    hub.watch('ada', late);
    expect(late.states().at(-1)).toMatchObject({ status: 'ended' });
    expect(late.frames()).toHaveLength(1);

    hub.drop('ada');
    expect(hub.status('ada')).toBe('off');
    expect(hub.stats()).toEqual({ captures: 0, viewers: 0 });
    expect(fake.calls.closed).toBeGreaterThanOrEqual(1);

    hub.begin('grace', { demo: false, profileDir: 'p' });
    const graceSink = new FakeSink();
    hub.watch('grace', graceSink);
    await tick();
    hub.stopAll();
    expect(hub.stats()).toEqual({ captures: 0, viewers: 0 });
  });
});

describe('the demo live source', () => {
  it('animates and navigates on its own, with no Chrome', async () => {
    const conn = demoLiveBackend().fake!('Ada');
    const frames: LiveFrame[] = [];
    const urls = new Set<string>();
    const stop = await conn.stream((f) => frames.push(f), (u) => urls.add(u));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].mime).toBe('image/svg+xml');
    expect(Buffer.from(frames[0].data, 'base64').toString()).toContain("Ada's live playtest");
    await new Promise((r) => setTimeout(r, 420));
    expect(frames.length).toBeGreaterThanOrEqual(3); // visibly moves
    expect(urls.size).toBeGreaterThanOrEqual(1);
    stop();
  });

  it('draws a moving marker and a cycling URL', () => {
    const a = demoSvgFrame(0, 'Ada');
    const b = demoSvgFrame(8, 'Ada');
    expect(a.url).not.toBe(b.url);
    expect(a.data).not.toBe(b.data);
  });
});

describe('the hub notifies only on status changes', () => {
  it('reports each agent status once', async () => {
    const fake = fakeBackend();
    const seen: string[] = [];
    const hub = new LiveCaptureHub(fake.backend, (id, s) => seen.push(`${id}:${s}`));
    hub.begin('ada', { demo: false, profileDir: 'p' });
    const sink = new FakeSink();
    const stop = hub.watch('ada', sink);
    await tick();
    expect(seen).toEqual(['ada:waiting', 'ada:live']);
    stop();
  });
});
