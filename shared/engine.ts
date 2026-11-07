import { parseLanguages, type LanguagePair } from './languages';
import type { Settings } from './settings';

export type Scope = 'main' | 'all';
export interface SegmentInput { id: string; text: string; supplement: string; unit?: string }
// fresh: the reader asked to translate again, so skip finished results.
export interface BatchInput { context: string; items: SegmentInput[]; priority: number; fresh?: boolean }
export interface SegmentResult { id: string; text?: string; error?: string }
export interface PageUsage { requests: number; input: number; output: number; hit: number; unknown: number }
export const EMPTY_USAGE: PageUsage = { requests: 0, input: 0, output: 0, hit: 0, unknown: 0 };
export const PROMPT_VERSION = 'paragraph-v7';

// A conservative scheduling estimate, never a substitute for provider usage.
export function estimateTokens(text: string) {
  const latin = text.match(/[\x00-\x7f]/g)?.length ?? 0;
  return Math.ceil(latin / 3 + (text.length - latin) * 1.5);
}
export function limitedText(text: string, tokens: number) {
  let end = text.length;
  while (end && estimateTokens(text.slice(0, end)) > tokens) end = Math.max(0, Math.floor(end * .85));
  return text.slice(0, end);
}
export function parseBatch(value: unknown): BatchInput {
  const batch = value as BatchInput;
  if (!batch || typeof batch.context !== 'string' || batch.context.length > 6000 || !Array.isArray(batch.items) || !batch.items.length || batch.items.length > 6) throw new Error('翻译批次格式不正确。');
  const seen = new Set<string>();
  const items = batch.items.map(item => {
    if (!item || typeof item.id !== 'string' || !/^s\d+$/.test(item.id) || seen.has(item.id) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 32000 || typeof item.supplement !== 'string' || item.supplement.length > 3000) throw new Error('翻译段落格式不正确。');
    seen.add(item.id); parseInline(item.text);
    if (item.unit !== undefined && (typeof item.unit !== 'string' || item.unit.length > 120)) throw new Error('翻译批次格式不正确。');
    return { id: item.id, text: item.text, supplement: item.supplement, ...(item.unit ? { unit: item.unit } : {}) };
  });
  return { context: batch.context, items, priority: batch.priority === 0 ? 0 : 1, ...(batch.fresh === true ? { fresh: true } : {}) };
}

