import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// The whiteboard card window (CardView.tsx): a full issue or pull request description reads from its first line to
// its last in the panel's own scroll region, on desktop and on a phone, with the window inside the viewport and the
// close control and actions reachable. A PR card shows the PR's own body, not the issue it closes; pocket mode opens
// the same window from its Kanban cards (#25).

const FLOOR = 2; // the demo's weather-api floor, where the deterministic PR fixtures live (server/demo.ts)
// Where the demo's floor-2 whiteboard is, so that floor (and its board) is the active one.
const SPOT: SavedView = { floor: FLOOR, x: 0, z: -7, yaw: 0, pitch: 0.15 };

type Pull = { number: number; title: string; body: string; closesIssues: number[]; state: string };
type Issue = { number: number; title: string; body: string };
type StateRepo = { id: string; floor: number; issues: Issue[]; pulls: Pull[] };
type Board = { open: (key: string) => boolean };
// Methods can't cross the page boundary: call them inside evaluate.
const openCard = (page: Page, key: string) => page.evaluate((k) => (window as unknown as { __swarmBoard: Board }).__swarmBoard.open(k), key);

/** Scrolls the region to its very bottom (deterministic, unlike key-repeat timing). */
const toEnd = (body: Locator) => body.evaluate((el) => (el.scrollTop = el.scrollHeight));

/** The line is not just in the DOM: it's inside the scroll region's visible box. */
async function expectInScroll(page: Page, text: string, body: Locator) {
  const line = page.getByText(text, { exact: true });
  await expect(line).toBeVisible();
  const [l, b] = await Promise.all([line.boundingBox(), body.boundingBox()]);
  expect(l!.y).toBeGreaterThanOrEqual(b!.y - 1);
  expect(l!.y + l!.height).toBeLessThanOrEqual(b!.y + b!.height + 1);
}

/** A wheel swipe on an element, as the old test did. */
async function wheel(page: Page, box: { x: number; y: number; width: number; height: number }) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 1500);
}

/** A real touch swipe up inside the region (CDP, so the browser scrolls it as a finger would). */
async function swipeUp(page: Page, box: { x: number; y: number; width: number; height: number }) {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.75;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 28 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
}

/** A Markdown issue description several screens long: prose, a list, a link, and a code line too long for a phone. */
function longIssueBody(marker: string): string {
  const lines: string[] = [`# Overview ${marker}`, '', `START-${marker}`, ''];
  for (let i = 1; i <= 30; i++) lines.push(`Paragraph ${i}: ${'lorem ipsum dolor sit amet '.repeat(4)}`);
  lines.push('', '## Checklist', '', '- first item', '- second item', '- a [link](https://example.com)', '- inline `code`');
  lines.push('', '## Code', '', '```ts', `const veryLongLine = '${'x'.repeat(160)}';`, '```');
  lines.push('', '## End', '', `END-${marker}`);
  return lines.join('\n');
}

async function state(page: Page) {
  const { repos } = (await (await page.request.get('/api/state')).json()) as { repos: StateRepo[] };
  const repo = repos.find((r) => r.floor === FLOOR)!;
  return { repo, ...fixtures(repo) };
}

/** The demo's deterministic floor-2 PRs: A and C are long and close an issue, B closes nothing, D has no body. */
function fixtures(repo: StateRepo) {
  const open = repo.pulls.filter((p) => p.state === 'OPEN');
  return {
    prA: open.find((p) => p.body.includes('START-PR-A'))!,
    prB: open.find((p) => p.closesIssues.length === 0)!,
    prC: open.find((p) => p.body.includes('START-PR-C'))!,
    prD: open.find((p) => p.closesIssues.length > 0 && p.body.trim() === '')!,
  };
}

