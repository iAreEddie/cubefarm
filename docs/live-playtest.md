# Live playtest: watching an agent's own browser (#16)

Clicking an agent's desk screen (or the **🖥️ Live playtest** tab in their panel) shows what the agent's browser is
doing right now: navigation, scrolling, clicks and game motion, without asking the agent to take a screenshot and
without spending a model turn. It is the *same* headless Playwright browser the agent's `mcp__playwright__*` tools
drive — not a second browser and not an app iframe.

## How it attaches to the agent's browser

Each browser-testing session's Playwright MCP still launches and owns its browser. `server/browser.ts`
(`browserWatchingConfig`) adds a small config file to that MCP:

```json
{ "browser": { "isolated": false, "userDataDir": "<session>/browser/browser-profile",
               "launchOptions": { "args": ["--remote-debugging-port=0"] } } }
```

Chrome picks a free port and records it in `<userDataDir>/DevToolsActivePort`. The port is loopback-only and belongs to
that one session's own browser. When someone opens the live view, `server/liveCapture.ts` reads the port, attaches with
`playwright-core`'s `connectOverCDP` (the same copy the pinned MCP uses), and starts a CDP `Page.startScreencast` on the
page the MCP is driving. Only `Page.screencastFrame` is read and acknowledged; no input, focus, pointer lock or pausing
is sent. The office never attaches to a browser it didn't launch for that session, and never exposes the port beyond
127.0.0.1.

The runner tells the swarm the profile folder (`SessionCallbacks.liveBrowser`), so the same mechanism covers the
terminal runtime (Claude Code, Codex, OpenCode) and the Agent SDK runtime.

## Demand-driven, bounded, separate

- A capture attaches **only while someone is watching**. `LiveCaptureHub` keeps one capture per agent shared by every
  viewer; when the last viewer leaves, the tab is hidden or the panel closes, the screencast stops. No watcher means no
  capture, no CDP connection.
- Frames are capped (JPEG, ≤1280×800, quality 55) and rate-limited to `LIVE_MAX_FPS` (10). Only the **latest** frame is
  kept; a viewer whose socket is backed up (`bufferedAmount > 2 MB`) is skipped, never queued. A frame too large is
  dropped.
- Frames travel over their own socket, `/ws/live?agent=<id>`, in `LiveServerMessage`s. They never touch the office's
  snapshot or terminal-log channels (so the 3D office and its state traffic are unaffected).
- The terminal and the intentionally saved QA screenshots stay separate: the **⌨️ Terminal & log** tab keeps the live
  terminal and the *Latest saved Playwright screenshot* pane; the **🖥️ Live playtest** tab is the live feed. QA evidence
  and its report/history are unchanged.

## States a viewer can see

`off` (no browser-testing session) · `waiting` (a session is starting; the browser hasn't been opened yet) · `live` ·
`reconnecting` · `ended` (the last frame stays, clearly labelled "Playtest ended") · `unavailable` (no Chrome, or the
attach failed — the terminal and QA still work). Each capture carries a session id, so after a new task starts the
client drops the previous task's frame instead of showing it as live.

## Demo and limits

`--demo` uses a synthetic source (`demoLiveBackend`): a made-up test page that visibly moves and navigates over the same
socket, with no Chrome and no cost, so the view and its lifecycle can be tried offline.

Measured on the local test machine (Windows, Google Chrome, headless):

- The office's own limit is 10 fps; the demo source animates at ~7 fps (a 140 ms tick), and an end-to-end check of the
  demo office on `/ws/live` saw **9 distinct frames in ~1.2 s (~7.5 fps)**.
- A raw CDP screencast of a simple 2D canvas at 900×600/quality 60 reached **~58 fps** before the 10 fps cap, so a
  moving test scene clears the "≥5 fps" goal with headroom; the first frame arrives within one frame interval and a
  navigation is visible within ~2 s (immediate in practice).
- In headless Chrome, WebGL pages can run on software rendering (SwiftShader), so a heavy 3D scene repaints more slowly;
  the screencast follows the page's own repaint rate, and the fps/resolution caps keep the socket bounded either way.
