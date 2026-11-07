import { browser } from 'wxt/browser';

const INDEX = 'pagelet.memo.index';
const ENTRY = 'pagelet.memo:';

// Finished translations shared by every tab until the browser closes.
// storage.session stays in memory, survives worker restarts and is limited to
// trusted extension contexts. Values are translated text only; keys are hashes.
export class TranslationMemo {
  private index = new Map<string, number>();
  private ready: Promise<void>;
  private write = Promise.resolve();
  constructor(private maxBytes = 3 * 1024 * 1024, private maxEntries = 2000) {
    this.ready = browser.storage.session.get(INDEX).then(saved => {
      const list = saved[INDEX];
      if (Array.isArray(list)) for (const item of list) {
        if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number') this.index.set(item[0], item[1]);
      }
    }).catch(() => {});
  }
  static async hash(key: string) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
    return [...digest.slice(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async get(hashes: string[]): Promise<Map<string, string>> {
    await this.ready;
    const known = hashes.filter(hash => this.index.has(hash));
    const found = new Map<string, string>();
    if (!known.length) return found;
    const saved = await browser.storage.session.get(known.map(hash => ENTRY + hash)).catch(() => ({} as Record<string, unknown>));
    for (const hash of known) {
      const text = saved[ENTRY + hash];
      if (typeof text !== 'string') continue;
      found.set(hash, text);
      const bytes = this.index.get(hash)!;
      this.index.delete(hash); this.index.set(hash, bytes);
    }
    return found;
  }
  put(entries: [hash: string, text: string][]) {
    if (!entries.length) return this.write;
    this.write = this.write.catch(() => {}).then(async () => {
      await this.ready;
      const values: Record<string, unknown> = {};
      for (const [hash, text] of entries) {
        this.index.delete(hash); this.index.set(hash, 2 * text.length + 64);
        values[ENTRY + hash] = text;
      }
      let bytes = 0;
      for (const size of this.index.values()) bytes += size;
      const removed: string[] = [];
      for (const [hash, size] of this.index) {
        if (this.index.size <= this.maxEntries && bytes <= this.maxBytes) break;
        this.index.delete(hash); bytes -= size;
        removed.push(ENTRY + hash); delete values[ENTRY + hash];
      }
      values[INDEX] = [...this.index];
      if (removed.length) await browser.storage.session.remove(removed);
      await browser.storage.session.set(values);
    });
    return this.write;
  }
  clear() {
    this.write = this.write.catch(() => {}).then(async () => {
      await this.ready;
      const keys = [INDEX, ...[...this.index.keys()].map(hash => ENTRY + hash)];
      this.index.clear();
      await browser.storage.session.remove(keys);
    });
    return this.write;
  }
}