/** File a fresh issue with a long body, then open its card window (retrying until the client has the new card). */
async function openLongIssue(page: Page, request: APIRequestContext, repoId: string, marker: string) {
  const res = await request.post(`/api/repos/${encodeURIComponent(repoId)}/issues`, { data: { title: `Long description ${marker}`, body: longIssueBody(marker) } });
  expect(res.ok(), await res.text()).toBe(true);
  const { number } = (await res.json()) as { number: number };
  await expect.poll(() => openCard(page, `i-${number}`), { message: `open card i-${number}`, timeout: 30_000 }).toBe(true);
  await expect(page.locator('.cardview')).toBeVisible();
  return number;
}

let seq = 0;
const marker = () => `m${Date.now()}${seq++}`;

test('a long issue and PR description scroll first line to last, and the card switches, closes and returns focus', async ({ page }) => {
  await startAt(page, SPOT);
  await enterOffice(page);
  const { repo, prA, prB, prC, prD } = await state(page);
  const panel = page.locator('.cardview');
  const body = page.locator('.cardview .panel-body');

  // --- An issue card: the whole long body is in the window and reads by keyboard and wheel. ---
  const m = marker();
  await openLongIssue(page, page.request, repo.id, m);
  await expect(page.getByText(`END-${m}`)).toHaveCount(1);
  await expectInScroll(page, `START-${m}`, body);
  const size = await body.evaluate((el) => ({ top: el.scrollTop, scroll: el.scrollHeight, client: el.clientHeight }));
  expect(size.scroll).toBeGreaterThan(size.client);
  expect(size.top).toBe(0); // a fresh card starts at the top
  await body.press('End');
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await toEnd(body);
  await expectInScroll(page, `END-${m}`, body);
  await body.evaluate((el) => (el.scrollTop = 0));
  await wheel(page, (await body.boundingBox())!);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // --- A PR card: the PR's own long body, not its linked issue's. ---
  await expect.poll(() => openCard(page, `pr-${prA.number}`), { message: `open pr-${prA.number}`, timeout: 30_000 }).toBe(true);
  await expect(panel).toBeVisible();
  await expect(page.getByText('START-PR-A')).toHaveCount(1);
  await expectInScroll(page, 'START-PR-A', body);
  const linkedIssue = repo.issues.find((i) => i.number === prA.closesIssues[0])!;
  await expect(page.getByText(linkedIssue.body.trim())).toHaveCount(0); // the issue's body is not shown
  await expect(panel.locator('.cardview-h', { hasText: `Closes #${linkedIssue.number}` })).toBeVisible();

  // The full body reads: taller than the region, keyboard End moves it, then jump to the last line.
  const prSize = await body.evaluate((el) => ({ top: el.scrollTop, scroll: el.scrollHeight, client: el.clientHeight }));
  expect(prSize.scroll).toBeGreaterThan(prSize.client);
  expect(prSize.top).toBe(0);
  await body.press('End');
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await toEnd(body);
  await expectInScroll(page, 'END-PR-A', body);
  await body.evaluate((el) => (el.scrollTop = 0));
  await wheel(page, (await body.boundingBox())!);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // The close control and the card's own GitHub link stay reachable after scrolling to the footer.
  await toEnd(body);
  await expect(panel.locator('.panel-x')).toBeVisible();
  const link = page.getByRole('link', { name: new RegExp(`Open PR #${prA.number} on GitHub`) });
  await expect(link).toBeVisible();
  const [lb, rb] = await Promise.all([link.boundingBox(), body.boundingBox()]);
  expect(lb!.y + lb!.height).toBeLessThanOrEqual(rb!.y + rb!.height + 1);

  // --- A PR with no linked issue still shows its description. ---
  await expect.poll(() => openCard(page, `pr-${prB.number}`), { message: `open pr-${prB.number}`, timeout: 30_000 }).toBe(true);
  await expect(page.getByText(/closes no issue at all/)).toBeVisible();
  await expect(panel.locator('.cardview-h', { hasText: 'Closes #' })).toHaveCount(0);

  // --- A linked PR with an empty body says so; it never falls back to the linked issue's body. ---
  await expect.poll(() => openCard(page, `pr-${prD.number}`), { message: `open pr-${prD.number}`, timeout: 30_000 }).toBe(true);
  await expect(page.getByText('This pull request has no description.')).toBeVisible();
  const linkedD = repo.issues.find((i) => i.number === prD.closesIssues[0])!;
  await expect(page.getByText(linkedD.body.trim())).toHaveCount(0); // the linked issue's body is not shown
  await expect(panel.locator('.cardview-h', { hasText: `Closes #${linkedD.number}` })).toBeVisible();

  // --- Switching to another tall PR shows its own description and starts at the top, not the last offset. ---
  await expect.poll(() => openCard(page, `pr-${prC.number}`), { message: `open pr-${prC.number}`, timeout: 30_000 }).toBe(true);
  await expect(page.getByText('START-PR-C')).toHaveCount(1);
  await expect(page.getByText('START-PR-A')).toHaveCount(0);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
  await toEnd(body);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await expect.poll(() => openCard(page, `pr-${prA.number}`), { message: `open pr-${prA.number} again`, timeout: 30_000 }).toBe(true);
  await expect(page.getByText('START-PR-A')).toHaveCount(1);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(0); // a switched card starts at the top

  // The close control is usable, not just visible.
  await panel.locator('.panel-x').click();
  await expect(panel).toBeHidden();
});

