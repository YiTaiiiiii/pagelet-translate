import { cacheKey, limitedText, EMPTY_USAGE, type BatchInput, type Scope, type SegmentResult } from '../shared/engine';
import { IDLE_STATE, type PageState } from '../shared/translation';
import type { DisplayMode } from '../shared/settings';
import { DEFAULT_LANGUAGES, languageCode, parseLanguages, type LanguagePair } from '../shared/languages';
import { BUILD_VERSION, RELOAD_EXTENSION } from '../shared/runtime';
import { composedParent, extract, openRoots, pageRoots, readingContext, visible, type Source } from './extract';
import { current, render, restore, retain, boundaryNodes, boundaryCurrent, setHint, type HintKind, type View } from './render';
import { OriginalPeek, type PeekTarget } from './peek';
import { ParagraphBar, type BarAction, type BarTarget } from './actions';
import { PageProgress } from './progress';
import { ReadingWindow } from './planner';
import { ResultCache, isSourceExtension, type Entry, type RecentIdentity } from './cache';
import { planBatches } from './batching';
import { sendPageRequest, type PageStartOptions } from '../shared/messages';

type Paragraph = View & { key: string; context: string; supplement: string; kind: 'feed' | 'document'; unitKey: string; unit: Element };
type Anchor = { p: Paragraph; top: number };
type Job = { sessionId: string; entries: Map<string, Entry>; keys: string[]; input: BatchInput; sent: boolean };
// Already in the target language (or clearly not the chosen source): skip
// before batching, so it takes no batch slot, prefetch budget or request.
async function skipLanguage(plain: string, pair: LanguagePair) {
  if (writtenIn(plain, pair.targetLanguage)) return true;
  try {
    const detected = await chrome.i18n.detectLanguage(plain);
    const best = detected?.languages[0];
    return !!(detected?.isReliable && best && best.percentage >= 80 &&
      (languageCode(best.language) === languageCode(pair.targetLanguage) ||
       (pair.sourceLanguage !== 'auto' && languageCode(best.language) !== languageCode(pair.sourceLanguage))));
  } catch { return false; }
}
// Chrome's detector calls Chinese posts full of product names (claude, codex,
// kimi) unreliable, which would send them to the model only to come back
// unchanged. For Chinese and Japanese targets the script itself decides: Han
// (plus kana for Japanese) clearly outweighing Latin words. Korean or kana in a
// Chinese target, or a quoted phrase inside English prose, does not count.
function writtenIn(plain: string, target: string) {
  const code = languageCode(target);
  if (code !== 'zh' && code !== 'ja') return false;
  const count = (pattern: RegExp) => plain.match(pattern)?.length ?? 0;
  const han = count(/\p{Script=Han}/gu), kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu), hangul = count(/\p{Script=Hangul}/gu);
  const words = count(/\p{Script=Latin}+/gu) + count(/[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Thai}\p{Script=Devanagari}]+/gu);
  if (hangul) return false;
  if (code === 'zh') return !kana && han >= 4 && han >= 2 * words;
  return kana >= 2 && han + kana >= 2 * words;
}
// The model sometimes returns text already in the target language with only
// punctuation width or spacing changed; that is the original, not a translation.
function sameText(a: string, b: string) {
  const plain = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').replace(/[。、]/g, m => (m === '。' ? '.' : ','));
  return plain(a) === plain(b);
}
// Unread counters such as "(3) Inbox" would otherwise change every cache key.
function pageTitle() { return document.title.replace(/^\s*\(\d+\+?\)\s*/, '').trim(); }
export class PageTranslation {
  state: PageState = { ...IDLE_STATE, usage: { ...EMPTY_USAGE } };
  private id = '';
  private pair: LanguagePair = DEFAULT_LANGUAGES;
  private mode: DisplayMode = 'bilingual';
  // Service identity from the start message: format, endpoint, model, thinking.
  private service = '';
  private scope: Scope = 'main';
  private paragraphs: Paragraph[] = [];
  private results = new ResultCache<HTMLElement>({
    cloneOutput: output => output.cloneNode(true) as HTMLElement,
    outputBytes: output => 2 * output.outerHTML.length,
  });
  private jobs = new Map<string, Job>();
  private window = new ReadingWindow();
  private settled: ReturnType<typeof setTimeout> | undefined;
  private planning = 0;
  private published = '';
  private acknowledged = '';
  private dirty = true;
  private roots: (Element | ShadowRoot)[] = [];
  private observer = new MutationObserver(records => this.mutated(records));
  private mutated(records: MutationRecord[]) {
    this.dirty = true;
    const added = this.addedFeedRoots(records);
    if (added.length) {
      // Only inspect the new prose boundaries in this microtask. Cached output
      // is attached before paint; the full scan and request plan stay coalesced.
      this.refreshParagraphs(added, false);
      this.schedule();
    } else if (this.paragraphs.some(p => p.lastOutput && (!current(p) || !boundaryCurrent(p) || (!p.output?.isConnected && !p.marker?.isConnected)))) {
      this.scan();
    } else {
      this.schedule();
    }
  }
  private peek = new OriginalPeek(target => this.peekTarget(target));
  private bar = new ParagraphBar(target => this.barTarget(target), (key, action) => this.paragraphAction(key, action));
  private progress = new PageProgress(() => this.retry());
  // Paragraphs the reader switched back to the original, and ones to translate again.
  private originals = new Set<string>();
  private fresh = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private applying: ReturnType<typeof setTimeout> | undefined;
  private firstBatch = true;
  constructor() {
    window.addEventListener('scroll', () => {
      this.window.scroll(scrollY, performance.now()); this.schedule();
      clearTimeout(this.settled); this.settled = setTimeout(() => this.schedule(), 190);
    }, { passive: true });
    window.addEventListener('resize', () => this.schedule(), { passive: true });
    document.addEventListener('visibilitychange', () => this.schedule());
  }
  private publish() {
    this.state.completed = this.paragraphs.filter(p => this.results.get(p.key)?.state === 'done' && this.results.get(p.key)?.text !== p.source.text && (p.output?.isConnected || p.marker?.isConnected)).length;
    const entries = new Set(this.paragraphs.map(p => this.results.get(p.key)));
    this.state.pending = [...entries].filter(e => e?.state === 'pending').length;
    const failed = [...entries].filter(e => e?.state === 'failed');
    this.state.failed = failed.length;
    if (!this.state.paused) this.state.error = failed[0]?.error || '';
    this.progress.update(this.state);
    // Scans run every 40 ms while scrolling; send only actual changes.
    const signature = JSON.stringify([this.id, this.state]);
    if (signature === this.published) return;
    this.published = signature;
    void sendPageRequest({ type: 'pagelet-state', version: BUILD_VERSION, sessionId: this.id, state: this.state }).catch(() => { this.published = ''; });
  }
  private observe() {
    this.observer.disconnect();
    if (!this.state.enabled) return;
    for (const tree of this.roots) if (tree.isConnected) this.observer.observe(tree, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden','aria-hidden','style','class','translate','contenteditable'] });
  }
  private schedule(delay = 40) {
    if (!this.state.enabled || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.scan(); }, delay);
  }
  private entry(key: string, source: Source, checks: Promise<void>[]) {
    if (this.results.has(key)) return;
    const entry: Entry = { state: 'checking' };
    this.results.set(key, entry);
    checks.push(skipLanguage(source.plain, this.pair).then(skip => {
      if (entry.state !== 'checking') return;
      if (skip) { entry.state = 'done'; entry.text = source.text; }
      else entry.state = 'waiting';
    }));
  }
  start(id: string, input: PageStartOptions) {
    const next = parseLanguages(input);
    const changed = this.id !== id || JSON.stringify(next) !== JSON.stringify(this.pair) || input.endpoint !== this.service;
    this.observer.disconnect();
    if (changed) {
      this.paragraphs.forEach(restore);
      this.paragraphs = [];
      for (const [key,entry] of this.results) if (entry.state === 'pending' || entry.state === 'checking') this.results.delete(key);
      this.jobs.clear();
    }
    this.id = id;
    this.pair = next;
    this.mode = input.mode;
    this.service = input.endpoint;
    this.dirty = true;
    this.published = ''; this.acknowledged = '';
    this.window.scroll(scrollY, performance.now());
    this.state.enabled = true;
    this.state.error = '';
    this.scan();
  }
  stop() {
    this.state.enabled = false;
    this.peek.hide(); this.bar.hide();
    this.originals.clear(); this.fresh.clear();
    clearTimeout(this.timer);
    clearTimeout(this.settled);
    clearTimeout(this.applying); this.applying = undefined;
    this.timer = undefined;
    this.planning++;
    this.acknowledged = '';
    this.observer.disconnect();
    for (const paragraph of this.paragraphs) {
      restore(paragraph);
      paragraph.lastOutput = undefined;
    }
    this.results.clearRecent();
    this.publish();
  }
  reset() {
    this.stop(); this.results.clear(); this.jobs.clear(); this.paragraphs = []; this.window = new ReadingWindow();
    this.planning++; this.firstBatch = true; this.state = { ...IDLE_STATE, usage: { ...EMPTY_USAGE } };
  }
  route() {
    this.dirty = true;
    this.schedule();
  }
  setMode(mode: DisplayMode) {
    this.mode = mode;
    this.peek.hide(); this.bar.hide();
    for (const p of this.paragraphs) if (p.provisional && p.lastOutput) retain(p, p.lastOutput, mode, this.pair.targetLanguage);
    this.apply();
  }
  setScope(scope: Scope) {
    this.observer.disconnect(); this.paragraphs.forEach(restore); this.paragraphs = []; this.dirty = true; this.scope = scope; this.state.scope = scope;
    if (this.state.enabled) this.scan();
  }
  retry() {
    for (const entry of this.results.values()) if (entry.state === 'failed') { entry.state = 'waiting'; delete entry.error; }
    this.state.error = ''; this.state.paused = false; this.schedule(); this.publish();
  }
  private retryOne(key: string) {
    const entry = this.results.get(key);
    if (!this.state.enabled || entry?.state !== 'failed') return;
    entry.state = 'waiting'; delete entry.error;
    this.apply();
    this.schedule(0);
  }
  pause(error: string) { this.state.paused = true; this.state.error = error; this.publish(); }
  usage(usage: NonNullable<PageState['usage']>) { this.state.usage = usage; this.publish(); }
  receive(jobId: string, result: SegmentResult) {
    const job = this.jobs.get(jobId), entry = job?.entries.get(result.id);
    if (!entry || job?.sessionId !== this.id || entry.state === 'done') return;
    if (result.text !== undefined) {
      const sent = job.input.items.find(item => item.id === result.id)?.text;
      entry.state = 'done'; entry.kept = sent !== undefined && sameText(result.text, sent);
      entry.text = entry.kept ? sent : result.text;
    }
    else { entry.state = 'failed'; entry.error = result.error; this.state.error = result.error || ''; }
    this.applySoon();
  }
  // Streamed paragraphs that arrive together are inserted in one frame, so the
  // page moves once instead of once per paragraph.
  private applySoon() {
    if (this.applying) return;
    const run = () => { if (!this.applying) return; clearTimeout(this.applying); this.applying = undefined; this.apply(); };
    this.applying = setTimeout(run, 100);
    requestAnimationFrame(run);
  }
  private apply() {
    clearTimeout(this.applying); this.applying = undefined;
    this.observer.disconnect();
    const changed = new Set<Element>();
    // Measure the paragraph being read only before the first change we make.
    let anchor: Anchor | null | undefined;
    const mark = () => { if (anchor === undefined) anchor = this.readingAnchor(); };
    for (const p of this.paragraphs) {
      const entry = this.results.get(p.key);
      if (!this.state.enabled || !current(p) || !this.readable(p)) { if (p.hint) { mark(); setHint(p, null); } continue; }
      if (this.originals.has(p.key)) {
        if (p.output || p.marker || p.hint) { mark(); restore(p); changed.add(p.source.parent); }
        continue;
      }
      if (!boundaryCurrent(p)) {
        if (p.hint) { mark(); setHint(p, null); }
        this.dirty = true;
        this.schedule();
        continue;
      }
      if (entry?.state === 'done' && entry.text !== undefined && entry.text !== p.source.text) {
        const shown = this.mode === 'bilingual' ? p.output?.isConnected : p.marker?.isConnected;
        if (!shown || p.provisional) {
          mark();
          try {
            if (render(p, entry.text, this.mode, this.pair.targetLanguage)) {
              changed.add(p.source.parent);
              this.results.touch(p.key);
              if (p.lastOutput) this.results.rememberRecent(this.identity(p), p.source.plain, p.lastOutput);
            }
          } catch {
            restore(p);
            entry.state = 'failed';
            entry.error = '译文无法回填，已保留原文。';
            this.state.error = entry.error;
          }
        }
      } else if (!p.provisional && (p.output || p.marker)) {
        mark();
        restore(p);
        changed.add(p.source.parent);
      }
      if (this.wantedHint(p) !== this.shownHint(p)) mark();
      this.hint(p);
    }
    if (anchor) this.keepReading(anchor);
    for (const p of this.paragraphs) if (p.kind === 'feed' && changed.has(p.source.parent)) p.boundary = boundaryNodes(p.source.parent);
    this.trimCache();
    this.observe();
    this.publish();
  }
  private wantedHint(p: Paragraph): HintKind {
    const entry = this.results.get(p.key);
    if (entry?.state === 'failed') return 'failed';
    return entry?.state === 'pending' && !p.provisional && !p.output?.isConnected && !p.marker?.isConnected ? 'pending' : null;
  }
  private shownHint(p: Paragraph): HintKind {
    return p.hint?.isConnected ? p.hint.getAttribute('data-pagelet-hint') as HintKind : null;
  }
  // Where the paragraph currently shown starts: its translation in
  // translation-only mode, otherwise its original nodes.
  private shownRect(p: Paragraph) {
    const nodes = p.marker?.isConnected ? p.nodes : p.source.nodes;
    const first = nodes?.[0], last = nodes?.at(-1);
    if (!first?.parentNode || !last?.parentNode || !first.isConnected) return null;
    const range = document.createRange();
    range.setStartBefore(first); range.setEndAfter(last);
    const rect = rangeBox(range);
    return rect && (rect.width || rect.height) ? rect : null;
  }
  // The paragraph under the reading line (upper third of the window).
  private readingAnchor(): Anchor | null {
    const line = innerHeight * .3;
    let best: Anchor | null = null, distance = Infinity;
    for (const p of this.paragraphs) {
      if (!current(p) || !this.readable(p)) continue;
      const rect = this.shownRect(p);
      if (!rect || rect.bottom <= 0 || rect.top >= innerHeight) continue;
      const gap = rect.top <= line && rect.bottom >= line ? 0 : Math.min(Math.abs(rect.top - line), Math.abs(rect.bottom - line));
      if (gap < distance) { best = { p, top: rect.top }; distance = gap; }
      if (!gap) break;
    }
    return best;
  }
  // Text inserted above the paragraph being read pushes it down; scroll by
  // the same amount so it stays where the reader's eyes are. At the very top
  // of a page the reader starts from the top, so nothing is pinned.
  private keepReading({ p, top }: Anchor) {
    const rect = this.shownRect(p);
    const delta = rect ? rect.top - top : 0;
    if (Math.abs(delta) < 1) return;
    const scroller = this.scroller(p.source.parent);
    const before = scroller ? scroller.scrollTop : scrollY;
    if (before <= 0) return;
    if (scroller) scroller.scrollBy({ top: delta, behavior: 'instant' });
    else window.scrollBy({ top: delta, behavior: 'instant' });
    if (!scroller) this.window.shift(scrollY - before);
  }
  // The nearest scrolling box; null means the page itself scrolls.
  private scroller(element: Element) {
    for (let current = composedParent(element); current && current !== document.body && current !== document.documentElement; current = composedParent(current)) {
      if (current.scrollHeight > current.clientHeight && /^(auto|scroll|overlay)$/.test(getComputedStyle(current).overflowY)) return current;
    }
    return null;
  }
  // A "⋯" can wrap onto a new line, so markers above the reader move the text
  // just like translations do.
  private updateHints(list: Paragraph[]) {
    const anchor = list.some(p => this.wantedHint(p) !== this.shownHint(p)) ? this.readingAnchor() : null;
    for (const p of list) this.hint(p);
    if (anchor) this.keepReading(anchor);
  }
  private hint(p: Paragraph) {
    setHint(p, this.wantedHint(p), this.results.get(p.key)?.error || '翻译失败，点击重试。', () => this.retryOne(p.key));
  }
  // Change our own markers without echoing them through the observer, while
  // still handling any page mutation that was queued before the change.
  private quietly(change: () => void) {
    if (!this.state.enabled) return;
    const records = this.observer.takeRecords();
    this.observer.disconnect();
    change();
    this.observe();
    if (records.length) this.mutated(records);
  }
  private paragraphAction(key: string, action: BarAction) {
    if (!this.state.enabled) return;
    if (action === 'original') {
      if (!this.originals.delete(key)) this.originals.add(key);
    } else {
      const entry = this.results.get(key);
      if (!entry || entry.state !== 'done') return;
      // Keep the current translation on screen until the new one replaces it.
      for (const p of this.paragraphs) if (p.key === key && (p.output?.isConnected || p.marker?.isConnected)) p.provisional = true;
      entry.state = 'waiting'; delete entry.text; delete entry.error; delete entry.kept;
      this.fresh.add(key);
    }
    this.apply();
    this.schedule(0);
  }
  private barTarget(target: Element): BarTarget | null {
    if (!this.state.enabled || target.closest('[data-pagelet-hint]')) return null;
    const hits = this.paragraphs.filter(p => (p.output?.contains(target) || p.source.parent.contains(target)) && (p.output?.isConnected || p.marker?.isConnected || this.originals.has(p.key) || this.results.get(p.key)?.kept) && this.readable(p));
    if (!hits.length) return null;
    const anchor = hits.reduce((a, b) => a.source.parent.contains(b.source.parent) ? b : a).source.parent;
    const same = hits.filter(p => p.source.parent === anchor || p.output?.contains(target));
    const exact = same.find(p => p.output?.contains(target) || (p.marker?.isConnected ? p.nodes : p.source.nodes)?.some(node => node === target || node.contains(target)));
    const p = exact ?? (same.length === 1 ? same[0] : undefined);
    if (!p) return null;
    return { key: p.key, anchor: p.source.parent, original: this.originals.has(p.key), kept: !!this.results.get(p.key)?.kept && !p.output?.isConnected && !p.marker?.isConnected };
  }
  private peekTarget(target: Element): PeekTarget | null {
    if (!this.state.enabled || this.mode !== 'translated' || target.closest('[data-pagelet-hint]')) return null;
    const hits = this.paragraphs.filter(p => p.marker?.isConnected && p.source.parent.contains(target));
    if (!hits.length) return null;
    const anchor = hits.reduce((a, b) => a.source.parent.contains(b.source.parent) ? b : a).source.parent;
    const same = hits.filter(p => p.source.parent === anchor);
    const exact = same.find(p => p.nodes?.some(node => node === target || node.contains(target)));
    return { anchor, text: (exact ? [exact] : same).map(p => p.source.plain).join('\n\n') };
  }
  private bounds(source: Source) {
    const first = source.nodes[0], last = source.nodes.at(-1);
    if (!first || !last || !first.parentNode || !last.parentNode) return null;
    const range = document.createRange();
    range.setStartBefore(first); range.setEndAfter(last);
    return rangeBox(range);
  }
  private identity(p: Paragraph): RecentIdentity {
    return { unitKey: p.unitKey, pair: this.pair, endpoint: this.service, context: p.context, supplement: p.supplement };
  }
  private readable(p: Paragraph) {
    return !p.source.parent.closest('[aria-hidden="true"],[hidden]') && visible(p.source.parent);
  }
  private addedFeedRoots(records: MutationRecord[]) {
    if (!/(^|\.)(x|twitter)\.com$/.test(location.hostname)) return [];
    const roots = new Set<Element>();
    const selector = '[data-testid="tweetText"]';
    for (const record of records) {
      if (record.type !== 'childList') continue;
      for (const node of record.addedNodes) {
        if (!node.isConnected) continue;
        const element = node instanceof Element ? node : node.parentElement;
        if (!element || element.closest('[data-pagelet-output]')) continue;
        const body = element.closest(selector);
        if (body) roots.add(body);
        for (const nested of element.querySelectorAll(selector)) roots.add(nested);
      }
    }
    return [...roots];
  }
  private refreshParagraphs(roots: Element[], full: boolean) {
    if (!this.state.enabled) return;
    this.observer.disconnect();
    const scanRoots = new Set(roots);
    const retained: Paragraph[] = [];
    const checks: Promise<void>[] = [];
    this.paragraphs = this.paragraphs.filter(p => {
      const intact = current(p) && boundaryCurrent(p);
      // A photo dialog hides the underlying timeline without replacing it.
      // Hidden prose is empty to extraction, not a new post or new context.
      if (intact && !this.readable(p)) return true;
      const sameIdentity = p.kind !== 'feed' || readingContext(p.source.parent, this.scope).unitKey === p.unitKey;
      if (intact && sameIdentity) return true;
      if (p.lastOutput && (sameIdentity || !p.source.parent.isConnected)) retained.push(p);
      if (!full && p.source.parent.isConnected) scanRoots.add(p.source.parent.closest('[data-testid="tweetText"]') ?? p.source.parent);
      restore(p);
      return false;
    });
    if (full) for (const p of this.paragraphs) {
      if (!this.readable(p)) continue;
      const info = readingContext(p.source.parent, this.scope);
      if (info.kind !== 'feed') continue;
      const supplement = limitedText(info.related ?? '', 200);
      const key = cacheKey(p.source.text, '', supplement, this.pair, this.service);
      if (key !== p.key) {
        const display = p.lastOutput;
        restore(p);
        p.key = key;
        p.supplement = supplement;
        if (display) retain(p, display, this.mode, this.pair.targetLanguage);
        this.entry(key, p.source, checks);
      }
      p.unitKey = info.unitKey ?? '';
      p.unit = info.unit;
    }
    const occupied = new Set(this.paragraphs.flatMap(p => [...p.source.nodes,...(p.nodes ?? []),...(p.output ? [p.output] : [])]));
    const found = extract([...scanRoots], this.scope, occupied);
    if (full) {
      this.roots = openRoots(document.body);
      this.dirty = false;
    }
    for (const item of found) {
      const { source } = item;
      const kind = item.kind ?? 'document';
      // Only explicit related prose is supplementary context. Do not copy the
      // paragraph itself or unrelated neighbours into every request.
      const headings = [...this.paragraphs, ...found].filter(p => p.unit === item.unit && /^H[1-6]$/.test(p.source.parent.tagName) && p.source.parent !== source.parent && !!(p.source.parent.compareDocumentPosition(source.parent) & Node.DOCUMENT_POSITION_FOLLOWING));
      // The page title is shared by the whole document; the section heading
      // is a per-item note, so paragraphs of different sections can share a batch.
      const heading = /^H[1-6]$/.test(source.parent.tagName) ? '' : headings.at(-1)?.source.plain ?? '';
      const context = kind === 'feed' ? '' : limitedText(pageTitle(), 120);
      const supplement = kind === 'feed' ? limitedText(item.related ?? '', 200) : limitedText(heading, 60);
      const unitKey = item.unitKey ?? '';
      const key = cacheKey(source.text, context, supplement, this.pair, this.service);
      this.entry(key, source, checks);
      const paragraph: Paragraph = { source, key, context, supplement, kind, unitKey, unit: item.unit };
      if (kind === 'feed') paragraph.boundary = boundaryNodes(source.parent);
      const entry = this.results.get(key)!;
      if (entry.state !== 'done') {
        const recent = this.results.recentExtension(this.identity(paragraph), source.plain);
        const previous = retained.find(p => p.kind === 'feed' && p.unitKey === unitKey && p.context === context && p.supplement === supplement && !unitKey.includes('text:') && isSourceExtension(p.source.plain, source.plain));
        const output = recent ?? previous?.lastOutput;
        if (output) retain(paragraph, output, this.mode, this.pair.targetLanguage);
      }
      this.paragraphs.push(paragraph);
      this.results.touch(key);
    }
    if (checks.length) {
      // Plan once every check from this scan has finished, so the first batch
      // is not split by detections that resolve one at a time.
      const id = this.id;
      void Promise.all(checks).then(() => { if (id === this.id) this.schedule(0); });
    }
    this.apply();
  }
  private scan() {
    if (!this.state.enabled) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => this.schedule(), { once: true });
      return;
    }
    this.refreshParagraphs(this.dirty ? pageRoots(this.scope) : [], this.dirty);
    const now = performance.now();
    const candidates = this.paragraphs.map(p => {
      // Rendered paragraphs still count toward the speculative window budget;
      // paragraphs already in the target language do not.
      const result = this.results.get(p.key);
      const same = result?.state === 'done' && result.text === p.source.text;
      const rect = same || !this.readable(p) || this.originals.has(p.key) ? null : p.marker || p.output ? p.source.parent.getBoundingClientRect() : this.bounds(p.source);
      return { p, rect, priority: rect ? this.window.priority(rect, innerHeight, now) : null };
    });
    const plan = planBatches(candidates, {
      direction: this.window.direction,
      firstBatch: this.firstBatch,
      state: key => this.results.get(key)?.state,
      active: !this.state.paused,
    });
    this.firstBatch = plan.firstBatch;
    for (const batch of plan.batches) this.prepare(batch.paragraphs, batch.priority);
    if (plan.batches.length) this.quietly(() => this.updateHints(this.paragraphs.filter(p => current(p) && this.readable(p))));
    const { allowed } = plan;
    const jobs = [...this.jobs].flatMap(([id,job]) => {
      const priorities = job.keys.filter(key => allowed.has(key)).map(key => allowed.get(key)!);
      return priorities.length ? [{ id, priority: Math.min(...priorities) }] : [];
    });
    const sessionId = this.id;
    const signature = JSON.stringify([sessionId, jobs]);
    // The background already holds this exact plan and nothing waits to be sent.
    if (signature === this.acknowledged && [...this.jobs.values()].every(job => job.sent)) {
      this.trimCache();
      this.publish();
      return;
    }
    const revision = ++this.planning;
    // Acknowledge the latest plan before dispatch, so stale asynchronous sends
    // cannot enter the queue after a quick scroll or a direction change.
    void sendPageRequest({ type: 'pagelet-plan', version: BUILD_VERSION, sessionId, jobs }).then(reply => {
      if (sessionId !== this.id || revision !== this.planning || !reply?.ok) return;
      this.acknowledged = signature;
      const wanted = new Set(jobs.map(job => job.id));
      for (const [id,job] of this.jobs) if (!job.sent) {
        if (wanted.has(id)) this.dispatch(id, job);
        else {
          for (const entry of job.entries.values()) if (entry.state === 'pending') entry.state = 'waiting';
          this.jobs.delete(id);
        }
      }
      this.quietly(() => this.updateHints(this.paragraphs.filter(p => p.hint)));
    }).catch(() => {});
    this.trimCache();
    this.publish();
  }
  private trimCache() {
    this.results.trim(new Set(this.paragraphs.map(p => p.key)));
  }
  private prepare(paragraphs: Paragraph[], priority: number) {
    const jobId = crypto.randomUUID();
    const entries = new Map<string, Entry>();
    const units = new Map<string, string>();
    const input: BatchInput = { context: paragraphs[0]!.context, priority, items: paragraphs.map((p,i) => {
      const id = 's' + i;
      const entry = this.results.get(p.key)!;
      entry.state = 'pending';
      entries.set(id, entry);
      const identity = p.unitKey || p.key;
      if (!units.has(identity)) units.set(identity, 'u' + units.size);
      return { id, text:p.source.text, supplement:p.supplement, ...(p.kind === 'feed' ? { unit: units.get(identity)! } : {}) };
    }) };
    if (paragraphs.filter(p => this.fresh.delete(p.key)).length) input.fresh = true;
    this.jobs.set(jobId, { sessionId: this.id, entries, keys: paragraphs.map(p => p.key), input, sent: false });
  }
  private dispatch(jobId: string, job: Job) {
    job.sent = true;
    const { sessionId, entries, input } = job;
    const started = performance.now();
    void sendPageRequest<SegmentResult[]>({ type: 'pagelet-translate', version: BUILD_VERSION, sessionId, jobId, input }).then(reply => {
      if (sessionId !== this.id) return;
      if (!reply?.ok) {
        for (const entry of entries.values()) if (entry.state === 'pending') {
          entry.state = reply?.unsent ? 'waiting' : 'failed';
          entry.error = reply?.error || '后台连接中断，用量未知；请手动重试。';
        }
        if (!reply?.unsent) this.state.error = reply?.error || '后台连接中断，用量未知；请手动重试。';
      } else if (reply.version !== BUILD_VERSION) throw new Error(RELOAD_EXTENSION);
      else {
        this.window.completed(performance.now() - started);
        reply.data.forEach(result => this.receive(jobId, result));
      }
    }).catch(error => {
      if (sessionId !== this.id) return;
      const message = error instanceof Error ? error.message : '后台连接中断，用量未知；请手动重试。';
      for (const entry of entries.values()) if (entry.state === 'pending') {
        entry.state = 'failed';
        entry.error = message;
      }
      this.state.error = message;
    }).finally(() => {
      if (sessionId !== this.id) return;
      this.jobs.delete(jobId);
      this.apply();
      this.schedule();
    });
  }
}

// Where a paragraph is on screen. Screen-reader-only text inside it is moved
// far off the page (Wikipedia's "Jump up to:") or shrunk to a pixel; counting it
// would stretch the box across the whole page and make far paragraphs look
// visible. The common case has nothing off the page and needs one rectangle.
function rangeBox(range: Range): DOMRect | null {
  const whole = range.getBoundingClientRect();
  if (whole.top + scrollY >= -1 && whole.left + scrollX >= -1) return whole;
  let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
  for (const r of range.getClientRects()) {
    if (r.width <= 1 || r.height <= 1 || r.bottom + scrollY < 0 || r.right + scrollX < 0) continue;
    top = Math.min(top, r.top); left = Math.min(left, r.left); bottom = Math.max(bottom, r.bottom); right = Math.max(right, r.right);
  }
  return top === Infinity ? null : new DOMRect(left, top, right - left, bottom - top);
}
