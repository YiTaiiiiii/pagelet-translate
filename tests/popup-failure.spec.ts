import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

for (const theme of ['light', 'dark'] as const) {
  for (const paused of [false, true]) {
    test(`300px弹窗${theme}主题${paused ? '暂停' : '失败'}控件分行且操作有效`, async ({ page }) => {
      await page.setViewportSize({ width: 300, height: 460 });
      const external: string[] = [];
      page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:5197/')) external.push(request.url()); });
      await page.addInitScript(({ version, theme, paused }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = theme; });
        let state = { enabled: true, completed: 11, pending: 0, failed: 2, error: '', scope: 'main', paused };
        const settings = { endpoint: 'http://127.0.0.1', apiKey: 'example-key-not-a-real-key', sourceLanguage: 'auto', targetLanguage: 'zh-CN', mode: 'bilingual', testedAt: '2026-10-12T00:00:00.000Z' };
        Object.assign(window, { popupCalls: [] });
        const chromeMock = {
          runtime: {
            onMessage: { addListener() {}, removeListener() {} },
            async sendMessage(message: { type: string; scope?: string }) {
              (window as unknown as { popupCalls: object[] }).popupCalls.push(message);
              if (message.type === 'save-scope') state = { ...state, scope: message.scope! };
              if (message.type === 'pagelet-retry') state = { ...state, completed: 13, failed: 0, paused: false };
              return { ok: true, version, data: message.type === 'get-settings' ? settings : message.type === 'get-usage' ? [] : state };
            },
            openOptionsPage() {}, reload() {},
          },
          commands: { async getAll() { return [{ name: 'toggle-translation', shortcut: 'Alt+T' }]; } },
          tabs: { async query() { return [{ id: 1, url: 'https://x.com/home' }]; }, create() {} },
          storage: { onChanged: { addListener() {}, removeListener() {} } },
        };
        Object.assign(window, { chrome: chromeMock });
      }, { version, theme, paused });
      await page.goto('http://127.0.0.1:5197/popup.html');
      const panel = page.getByRole('region', { name: '原页翻译面板' });
      const status = page.getByRole('status');
      const scope = page.getByLabel('包括导航等其他区域');
      const retry = page.getByRole('button', { name: paused ? '继续' : '重试失败段落', exact: true });
      await expect(status).toHaveText('已翻译 11 段 · 失败 2');
      await expect(retry).toBeVisible();
      const label = scope.locator('..');
      const statusBox = (await status.boundingBox())!;
      const labelBox = (await label.boundingBox())!;
      const retryBox = (await retry.boundingBox())!;
      const panelBox = (await panel.boundingBox())!;
      expect(panelBox.width).toBe(300);
      expect(labelBox.y).toBeGreaterThanOrEqual(statusBox.y + statusBox.height + 7);
      expect(retryBox.y).toBeGreaterThanOrEqual(labelBox.y + labelBox.height + 7);
      expect(retryBox.width).toBe(276);
      expect(retryBox.x + retryBox.width).toBeLessThanOrEqual(300);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(300);
      await label.click();
      await expect(scope).toBeChecked();
      await retry.click();
      await expect(status).toHaveText('已翻译 13 段');
      await expect(retry).toHaveCount(0);
      const calls = await page.evaluate(() => (window as unknown as { popupCalls: { type: string; scope?: string }[] }).popupCalls);
      expect(calls.filter(call => call.type === 'save-scope')).toEqual([{ type: 'save-scope', scope: 'all' }]);
      expect(calls.filter(call => call.type === 'pagelet-retry')).toHaveLength(1);
      expect(external).toEqual([]);
    });
  }
}
