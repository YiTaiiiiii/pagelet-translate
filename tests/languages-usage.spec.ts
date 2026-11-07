import { test, expect } from '@playwright/test';
import { parseSettings, DEFAULT_SETTINGS } from '../shared/settings';
import { parseLanguages } from '../shared/languages';
import { requestUsage, type RequestUsage } from '../shared/usage';
import { complete } from '../core/connection';
import { translate } from '../core/translate';

test('旧配置保持自动检测到中文，新语言可保存且非法代码被拒绝', () => {
  expect(parseSettings({ endpoint: 'https://api.deepseek.com', apiKey: 'fake-test', mode: 'bilingual' })).toMatchObject({ sourceLanguage: 'auto', targetLanguage: 'zh-CN' });
  expect(parseLanguages({ sourceLanguage: 'ja', targetLanguage: 'fr' })).toEqual({ sourceLanguage: 'ja', targetLanguage: 'fr' });
  expect(() => parseLanguages({ sourceLanguage: 'auto', targetLanguage: 'auto' })).toThrow();
  expect(() => parseLanguages({ sourceLanguage: 'toString', targetLanguage: 'en' })).toThrow();
});

test('用量读取兼容缓存字段，未知不当作零，TPS按完整请求时间计算', () => {
  const official = requestUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30 } }, 1000, 250, 'ok', 200);
  expect(official).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 70, cacheMissTokens: 30, averageTps: 80 });
  const compatible = requestUsage({ usage: { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }, 1000, 2000, 'ok', 200);
  expect(compatible).toMatchObject({ totalTokens: 100, cacheReadTokens: 0, cacheMissTokens: 100, averageTps: 0 });
  expect(requestUsage({}, 1000, 1000, 'error', 429)).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheMissTokens: null, averageTps: null });
});

test('接口失败和取消也记录耗时，不把未知用量或服务错误原文写进记录', async () => {
  const original = globalThis.fetch;
  const records: RequestUsage[] = [];
  globalThis.fetch = async () => new Response('{"error":"private-server-secret"}', { status: 429 });
  try {
    await expect(complete(DEFAULT_SETTINGS, [], undefined, value => { records.push(value); })).rejects.toThrow('限流');
    expect(records[0]).toMatchObject({ status: 'error', httpStatus: 429, totalTokens: null });
    globalThis.fetch = async () => { throw new Error('private-network-secret'); };
    const controller = new AbortController(); controller.abort();
    await expect(complete(DEFAULT_SETTINGS, [], controller.signal, value => { records.push(value); })).rejects.toThrow('已取消');
    expect(records[1]).toMatchObject({ status: 'cancelled', httpStatus: null });
    expect(JSON.stringify(records)).not.toContain('secret');
  } finally { globalThis.fetch = original; }
});
