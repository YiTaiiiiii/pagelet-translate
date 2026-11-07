// A dedicated browser for real-page checks, separate from your everyday Chrome.
// Chrome for Testing from the Playwright cache, headless, own profile under
// ~/.local/share/pagelet-check. The built extension is copied there with site
// access pre-granted (no permission prompt can be answered headless).
//
//   node scripts/check-browser.mjs start    launch (or reuse) the browser
//   node scripts/check-browser.mjs reload   restart with the current build (open pages are lost)
//   node scripts/check-browser.mjs stop     close the browser
//
// Page actions import { connect } from this file. Settings, including the Key,
// live only in that profile's extension storage, never in this repository.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const HOME = join(homedir(), '.local/share/pagelet-check');
const PROFILE = join(HOME, 'profile');
const EXTENSION = join(HOME, 'extension');
const PORT = 9339;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const BUILD = resolve(import.meta.dirname, '../.output/chrome-mv3');

// Unpacked extension IDs come from the load path, so this one never changes.
const ID = [...createHash('sha256').update(EXTENSION).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const ORIGIN = `chrome-extension://${ID}`;
async function running() {
  try { return (await fetch(`${ENDPOINT}/json/version`)).ok; } catch { return false; }
}
async function copyExtension() {
  await rm(EXTENSION, { recursive: true, force: true });
  await cp(BUILD, EXTENSION, { recursive: true });
  const manifest = JSON.parse(await readFile(join(EXTENSION, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  await writeFile(join(EXTENSION, 'manifest.json'), JSON.stringify(manifest));
  return manifest.version;
}
export async function start() {
  if (await running()) return;
  await mkdir(PROFILE, { recursive: true });
  await copyExtension();
  const child = spawn(chromium.executablePath(), [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--lang=zh-CN', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 50 && !await running(); i++) await new Promise(r => setTimeout(r, 200));
  if (!await running()) throw new Error('check browser did not start');
}
// The MV3 worker sleeps when idle; a message from an extension page wakes it.
async function extensionWorker(context, page) {
  for (let i = 0; i < 50; i++) {
    const worker = context.serviceWorkers().find(w => w.url().startsWith(ORIGIN + '/'));
    if (worker) return worker;
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get-settings' })).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('extension service worker not found');
}
// Returns helpers bound to the running browser. Close with done().
export async function connect() {
  await start();
  const browser = await chromium.connectOverCDP(ENDPOINT);
  const context = browser.contexts()[0];
  const origin = ORIGIN;
  let control;
  async function ui() {
    if (!control || control.isClosed()) { control = await context.newPage(); await control.goto(`${origin}/options.html`); }
    return control;
  }
  const worker = await extensionWorker(context, await ui());
  // Same messages the popup sends; the background acts on the active web tab.
  async function send(page, message) {
    const extension = await ui();
    await page.bringToFront();
    const reply = await extension.evaluate(m => chrome.runtime.sendMessage(m), message);
    if (!reply?.ok) throw new Error(reply?.error || 'no reply');
    return reply.data;
  }
  return {
    browser, context, worker, origin,
    async open(url) { const page = await context.newPage(); await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(url, { waitUntil: 'domcontentloaded' }); return page; },
    toggle: page => send(page, { type: 'pagelet-toggle' }),
    state: page => send(page, { type: 'pagelet-get-state' }),
    mode: (page, mode) => send(page, { type: 'save-mode', mode }),
    retry: page => send(page, { type: 'pagelet-retry' }),
    autoSite: (page, enabled) => send(page, enabled === undefined ? { type: 'get-auto-site' } : { type: 'save-auto-site', enabled }),
    usage: async () => (await ui()).evaluate(() => chrome.runtime.sendMessage({ type: 'get-usage' })).then(r => r.data),
    settings: async () => (await ui()).evaluate(() => chrome.runtime.sendMessage({ type: 'get-settings' })).then(r => ({ ...r.data, apiKey: r.data?.apiKey ? '(set)' : '' })),
    // Close every web page left from earlier runs.
    async clean() { for (const page of context.pages()) if (page !== control && !page.url().startsWith(origin)) await page.close(); },
    async done() { if (control && !control.isClosed()) await control.close(); await browser.close(); },
  };
}
// Replacing the files of a loaded unpacked extension can leave it disabled,
// so a reload restarts the browser with the fresh copy.
async function reload() {
  await stop();
  // Chrome keeps running the cached worker of an unpacked extension across
  // restarts even when its files changed; drop the cache (not extension storage).
  await rm(join(PROFILE, 'Default', 'Service Worker'), { recursive: true, force: true });
  await start();
  return JSON.parse(await readFile(join(EXTENSION, 'manifest.json'), 'utf8')).version;
}
async function stop() {
  if (!await running()) return;
  const browser = await chromium.connectOverCDP(ENDPOINT);
  const session = await browser.newBrowserCDPSession();
  await session.send('Browser.close').catch(() => {});
  for (let i = 0; i < 50 && await running(); i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 500));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  if (command === 'start') { await start(); console.log('check browser running on', ENDPOINT); }
  else if (command === 'reload') console.log('reloaded extension', await reload());
  else if (command === 'stop') { await stop(); console.log('stopped'); }
  else { console.error('usage: start | reload | stop'); process.exit(1); }
}
