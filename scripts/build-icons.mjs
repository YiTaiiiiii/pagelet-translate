import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';

const svg = await readFile('public/icon.svg', 'utf8');
await mkdir('public/icon', { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>body{margin:0}svg{width:100vw;height:100vh;display:block}</style>${svg}`);
    await page.screenshot({ path: `public/icon/${size}.png`, omitBackground: true });
  }
} finally { await browser.close(); }
console.log('Generated local extension icons: 16, 32, 48, 128 px.');