export type InlinePart = string | { kind: 'i' | 'k'; id: number; children: InlinePart[] };
export function escapeText(text: string) { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
export function unescapeText(text: string) { return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'); }
export function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const stack: { key: string; children: InlinePart[] }[] = [{ key: '', children: parts }];
  const seen = new Set<string>();
  let cursor = 0;
  for (const match of text.matchAll(/<(\/?)([ik])(\d+)>/g)) {
    const parent = stack.at(-1)!;
    if (match.index! > cursor) parent.children.push(unescapeText(text.slice(cursor, match.index)));
    const key = match[2]! + match[3]!;
    if (match[1]) {
      if (stack.length === 1 || parent.key !== key) throw new Error('行内格式未闭合。');
      stack.pop();
    } else {
      if (seen.has(key) || seen.size >= 300) throw new Error('行内编号重复或过多。');
      seen.add(key);
      const part = { kind: match[2] as 'i' | 'k', id: Number(match[3]), children: [] as InlinePart[] };
      parent.children.push(part); stack.push({ key, children: part.children });
    }
    cursor = match.index! + match[0].length;
  }
  stack.at(-1)!.children.push(unescapeText(text.slice(cursor)));
  if (stack.length !== 1) throw new Error('行内格式未闭合。');
  return parts;
}
export function inlineShape(text: string) {
  const shape: string[] = [];
  function walk(parts: InlinePart[], parent: string) {
    for (const part of parts) if (typeof part !== 'string') {
      const key = part.kind + part.id;
      shape.push(key + ':' + parent + (part.kind === 'k' ? ':' + JSON.stringify(part.children) : ''));
      walk(part.children, key);
    }
  }
  walk(parseInline(text), ''); return shape.sort().join('|');
}
function serializeInline(parts: InlinePart[]): string {
  return parts.map(part => typeof part === 'string'
    ? escapeText(part)
    : `<${part.kind}${part.id}>${serializeInline(part.children)}</${part.kind}${part.id}>`
  ).join('');
}
function injectKept(parts: InlinePart[], id: number, target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  const pattern = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (typeof part === 'string') {
      const exact = part.indexOf(target);
      const match = exact !== -1 ? { index: exact, length: target.length } : (() => {
        const m = pattern.exec(part);
        return m ? { index: m.index, length: m[0].length } : null;
      })();
      if (match) {
        const before = part.slice(0, match.index), after = part.slice(match.index + match.length);
        const replacement: InlinePart[] = [];
        if (before) replacement.push(before);
        replacement.push({ kind: 'k', id, children: [target] });
        if (after) replacement.push(after);
        parts.splice(i, 1, ...replacement);
        return true;
      }
    } else if (part.kind === 'i' && injectKept(part.children, id, target)) return true;
  }
  return false;
}
export function reconcileInline(sourceText: string, translatedText: string): string {
  try {
    if (inlineShape(sourceText) === inlineShape(translatedText)) return translatedText;
  } catch { /* fall through to tolerant reconciliation */ }
  const srcParts = parseInline(sourceText);
  const validI = new Set<number>();
  const validK = new Map<number, string>();
  const leadingK = new Set<number>();
  const trailingK = new Set<number>();
  function collect(parts: InlinePart[]) {
    for (const part of parts) if (typeof part !== 'string') {
      if (part.kind === 'i') { validI.add(part.id); collect(part.children); }
      else validK.set(part.id, part.children.filter((c): c is string => typeof c === 'string').join(''));
    }
  }
  collect(srcParts);
  const flatTop = (function unwrap(parts: InlinePart[]): InlinePart[] {
    const meaningful = parts.filter(p => typeof p !== 'string' || p.trim().length > 0);
    const single = meaningful[0];
    return meaningful.length === 1 && single && typeof single !== 'string' && single.kind === 'i' ? unwrap(single.children) : parts;
  })(srcParts);
  for (const part of flatTop) {
    if (typeof part === 'string') { if (!part.trim()) continue; break; }
    if (part.kind === 'k') leadingK.add(part.id); else break;
  }
  for (let i = flatTop.length - 1; i >= 0; i--) {
    const part = flatTop[i]!;
    if (typeof part === 'string') { if (!/[\p{Letter}]/u.test(part)) continue; break; }
    if (part.kind === 'k') trailingK.add(part.id); else break;
  }
  const wrappers: number[] = [];
  let cursorParts = srcParts;
  while (true) {
    const meaningful = cursorParts.filter(p => typeof p !== 'string' || p.trim().length > 0);
    const single = meaningful[0];
    if (meaningful.length === 1 && single && typeof single !== 'string' && single.kind === 'i') {
      wrappers.push(single.id);
      cursorParts = single.children;
    } else break;
  }
  let root: InlinePart[] = [];
  const stack: { id: number; children: InlinePart[] }[] = [{ id: -1, children: root }];
  const seenI = new Set<number>(), seenK = new Set<number>();
  const pushText = ( list: InlinePart[], value: string ) => {
    if (!value) return;
    if (typeof list.at(-1) === 'string') list[list.length - 1] = (list.at(-1) as string) + value;
    else list.push(value);
  };
  const tagRegex = /<(\/?)([ik])(\d+)>/g;
  let cursor = 0, match: RegExpExecArray | null;
  while ((match = tagRegex.exec(translatedText)) !== null) {
    if (match.index > cursor) pushText(stack.at(-1)!.children, unescapeText(translatedText.slice(cursor, match.index)));
    const closing = Boolean(match[1]), kind = match[2] as 'i' | 'k', id = Number(match[3]);
    cursor = match.index + match[0].length;
    if (kind === 'k') {
      if (closing || !validK.has(id)) continue;
      const closeTag = `</k${id}>`;
      const closeIdx = translatedText.indexOf(closeTag, cursor);
      if (closeIdx !== -1) { cursor = closeIdx + closeTag.length; tagRegex.lastIndex = cursor; }
      const originalText = validK.get(id)!;
      if (!seenK.has(id)) {
        seenK.add(id);
        stack.at(-1)!.children.push({ kind: 'k', id, children: [originalText] });
      } else pushText(stack.at(-1)!.children, originalText);
      continue;
    }
    if (!closing) {
      if (!validI.has(id) || seenI.has(id) || seenI.size + seenK.size >= 300) continue;
      seenI.add(id);
      const part: InlinePart = { kind: 'i', id, children: [] };
      stack.at(-1)!.children.push(part);
      stack.push({ id, children: part.children });
    } else {
      let found = -1;
      for (let i = stack.length - 1; i > 0; i--) if (stack[i]!.id === id) { found = i; break; }
      if (found > 0) stack.length = found;
    }
  }
  if (cursor < translatedText.length) pushText(stack.at(-1)!.children, unescapeText(translatedText.slice(cursor)));
  for (const wId of [...wrappers].reverse()) {
    if (!seenI.has(wId)) { root = [{ kind: 'i', id: wId, children: root }]; seenI.add(wId); }
  }
  let targetList = root;
  for (const wId of wrappers) {
    const meaningful = targetList.filter(p => typeof p !== 'string' || p.trim().length > 0);
    const single = meaningful[0];
    if (meaningful.length === 1 && single && typeof single !== 'string' && single.kind === 'i' && single.id === wId) {
      targetList = single.children;
    } else break;
  }
  for (const [kId, kText] of validK) {
    if (seenK.has(kId)) continue;
    if (injectKept(root, kId, kText)) { seenK.add(kId); continue; }
    if (leadingK.has(kId)) { targetList.unshift({ kind: 'k', id: kId, children: [kText] }); seenK.add(kId); }
    else if (trailingK.has(kId) || kText === '\n') { targetList.push({ kind: 'k', id: kId, children: [kText] }); seenK.add(kId); }
  }
  return serializeInline(root);
}
export function hasAllInlineTags(sourceText: string, candidateText: string): boolean {
  try {
    const srcParts = parseInline(sourceText), candParts = parseInline(candidateText);
    const needed = new Set<string>(), present = new Set<string>();
    const visit = (parts: InlinePart[], target: Set<string>) => {
      for (const p of parts) if (typeof p !== 'string') { target.add(p.kind + p.id); visit(p.children, target); }
    };
    visit(srcParts, needed); visit(candParts, present);
    return [...needed].every(key => present.has(key));
  } catch { return false; }
}
export function plainText(text: string) { return unescapeText(text.replace(/<\/?[ik]\d+>/g, '')); }
// Everything about the service that can change a translation; one string so
// pages and caches carry it as a single value.
export function serviceIdentity(settings: Pick<Settings, 'format' | 'endpoint' | 'model' | 'thinking'>) {
  return JSON.stringify([settings.format, settings.endpoint, settings.model, settings.thinking]);
}
export function cacheKey(text: string, context: string, supplement: string, pair: LanguagePair, service: string) {
  return JSON.stringify([PROMPT_VERSION, service, parseLanguages(pair), context, supplement, text]);
}
