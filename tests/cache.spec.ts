import { expect, test } from '@playwright/test';
import { isSourceExtension, ResultCache, type RecentIdentity } from '../content/cache';

const identity: RecentIdentity = {
  unitKey: 'x:123',
  pair: { sourceLanguage: 'en', targetLanguage: 'zh-CN' },
  endpoint: 'https://example.test/v1',
  context: '',
  supplement: 'quoted context',
};

function cache(maxEntries = 512, maxBytes = 4 * 1024 * 1024) {
  return new ResultCache<{ text: string }>({
    cloneOutput: output => ({ ...output }),
    outputBytes: output => 2 * output.text.length,
    maxEntries,
    maxBytes,
  });
}

test('共享LRU条数预算保护挂载结果与在途请求', () => {
  const results = cache(3);
  results.set('old', { state: 'done', text: 'old' });
  results.set('attached', { state: 'done', text: 'attached' });
  results.set('pending', { state: 'pending' });
  results.rememberRecent(identity, 'A truncated original…', { text: '旧译文' });
  results.trim(new Set(['attached']));
  expect(results.has('old')).toBe(false);
  expect(results.has('attached')).toBe(true);
  expect(results.has('pending')).toBe(true);
  expect(results.recordCount).toBe(3);
  results.set('new', { state: 'done', text: 'new' });
  results.trim(new Set(['attached']));
  expect(results.recentExtension(identity, 'A truncated original continues')).toBeUndefined();
  expect(results.has('new')).toBe(true);
  expect(results.recordCount).toBe(3);
});

test('字节预算在结果更新后重新计算，触及的结果最后淘汰', () => {
  const results = cache(10, 20);
  results.set('a', { state: 'done', text: 'abc' });
  results.set('b', { state: 'waiting' });
  results.touch('a');
  results.get('b')!.text = 'x'.repeat(20);
  results.trim(new Set());
  expect(results.has('b')).toBe(false);
  expect(results.has('a')).toBe(true);
  expect(results.bytes).toBe(8);
  results.rememberRecent(identity, 'A truncated original…', { text: 'x'.repeat(20) });
  results.trim(new Set());
  expect(results.recordCount).toBe(0);
  expect(results.bytes).toBe(0);
});

test('最近帖只复用同身份同配置的延伸原文，并克隆输入与返回值', () => {
  const results = cache();
  const original = { text: '旧译文' };
  results.rememberRecent(identity, 'A truncated original…', original);
  original.text = '已修改';
  const retained = results.recentExtension(identity, 'A truncated original continues')!;
  expect(retained.text).toBe('旧译文');
  retained.text = '返回值修改';
  expect(results.recentExtension(identity, 'A truncated original continues')?.text).toBe('旧译文');
  expect(results.recentExtension({ ...identity, pair: { ...identity.pair, targetLanguage: 'ja' } }, 'A truncated original continues')).toBeUndefined();
  expect(results.recentExtension({ ...identity, endpoint: 'other' }, 'A truncated original continues')).toBeUndefined();
  expect(results.recentExtension({ ...identity, supplement: 'different quote' }, 'A truncated original continues')).toBeUndefined();
  expect(results.recentExtension(identity, 'A different original continues')).toBeUndefined();
  results.rememberRecent({ ...identity, unitKey: 'x:text:123' }, 'A truncated original…', original);
  expect(results.recordCount).toBe(1);
  results.set('exact', { state: 'done', text: '命中译文' });
  results.clearRecent();
  expect(results.recordCount).toBe(1);
  expect(results.get('exact')?.text).toBe('命中译文');
});

test('延伸判断去掉尾部省略号，短前缀与全文回缩不复用', () => {
  expect(isSourceExtension('Sixteen chars or more...  ', 'Sixteen chars or more and full')).toBe(true);
  expect(isSourceExtension('short…', 'short and full')).toBe(false);
  expect(isSourceExtension('Sixteen chars or more and full', 'Sixteen chars or more…')).toBe(false);
  expect(isSourceExtension('Sixteen chars or more', 'Sixteen chars or more')).toBe(false);
});
