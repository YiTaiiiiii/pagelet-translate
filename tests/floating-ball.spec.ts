import { chromium, test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createSecureServer, type Http2SecureServer } from 'node:http2';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Own browser: the floating ball needs access to every HTTPS site, which the
// reader grants when switching it on. Here it is pregranted, since headless
// Chrome cannot answer the permission prompt. Fake Key, loopback fake API only.
let context: BrowserContext;
let server: Http2SecureServer;
let temp: string;
let extensionUrl: string;
let endpoint: string;
let options: Page;
const requests: unknown[] = [];
const FAKE_KEY = 'fixture-key-not-a-real-secret';
const fixture = '<!doctype html><meta charset="utf-8"><title>Ball fixture</title><main><h1>Read comfortably</h1><p id="update">A useful tool keeps the page readable.</p></main>';

test.beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'pagelet-ball-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temp, 'key.pem'), '-out', join(temp, 'cert.pem'), '-subj', '/CN=127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  server = createSecureServer({ key: await readFile(join(temp, 'key.pem')), cert: await readFile(join(temp, 'cert.pem')), allowHTTP1: true }, async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixture); return; }
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push(body);
    const batch = JSON.parse(body.messages.at(-1).content);
    const content = JSON.stringify({ translations: batch.items.map(({ id, text }: { id: string; text: string }) => ({ id, text: `译：${text}` })) });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  endpoint = `https://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const extensionDir = join(temp, 'extension');
  await cp(resolve('.output/chrome-mv3'), extensionDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['https://*/*'];
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 900 }, colorScheme: 'light',
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--ignore-certificate-errors'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const workerUrl = new URL(worker.url());
  extensionUrl = `${workerUrl.protocol}//${workerUrl.host}`;
  options = await context.newPage();
  await options.goto(`${extensionUrl}/options.html`);
  const saved = await options.evaluate(settings => chrome.runtime.sendMessage({ type: 'save-settings', settings }), { endpoint: `${endpoint}/v1`, apiKey: FAKE_KEY, mode: 'bilingual', testedAt: null });
  expect(saved.ok, saved.error).toBe(true);
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>(done => server?.close(() => done()));
  if (temp) await rm(temp, { recursive: true, force: true });
});

function look(page: Page) {
  return page.evaluate(() => {
    const ball = document.querySelector('pagelet-ball')?.shadowRoot?.querySelector('button');
    if (!ball) return null;
    const rect = ball.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, icon: ball.querySelector('svg')!.getBoundingClientRect().width, opacity: Number(getComputedStyle(ball).opacity), label: ball.getAttribute('aria-label'), background: getComputedStyle(ball).backgroundColor, color: getComputedStyle(ball).color };
  });
}
// Real mouse input on the visible half, the way a reader points at it.
async function center(page: Page) {
  const box = (await look(page))!, width = page.viewportSize()!.width;
  const left = Math.max(box.left, 0), right = Math.min(box.right, width);
  return { x: (left + right) / 2, y: box.top + box.width / 2 };
}

test('悬浮球默认关闭；开启后贴边露出一半，悬停才滑出，翻译后移开仍半露；可拖到另一侧并记住位置', async () => {
  const reader = await context.newPage();
  await reader.emulateMedia({ reducedMotion: 'reduce' });
  await reader.goto(`${endpoint}/page`);
  await reader.waitForTimeout(300);
  expect(await look(reader)).toBeNull();

  const toggle = options.getByRole('switch', { name: '悬浮球' });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();

  // Already open tabs get the ball at once: 32 px with the 20 px glyph, half past the right edge.
  await expect.poll(() => look(reader)).not.toBeNull();
  const idle = (await look(reader))!;
  expect(idle.width).toBe(32);
  expect(idle.icon).toBe(20);
  expect(idle.left).toBeCloseTo(1100 - 16, 0);
  expect(idle.opacity).toBeCloseTo(.5, 1);
  expect(idle.label).toBe('翻译此页');
  // White with a blue glyph before translating.
  expect(idle.background).toBe('rgb(255, 255, 255)');
  expect(idle.color).toBe('rgb(59, 130, 246)');

  // A page script clicking the ball does not start a translation.
  await reader.evaluate(() => (document.querySelector('pagelet-ball')!.shadowRoot!.querySelector('button') as HTMLButtonElement).click());
  await reader.waitForTimeout(400);
  expect(requests).toHaveLength(0);

  await reader.bringToFront();
  const point = await center(reader);
  await reader.mouse.move(point.x, point.y);
  const hovered = (await look(reader))!;
  expect(hovered.right).toBeCloseTo(1100 - 8, 0);
  expect(hovered.opacity).toBe(1);
  await reader.mouse.down(); await reader.mouse.up();
  await expect(reader.locator('#update [data-pagelet-output]')).toHaveText('译：A useful tool keeps the page readable.');
  await expect.poll(async () => (await look(reader))?.label).toBe('恢复原文');
  // Translated: blue with a white glyph, faded in.
  await expect.poll(async () => (await look(reader))?.background).toBe('rgb(96, 165, 250)');
  expect((await look(reader))!.color).toBe('rgb(255, 255, 255)');
  // Still pointed at: fully out. Pointer gone: half hidden again, translated or not.
  expect((await look(reader))!.opacity).toBe(1);
  await reader.mouse.move(400, 400);
  const resting = (await look(reader))!;
  expect(resting.left).toBeCloseTo(1100 - 16, 0);
  expect(resting.opacity).toBeCloseTo(.5, 1);

  // Dragging shows the whole ball under the pointer and does not translate;
  // let go on the left half and it rests half hidden on the left edge.
  const sent = requests.length;
  const from = await center(reader);
  await reader.mouse.move(from.x, from.y);
  await reader.mouse.down();
  await reader.mouse.move(600, 300, { steps: 6 });
  await reader.mouse.move(300, 200, { steps: 6 });
  const dragging = (await look(reader))!;
  expect(dragging.left).toBeCloseTo(300 - 16, 0);
  expect(dragging.top).toBeCloseTo(200 - 16, 0);
  expect(dragging.opacity).toBe(1);
  await reader.mouse.up();
  await reader.mouse.move(500, 600);
  const docked = (await look(reader))!;
  expect(docked.left).toBeCloseTo(-16, 0);
  expect(docked.top).toBeCloseTo(200 - 16, 0);
  expect(docked.opacity).toBeCloseTo(.5, 1);
  expect(docked.label).toBe('恢复原文');
  expect(requests.length).toBe(sent);
  await expect(reader.locator('[data-pagelet-output]').first()).toBeVisible();

  // Hover from the left edge, click to restore.
  const left = await center(reader);
  await reader.mouse.move(left.x, left.y);
  expect((await look(reader))!.left).toBeCloseTo(8, 0);
  await reader.mouse.down(); await reader.mouse.up();
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(0);
  await expect.poll(async () => (await look(reader))?.label).toBe('翻译此页');
  await expect.poll(async () => (await look(reader))?.background).toBe('rgb(255, 255, 255)');

  // Pages loaded later get the ball from the registered script, where it was left.
  const later = await context.newPage();
  await later.goto(`${endpoint}/page?later`);
  await expect.poll(async () => (await look(later))?.left).toBeCloseTo(-16, 0);
  expect((await look(later))!.top).toBeCloseTo(200 - 16, 0);

  await options.bringToFront();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => look(reader)).toBeNull();
  const after = await context.newPage();
  await after.goto(`${endpoint}/page?after`);
  await after.waitForTimeout(500);
  expect(await look(after)).toBeNull();
});
