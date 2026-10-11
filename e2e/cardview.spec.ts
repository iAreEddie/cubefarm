import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// The whiteboard card window (CardView.tsx): a long issue/PR description is readable from its first line to its last in
// the panel's own scroll region, on desktop and on a narrow phone viewport, and the close control stays reachable.

const FLOOR = 1;
// Where the demo's floor-1 whiteboard is, so that floor (and its board) is the active one.
const SPOT: SavedView = { floor: FLOOR, x: 0, z: -7, yaw: 0, pitch: 0.15 };

type Board = { open: (key: string) => boolean; cards: () => { key: string }[] };
// Methods can't cross the page boundary: call them inside evaluate.
const openCard = (page: Page, key: string) => page.evaluate((k) => (window as unknown as { __swarmBoard: Board }).__swarmBoard.open(k), key);
const boardCards = (page: Page) => page.evaluate(() => (window as unknown as { __swarmBoard: Board }).__swarmBoard.cards());

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

/** A Markdown description several screens long: prose, a list, a link, and a code line too long for a phone. */
function longBody(marker: string): string {
  const lines: string[] = [`# Overview ${marker}`, '', `START-${marker}`, ''];
  for (let i = 1; i <= 30; i++) lines.push(`Paragraph ${i}: ${'lorem ipsum dolor sit amet '.repeat(4)}`);
  lines.push('', '## Checklist', '', '- first item', '- second item', '- a [link](https://example.com)', '- inline `code`');
  lines.push('', '## Code', '', '```ts', `const veryLongLine = '${'x'.repeat(160)}';`, '```');
  lines.push('', '## End', '', `END-${marker}`);
  return lines.join('\n');
}

/** File a fresh issue with a long body, then open its card window (retrying until the client has the new card). */
async function openLongCard(page: Page, request: APIRequestContext, repo: string, marker: string) {
  const res = await request.post(`/api/repos/${encodeURIComponent(repo)}/issues`, { data: { title: `Long description ${marker}`, body: longBody(marker) } });
  expect(res.ok(), await res.text()).toBe(true);
  const { number } = (await res.json()) as { number: number };
  await expect.poll(() => openCard(page, `i-${number}`), { message: `open card i-${number}`, timeout: 30_000 }).toBe(true);
  await expect(page.locator('.cardview')).toBeVisible();
  return number;
}

async function repoOfFloor(page: Page) {
  const { repos } = (await (await page.request.get('/api/state')).json()) as { repos: { id: string; floor: number }[] };
  return repos.find((r) => r.floor === FLOOR)!.id;
}

let seq = 0;
const marker = () => `m${Date.now()}${seq++}`;

test('a long card description scrolls from its first line to its last, and closes', async ({ page }) => {
  await startAt(page, SPOT);
  await enterOffice(page);
  const repo = await repoOfFloor(page);
  const first = marker();
  const number = await openLongCard(page, page.request, repo, first);

  const panel = page.locator('.cardview');
  const body = page.locator('.cardview .panel-body');
  // The full description is in the window (not the old 600-char excerpt), so its last marker is in the DOM.
  await expect(page.getByText(`END-${first}`)).toHaveCount(1);
  await expectInScroll(page, `START-${first}`, body);

  // It is taller than the scroll region: reading it all takes scrolling.
  const size = await body.evaluate((el) => ({ top: el.scrollTop, scroll: el.scrollHeight, client: el.clientHeight }));
  expect(size.scroll).toBeGreaterThan(size.client);
  expect(size.top).toBe(0);

  // The scroll region has focus, so the keyboard scrolls it (End moves it), then jump to the last line to read it.
  await body.press('End');
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await toEnd(body);
  await expectInScroll(page, `END-${first}`, body);

  // The mouse wheel scrolls it too, and the close control and the card's own link stay usable after scrolling.
  await body.evaluate((el) => (el.scrollTop = 0));
  const box = (await body.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await toEnd(body);
  await expectInScroll(page, `END-${first}`, body);
  await expect(panel.locator('.panel-x')).toBeVisible();
  const link = page.getByRole('link', { name: new RegExp(`Open #${number} on GitHub`) });
  const [linkBox, bodyBox] = await Promise.all([link.boundingBox(), body.boundingBox()]);
  expect(linkBox!.y + linkBox!.height).toBeLessThanOrEqual(bodyBox!.y + bodyBox!.height + 1);

  // Opening another card shows its own description, not the last one's.
  const second = marker();
  await openLongCard(page, page.request, repo, second);
  await expectInScroll(page, `START-${second}`, body);
  await expect(page.getByText(`END-${first}`)).toHaveCount(0);

  // Escape closes the window (the close button is checked above).
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // If the demo already has an open PR, its card window works the same way.
  const pr = (await boardCards(page)).find((c) => c.key.startsWith('pr-'));
  if (pr) {
    await expect.poll(() => openCard(page, pr.key), { message: `open ${pr.key}`, timeout: 30_000 }).toBe(true);
    await expect(panel).toBeVisible();
    await expect(panel.locator('.panel-title')).toContainText('PR');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  }
});

test('a long card description fits a narrow phone viewport and scrolls there too', async ({ page }) => {
  // A phone-sized screen would pick pocket mode: keep the 3D office, whose card window this is.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'office'));
  await startAt(page, SPOT);
  await enterOffice(page);
  const repo = await repoOfFloor(page);
  const m = marker();
  await openLongCard(page, page.request, repo, m);

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

  // The whole description still reads, first line to last. The keyboard scrolls the region, then jump to the end.
  await expectInScroll(page, `START-${m}`, body);
  await body.press('End');
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await toEnd(body);
  await expectInScroll(page, `END-${m}`, body);
  await body.evaluate((el) => (el.scrollTop = 0));
  await expect(panel.locator('.panel-x')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});
