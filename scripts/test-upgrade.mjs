// Mixed-version regression. An unpacked extension can run a worker, extension
// pages and page scripts from different builds after its files are replaced.
// The current source is built twice with two version strings; every check
// runs against a loopback fake API with a fake Key, never a model service.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, readdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OLD = '1.0.0', NEW = '1.0.1';
const REFRESH = '刷新网页';
const RELOAD = '扩展已更新';
const repo = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'pagelet-upgrade-check-'));
const fakeKey = 'upgrade-fixture-not-a-real-key';
const requests = [];
const fixture = '<!doctype html><meta charset="utf-8"><title>Upgrade sample</title><main><h1>The heart of the internet</h1><p>Communities, endless conversation, and authentic human connection live here.</p><p>Find your community and join the discussion.</p></main>';
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 };
const server = createServer(async (request, response) => {
  if (request.url === '/page') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixture); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  const batch = JSON.parse(body.messages.at(-1).content);
  const content = JSON.stringify({ translations: batch.items.map(({ id, text }) => ({ id, text: `译：${text}` })) });
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (let i = 0; i < content.length; i += 17) response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 17) } }] }) + '\n\n');
  response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const contexts = [];
const report = { date: new Date().toISOString(), versions: { old: OLD, new: NEW }, checks: [] };
function passed(check) { report.checks.push(check); console.log('ok -', check); }

