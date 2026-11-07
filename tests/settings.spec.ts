import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

for (const theme of ['light', 'dark'] as const) {
  test(`设置页窄屏${theme}主题字段单列且不横向滚动`, async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 900 });
    await page.addInitScript(({ version, theme }) => {
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = theme; });
      // Older saves reach the page with the default provider filled in; the address decides.
      const settings = { provider: 'deepseek', format: 'openai', endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'example-key-not-a-real-key', model: 'deepseek-flash', thinking: 'off', sourceLanguage: 'auto', targetLanguage: 'zh-CN', mode: 'bilingual', testedAt: null };
      const chromeMock = {
        runtime: { onMessage: { addListener() {}, removeListener() {} }, async sendMessage() { return { ok: true, version, data: settings }; }, reload() {} },
        commands: { async getAll() { return [{ name: 'toggle-translation', shortcut: 'Alt+T' }]; } },
        tabs: { create() {} },
      };
      Object.assign(window, { chrome: chromeMock });
    }, { version, theme });
    await page.goto('http://127.0.0.1:5197/options.html');
    await expect(page.getByLabel('服务商')).toHaveValue('siliconflow');
    await expect(page.getByRole('link', { name: '获取 Key' })).toHaveAttribute('target', '_blank');
    const model = (await page.getByLabel('模型 ID').boundingBox())!;
    const thinking = (await page.getByLabel('思考强度').boundingBox())!;
    expect(thinking.y).toBeGreaterThan(model.y + model.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(400);
    await page.screenshot({ path: `test-results/settings-narrow-${theme}.png`, fullPage: true, animations: 'disabled' });
  });
}
