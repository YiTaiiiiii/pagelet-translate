import type { LanguagePair } from './languages';
export const USAGE_KEY = 'pagelet.usage.v1';
export const USAGE_LIMIT = 100;
export interface RequestUsage {
  startedAt: number;
  durationMs: number;
  firstContentMs?: number | null;
  status: 'ok' | 'error' | 'cancelled';
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheMissTokens: number | null;
  averageTps: number | null;
}
export interface UsageRecord extends RequestUsage, LanguagePair { id: string; kind: 'translation' | 'connection' }
export type UsageRecorder = (sample: RequestUsage) => void | Promise<void>;
function count(value: unknown) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
export function requestUsage(data: unknown, startedAt: number, durationMs: number, status: RequestUsage['status'], httpStatus: number | null): RequestUsage {
  const usage = (data as { usage?: Record<string, unknown> } | null)?.usage;
  // Anthropic counts uncached input apart from cache reads and cache writes;
  // all three are input the request was billed for.
  const anthropic = usage?.prompt_tokens === undefined && usage?.input_tokens !== undefined;
  const uncached = count(usage?.input_tokens), written = count(usage?.cache_creation_input_tokens);
  const inputTokens = anthropic ? (uncached === null ? null : uncached + (count(usage?.cache_read_input_tokens) ?? 0) + (written ?? 0)) : count(usage?.prompt_tokens);
  const outputTokens = count(anthropic ? usage?.output_tokens : usage?.completion_tokens);
  const cacheReadTokens = anthropic ? count(usage?.cache_read_input_tokens) : count(usage?.prompt_cache_hit_tokens) ?? count((usage?.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens);
  const cacheMissTokens = count(usage?.prompt_cache_miss_tokens) ?? (inputTokens !== null && cacheReadTokens !== null ? Math.max(0, inputTokens - cacheReadTokens) : null);
  return { startedAt, durationMs, status, httpStatus, inputTokens, outputTokens, totalTokens: count(usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null), cacheReadTokens, cacheMissTokens, averageTps: outputTokens !== null && durationMs > 0 ? outputTokens * 1000 / durationMs : null };
}
