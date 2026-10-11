import { MANAGER_DESK } from '../client/src/world/layout';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// The daily upstream check (#14): the Office → Upstream row, and the phone notice it sends.

// In the manager's office, just in front of the desk, looking down at the computer (-Z is north).
const AT_DESK: SavedView = { floor: 0, x: MANAGER_DESK.x, z: MANAGER_DESK.z + MANAGER_DESK.d / 2 + 0.8, yaw: 0, pitch: -0.6 };

type Received = { event: string; title: string; body: string };
const receivedNotes = (page: import('@playwright/test').Page) =>
  page.evaluate(() => ((window as unknown as { __swarmNotify?: { received: Received[] } }).__swarmNotify?.received ?? []) as Received[]);

test('the console shows the upstream status and a comparison link', async ({ page }) => {
  await startAt(page, AT_DESK);
  await enterOffice(page);
  await page.keyboard.press('e');
  // The first-run tour covers the console; skip it so the Upstream row is visible.
  const skipTour = page.getByText('Skip tour');
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click();
  await expect(page.getByText('Upstream', { exact: true })).toBeVisible();
  // The demo opens on "updates": the row shows the status, the last check and a comparison link.
  await expect(page.getByText(/updates available/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Compare on GitHub/ })).toHaveAttribute('href', /github\.com\/.+\/compare\//);
  await page.screenshot({ path: 'test-results/upstream-console.png' });
});

test('the upstream notice is readable on a phone-sized screen, with a comparison link', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?pocket=1');
  // The demo picks a scenario; the office checks and sends the phone notice its comparison link. The notifier batches
  // one notification per event a minute, so allow for the summary after a first check already went out this minute.
  await page.request.post('/api/upstream/demo', { data: { scenario: 'diverged' } });
  await expect.poll(async () => (await receivedNotes(page)).some((n) => n.event === 'upstream'), { timeout: 90_000 }).toBe(true);
  const upstream = (await receivedNotes(page)).find((n) => n.event === 'upstream');
  expect(upstream?.title).toMatch(/Upstream/);
  expect(upstream?.body).toContain('https://github.com/');
  await page.screenshot({ path: 'test-results/upstream-phone.png' });
});
