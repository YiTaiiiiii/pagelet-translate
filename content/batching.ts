import { estimateTokens } from '../shared/engine';
import type { Entry } from './cache';
import { PREFETCH_ITEMS, PREFETCH_TOKENS } from './planner';

export interface BatchParagraph {
  key: string;
  source: { text: string };
  context: string;
  supplement: string;
  kind: 'feed' | 'document';
  unit: unknown;
}

export interface Candidate<P extends BatchParagraph> {
  p: P;
  rect: { top: number; bottom: number } | null;
  priority: 0 | 1 | null;
}

export interface Batch<P extends BatchParagraph> {
  paragraphs: P[];
  priority: 0 | 1;
}

interface BatchOptions {
  direction: number;
  firstBatch: boolean;
  state: (key: string) => Entry['state'] | undefined;
  active?: boolean;
  prefetchItems?: number;
  prefetchTokens?: number;
  firstItems?: number;
  firstTokens?: number;
  batchItems?: number;
  batchTokens?: number;
}

export function planBatches<P extends BatchParagraph>(input: readonly Candidate<P>[], options: BatchOptions) {
  const candidates = input.filter((value): value is Candidate<P> & { rect: NonNullable<Candidate<P>['rect']>; priority: 0 | 1 } => value.rect !== null && value.priority !== null);
  candidates.sort((a, b) => a.priority - b.priority || (options.direction > 0 ? a.rect.top - b.rect.top : b.rect.bottom - a.rect.bottom));
  const allowed = new Map<string, number>();
  let count = 0;
  let tokens = 0;
  // Shared related text is sent once per batch; count it once here as well.
  const prefetchNotes = new Set<string>();
  const cost = (p: P, notes: Set<string>) => estimateTokens(p.source.text) + (p.supplement && !notes.has(p.supplement) ? estimateTokens(p.supplement) : 0);
  for (const { p, priority } of candidates) {
    if (allowed.has(p.key)) continue;
    if (priority === 1) {
      const size = cost(p, prefetchNotes);
      if (count >= (options.prefetchItems ?? PREFETCH_ITEMS) || tokens + size > (options.prefetchTokens ?? PREFETCH_TOKENS)) continue;
      count++;
      tokens += size;
      if (p.supplement) prefetchNotes.add(p.supplement);
    }
    allowed.set(p.key, priority);
  }
  if (options.active === false) allowed.clear();

  const seen = new Set<string>();
  const waiting = candidates.filter(({ p }) => {
    if (!allowed.has(p.key) || options.state(p.key) !== 'waiting' || seen.has(p.key)) return false;
    seen.add(p.key);
    return true;
  });
  const batches: Batch<P>[] = [];
  let firstBatch = options.firstBatch;
  while (waiting.length) {
    const first = waiting.shift()!;
    const selected = [first.p];
    const notes = new Set<string>();
    let size = cost(first.p, notes);
    if (first.p.supplement) notes.add(first.p.supplement);
    const initial = firstBatch && first.priority === 0;
    const maxCount = initial ? options.firstItems ?? 3 : options.batchItems ?? 6;
    const maxTokens = initial ? options.firstTokens ?? 400 : options.batchTokens ?? 1200;
    for (let i = 0; i < waiting.length && selected.length < maxCount;) {
      const next = waiting[i]!;
      const p = next.p;
      const added = cost(p, notes);
      const compatible = p.kind === first.p.kind && p.context === first.p.context && (p.kind === 'feed' || p.unit === first.p.unit) && next.priority === first.priority;
      if (compatible && size + added <= maxTokens) {
        selected.push(p);
        size += added;
        if (p.supplement) notes.add(p.supplement);
        waiting.splice(i, 1);
      } else {
        i++;
      }
    }
    firstBatch = false;
    batches.push({ paragraphs: selected, priority: first.priority });
  }
  return { allowed, batches, firstBatch };
}