test('a long PR description fits a narrow phone viewport and scrolls there (keyboard, wheel and touch)', async ({ page }) => {
  // A phone-sized screen would pick pocket mode: keep the 3D office, whose card window this is.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'office'));
  await startAt(page, SPOT);
  await enterOffice(page);
  const { prA } = await state(page);
  await expect.poll(() => openCard(page, `pr-${prA.number}`), { message: `open pr-${prA.number}`, timeout: 30_000 }).toBe(true);

  const panel = page.locator('.cardview');
  const body = page.locator('.cardview .panel-body');
  const viewport = page.viewportSize()!;
  // The window fits the viewport, including the long code line that would otherwise widen it.
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width + 1);
  const code = (await page.locator('.cardview .md pre').first().boundingBox())!;
  expect(code.x + code.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);

  // The whole description still reads, first line to last.
  await expectInScroll(page, 'START-PR-A', body);
  await body.press('End');
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // A finger swipe scrolls it too (overscroll-behavior keeps the page behind it still).
  await body.evaluate((el) => (el.scrollTop = 0));
  await swipeUp(page, (await body.boundingBox())!);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // And the wheel.
  await body.evaluate((el) => (el.scrollTop = 0));
  await wheel(page, (await body.boundingBox())!);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await toEnd(body);
  await expectInScroll(page, 'END-PR-A', body);
  await expect(panel.locator('.panel-x')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('pocket mode opens a card from its Kanban and reads the PR description, closing with focus back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/?pocket=1');
  await expect(page.locator('.pocket')).toBeVisible();
  const { prA } = await state(page);

  // The Kanban tab, then floor 2 (weather-api), where the card fixtures are.
  await page.locator('.pk-tabs').getByRole('button', { name: /Kanban/ }).click();
  await page.getByRole('tab', { name: /weather-api/ }).click();

  // Pocket has no 3D board: a card's Read button opens the same window.
  const read = page.getByRole('button', { name: new RegExp(`Read PR #${prA.number}: Add a precipitation layer`) });
  await expect(read).toBeVisible();
  await read.click();

  const panel = page.locator('.cardview');
  const body = page.locator('.cardview .panel-body');
  await expect(panel).toBeVisible();
  await expect(page.getByText('START-PR-A')).toHaveCount(1);
  await expectInScroll(page, 'START-PR-A', body);

  // The whole PR description reads in pocket mode too.
  await body.press('End');
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await toEnd(body);
  await expectInScroll(page, 'END-PR-A', body);

  // Escape closes, and focus goes back to the Read button that opened it.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(read).toBeFocused();
});