// Copy the working tree (sources only) and build it under another version.
const SKIP = new Set(['node_modules', 'docs', 'scripts', 'tests', 'test-results', 'playwright-report', 'artifacts']);
async function build(version) {
  const dir = join(root, `src-${version}`); await mkdir(dir);
  for (const name of await readdir(repo)) {
    if (!name.startsWith('.') && !SKIP.has(name)) await cp(join(repo, name), join(dir, name), { recursive: true });
  }
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2));
  await symlink(join(repo, 'node_modules'), join(dir, 'node_modules'));
  execFileSync(join(repo, 'node_modules/.bin/wxt'), ['build'], { cwd: dir, stdio: 'ignore', timeout: 120_000 });
  return join(dir, '.output/chrome-mv3');
}
// Put files from one build into an installed directory; the API host is
// pre-granted because headless Chrome cannot answer a permission prompt.
async function install(dir, { ui, background = ui, content = ui }) {
  await cp(ui, dir, { recursive: true });
  await cp(join(background, 'background.js'), join(dir, 'background.js'));
  await cp(join(content, 'translator.js'), join(dir, 'translator.js'));
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
}
async function launch(name, parts) {
  const dir = join(root, name);
  await install(dir, parts);
  const context = await chromium.launchPersistentContext(join(root, `${name}-profile`), { channel: 'chromium', headless: true, viewport: { width: 1000, height: 700 }, args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`] });
  contexts.push(context);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:' ? route.continue() : route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // Mirror an unpacked installation. With the command-line flag alone the
  // first load runs with developer mode off, and Chrome disables it on reload.
  const manager = await context.newPage(); await manager.goto('chrome://extensions/');
  const developerMode = manager.locator('extensions-toolbar #devMode');
  if (!await developerMode.evaluate(element => element.checked)) await developerMode.click();
  await expect.poll(() => developerMode.evaluate(element => element.checked)).toBe(true);
  await manager.close();
  // URL.origin is null for chrome-extension URLs in Node.
  const extensionUrl = `chrome-extension://${new URL(worker.url()).host}`;
  const popup = await context.newPage(); await popup.goto(`${extensionUrl}/popup.html`);
  // Settings as saved before format, model and thinking existed.
  await popup.evaluate(({ endpoint, fakeKey }) => chrome.storage.local.set({ 'settings.v1': { endpoint, apiKey: fakeKey, mode: 'bilingual', testedAt: '2026-01-01T00:00:00Z' } }), { endpoint, fakeKey });
  const reader = await context.newPage(); await reader.goto(`${endpoint}/page`); await reader.bringToFront();
  await popup.reload();
  return { context, dir, popup, reader, extensionUrl };
}
const panel = popup => popup.getByRole('region', { name: '原页翻译面板' });
const translateButton = popup => popup.getByRole('button', { name: '翻译此页' });
const reloadButton = popup => popup.getByRole('button', { name: '重新加载扩展', exact: true });
async function translated(popup, reader, count) {
  await translateButton(popup).click();
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(count);
  await expect(popup.getByRole('status')).toContainText(`已翻译 ${count} 段`);
}

try {
  console.log(`Build the current source as ${OLD} and ${NEW}; loopback fake API only.`);
  const [oldBuild, newBuild] = [await build(OLD), await build(NEW)];
  await mkdir('test-results', { recursive: true });

  // 1. Files replaced while the old worker keeps running.
  const app = await launch('upgrade', { ui: oldBuild });
  await translated(app.popup, app.reader, 3);
  expect(requests.length).toBe(1);
  await install(app.dir, { ui: newBuild });
  await app.popup.reload();
  await expect(app.popup.getByRole('alert')).toContainText(RELOAD);
  await expect(reloadButton(app.popup)).toBeEnabled();
  await expect(app.popup.getByRole('button', { name: '翻译不可用' })).toBeDisabled();
  await expect(app.popup.getByText('读取失败', { exact: true })).toBeVisible();
  expect(requests.length).toBe(1);
  await panel(app.popup).screenshot({ path: 'test-results/upgrade-reload.png' });
  passed('New popup with the old worker asks to reload the extension, blocks translation and reports unreadable usage; zero model requests.');

  // 2. The real reload button starts the new worker and keeps the Key.
  const stoppedWorker = app.context.serviceWorkers()[0].waitForEvent('close');
  await reloadButton(app.popup).click().catch(error => {
    // runtime.reload closes its own extension page during the click.
    if (!app.popup.isClosed()) throw error;
  });
  await stoppedWorker;
  const popup = await app.context.newPage();
  // Chrome briefly unloads the extension before registering the new version.
  await expect(async () => {
    await popup.goto(`${app.extensionUrl}/popup.html`);
    await expect(translateButton(popup)).toBeEnabled();
  }).toPass({ timeout: 10_000 }).catch(async error => {
    console.error('Reloaded popup:', await popup.locator('body').innerText().catch(() => 'unavailable'));
    throw error;
  });
  const keyPreserved = await popup.evaluate(fakeKey => chrome.storage.local.get('settings.v1').then(saved => saved['settings.v1'].apiKey === fakeKey), fakeKey);
  expect(keyPreserved).toBe(true);
  passed('Reload button replaces the old worker; the stored Key is kept.');

  // 3. Translating again before refreshing would stack a second translation
  // under the old one's: the new script asks for a refresh instead.
  await app.reader.bringToFront(); await popup.reload();
  await translateButton(popup).click();
  await expect(popup.locator('body')).toContainText('请刷新网页');
  await expect(app.reader.locator('[data-pagelet-output]')).toHaveCount(3);
  expect(requests.length).toBe(1);
  passed('Translating an already translated page after the reload asks for a refresh; no second translation, zero model requests.');

  // As the reload message says, refresh the page; it then translates with
  // the new build.
  await app.reader.reload(); await app.reader.bringToFront(); await popup.reload();
  await translated(popup, app.reader, 3);
  expect(requests.length).toBe(2);
  const sources = JSON.parse(requests.at(-1).messages.at(-1).content).items.map(item => item.text);
  expect(new Set(sources).size).toBe(3);
  await expect(popup.locator('summary')).toContainText('本页 1 次 · 120 token');
  await popup.getByRole('button', { name: '仅看译文' }).click();
  await expect(app.reader.locator('main h1')).toContainText('译：');
  await popup.getByRole('button', { name: '恢复原文' }).click();
  await expect(app.reader.locator('main h1')).toHaveText('The heart of the internet');
  await expect(app.reader.locator('[data-pagelet-output]')).toHaveCount(0);
  await panel(popup).screenshot({ path: 'test-results/upgrade-after.png' });
  expect(requests.length).toBe(2);
  passed('Refreshed page translates three paragraphs in one request, records usage, switches mode and restores.');
  await app.context.close();

  // 4. Each side refuses the other build's messages before any request.
  const staleContent = await launch('stale-content', { ui: newBuild, content: oldBuild });
  await translateButton(staleContent.popup).click();
  await expect(staleContent.popup.getByRole('alert')).toContainText(REFRESH);
  await expect(staleContent.reader.locator('[data-pagelet-output]')).toHaveCount(0);
  await panel(staleContent.popup).screenshot({ path: 'test-results/upgrade-refresh.png' });
  await staleContent.context.close();
  const staleWorker = await launch('stale-worker', { ui: oldBuild, content: newBuild });
  const reply = await staleWorker.popup.evaluate(() => chrome.runtime.sendMessage({ type: 'pagelet-toggle' }));
  expect(reply.ok).toBe(false); expect(reply.error).toContain(REFRESH);
  await expect(staleWorker.reader.locator('[data-pagelet-output]')).toHaveCount(0);
  await staleWorker.context.close();
  expect(requests.length).toBe(2);
  passed('New worker rejects an old page script, and an old worker a new one (shortcut path); zero model requests.');

  report.localMockRequests = requests.length;
  await writeFile('test-results/upgrade-results.json', JSON.stringify(report, null, 2));
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}
