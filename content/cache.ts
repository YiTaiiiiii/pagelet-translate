import { PROMPT_VERSION } from '../shared/engine';
import { parseLanguages, type LanguagePair } from '../shared/languages';
import { CACHE_BYTES, CACHE_ENTRIES } from './planner';

export type Entry = {
  // checking: local language detection runs before the paragraph can be batched.
  state: 'checking' | 'waiting' | 'pending' | 'done' | 'failed';
  text?: string;
  error?: string;
  // The model returned the paragraph unchanged (a name, or text it judged
  // already fine); not the same as local detection skipping it.
  kept?: boolean;
};

export interface RecentIdentity {
  unitKey: string;
  pair: LanguagePair;
  // Service identity: format, endpoint, model and thinking.
  endpoint: string;
  context: string;
  supplement: string;
}

interface Recent<T> {
  sourcePlain: string;
  output: T;
  outputBytes: number;
}

interface CacheOptions<T> {
  cloneOutput: (output: T) => T;
  outputBytes: (output: T) => number;
  maxEntries?: number;
  maxBytes?: number;
}

type Record<T> = { kind: 'result'; key: string; entry: Entry } | { kind: 'recent'; key: string; recent: Recent<T> };

function recentKey(identity: RecentIdentity) {
  if (!/^x:\d+$/.test(identity.unitKey)) return undefined;
  return JSON.stringify([
    PROMPT_VERSION,
    identity.unitKey,
    parseLanguages(identity.pair),
    identity.endpoint,
    identity.context,
    identity.supplement,
  ]);
}

export function isSourceExtension(previous: string, next: string) {
  const original = previous.replace(/(?:\s|…|\.\.\.)+$/gu, '').trim();
  const full = next.trim();
  return original.length >= 16 && full.length > original.length && full.startsWith(original);
}

// Output cloning and measurement are supplied by the renderer. No page nodes,
// paragraphs or other page ownership are stored here.
export class ResultCache<T> {
  private results = new Map<string, Entry>();
  private records = new Map<string, Record<T>>();
  private maxEntries: number;
  private maxBytes: number;

  constructor(private options: CacheOptions<T>) {
    this.maxEntries = options.maxEntries ?? CACHE_ENTRIES;
    this.maxBytes = options.maxBytes ?? CACHE_BYTES;
  }

  get size() {
    return this.results.size;
  }

  get recordCount() {
    return this.records.size;
  }

  get bytes() {
    let total = 0;
    for (const record of this.records.values()) total += this.recordBytes(record);
    return total;
  }

  get(key: string) {
    return this.results.get(key);
  }

  has(key: string) {
    return this.results.has(key);
  }

  set(key: string, entry: Entry) {
    this.results.set(key, entry);
    const id = 'result:' + key;
    this.records.delete(id);
    this.records.set(id, { kind: 'result', key, entry });
    return this;
  }

  touch(key: string) {
    const id = 'result:' + key;
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    this.records.set(id, record);
  }

  delete(key: string) {
    this.records.delete('result:' + key);
    return this.results.delete(key);
  }

  clear() {
    this.results.clear();
    this.records.clear();
  }

  values() {
    return this.results.values();
  }

  [Symbol.iterator]() {
    return this.results[Symbol.iterator]();
  }

  rememberRecent(identity: RecentIdentity, sourcePlain: string, output: T) {
    const key = recentKey(identity);
    if (!key) return;
    const cloned = this.options.cloneOutput(output);
    const recent = { sourcePlain, output: cloned, outputBytes: this.options.outputBytes(cloned) };
    const id = 'recent:' + key;
    this.records.delete(id);
    this.records.set(id, { kind: 'recent', key, recent });
  }

  recentExtension(identity: RecentIdentity, sourcePlain: string): T | undefined {
    const key = recentKey(identity);
    if (!key) return undefined;
    const id = 'recent:' + key;
    const record = this.records.get(id);
    if (record?.kind !== 'recent' || !isSourceExtension(record.recent.sourcePlain, sourcePlain)) return undefined;
    this.records.delete(id);
    this.records.set(id, record);
    return this.options.cloneOutput(record.recent.output);
  }

  clearRecent() {
    for (const [id, record] of this.records) {
      if (record.kind === 'recent') this.records.delete(id);
    }
  }

  trim(attached: ReadonlySet<string>) {
    let bytes = this.bytes;
    for (const [id, record] of this.records) {
      if (this.records.size <= this.maxEntries && bytes <= this.maxBytes) break;
      if (record.kind === 'result' && (record.entry.state === 'pending' || attached.has(record.key))) continue;
      this.records.delete(id);
      if (record.kind === 'result') this.results.delete(record.key);
      bytes -= this.recordBytes(record);
    }
  }

  private recordBytes(record: Record<T>) {
    if (record.kind === 'recent') {
      return 2 * (record.key.length + record.recent.sourcePlain.length) + record.recent.outputBytes;
    }
    return 2 * (record.key.length + (record.entry.text?.length ?? 0) + (record.entry.error?.length ?? 0));
  }
}
