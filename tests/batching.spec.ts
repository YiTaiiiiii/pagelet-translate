import { expect, test } from '@playwright/test';
import { planBatches, type BatchParagraph, type Candidate } from '../content/batching';

function candidate(key: string, top: number, priority: 0 | 1 = 0, overrides: Partial<BatchParagraph> = {}): Candidate<BatchParagraph> {
  return {
    p: { key, source: { text: 'short text' }, context: '', supplement: '', kind: 'feed', unit: key, ...overrides },
    rect: { top, bottom: top + 100 },
    priority,
  };
}

const options = { direction: 1, firstBatch: true, state: () => 'waiting' as const };

test('当前屏优先、首批三段、后续六段、内容键去重', () => {
  const candidates = [candidate('prefetch', 1000, 1), ...Array.from({ length: 8 }, (_, i) => candidate('visible-' + i, 700 - i * 100)), candidate('visible-7', 10)];
  const result = planBatches(candidates, options);
  expect(result.batches.map(batch => batch.paragraphs.map(p => p.key))).toEqual([
    ['visible-7', 'visible-6', 'visible-5'],
    ['visible-4', 'visible-3', 'visible-2', 'visible-1', 'visible-0'],
    ['prefetch'],
  ]);
  expect(result.firstBatch).toBe(false);
  expect(result.allowed.size).toBe(9);
  expect(candidates[0]?.p.key).toBe('prefetch');
});

test('预取数量与token预算计入已完成正文，暂停时批次为空', () => {
  const candidates = Array.from({ length: 34 }, (_, i) => candidate('p' + i, 1000 + i * 100, 1));
  const count = planBatches(candidates, { ...options, state: key => key === 'p0' ? 'done' : 'waiting' });
  expect(count.allowed.size).toBe(30);
  expect(count.batches.flatMap(batch => batch.paragraphs).map(p => p.key)).not.toContain('p0');
  const tokens = planBatches([
    candidate('large', 1000, 1, { source: { text: 'x'.repeat(11997) } }),
    candidate('skip', 1100, 1),
    candidate('tiny', 1200, 1, { source: { text: 'x' } }),
  ], options);
  expect([...tokens.allowed.keys()]).toEqual(['large', 'tiny']);
  const inactive = planBatches(candidates, { ...options, active: false });
  expect(inactive.allowed.size).toBe(0);
  expect(inactive.batches).toEqual([]);
  expect(inactive.firstBatch).toBe(true);
});

test('分批使用首批400与后续1200token边界，按方向和文档单元隔离', () => {
  const tokenPlan = planBatches(Array.from({ length: 4 }, (_, i) => candidate('p' + i, i * 100, 0, { source: { text: 'x'.repeat(600) } })), options);
  expect(tokenPlan.batches.map(batch => batch.paragraphs.length)).toEqual([2, 2]);
  const unit = {};
  const documentPlan = planBatches([
    candidate('a', 0, 0, { kind: 'document', unit }),
    candidate('b', 100, 0, { kind: 'document', unit: {} }),
    candidate('c', 200, 0, { kind: 'document', unit }),
    candidate('d', 300, 0, { kind: 'document', unit, context: 'other heading' }),
  ], { ...options, direction: -1 });
  expect(documentPlan.batches.map(batch => batch.paragraphs.map(p => p.key))).toEqual([['d'], ['c', 'a'], ['b']]);
  const later = planBatches(Array.from({ length: 7 }, (_, i) => candidate('p' + i, i * 100, 0, { source: { text: 'x'.repeat(600) } })), { ...options, firstBatch: false });
  expect(later.batches.map(batch => batch.paragraphs.length)).toEqual([6, 1]);
});

test('文档各节共用页面标题即可合批，节标题作为各段附注只计一次', () => {
  const unit = {};
  const plan = planBatches([
    candidate('a', 0, 0, { kind: 'document', unit, context: 'Title', supplement: 'Install' }),
    candidate('b', 40, 0, { kind: 'document', unit, context: 'Title', supplement: 'Install' }),
    candidate('c', 80, 0, { kind: 'document', unit, context: 'Title', supplement: 'Usage' }),
  ], { direction: 1, firstBatch: false, state: () => 'waiting' });
  expect(plan.batches.map(batch => batch.paragraphs.map(p => p.key))).toEqual([['a', 'b', 'c']]);
  const shared = 'x'.repeat(2400); // about 800 estimated tokens, counted once
  const notes = planBatches(['a', 'b', 'c'].map((key, i) => candidate(key, i * 40, 0, { supplement: shared })), { direction: 1, firstBatch: false, state: () => 'waiting' });
  expect(notes.batches).toHaveLength(1);
});
