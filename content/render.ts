import { parseInline, type InlinePart } from '../shared/engine';
import type { DisplayMode } from '../shared/settings';
import { matches, snapshot, type Source, type Snapshot } from './extract';

export interface View { source: Source; output?: HTMLElement; marker?: Comment; nodes?: Node[]; saved?: Snapshot[]; savedStyles?: { element: HTMLElement; style: string | null }[]; provisional?: boolean; lastOutput?: HTMLElement; boundary?: Node[]; hint?: HTMLElement }
export type HintKind = 'pending' | 'failed' | null;
export function current(view: View) {
  const nodes = view.nodes ?? view.source.nodes;
  return view.source.parent.isConnected && nodes.every(node => node.parentNode === view.source.parent) && matches(view.saved ?? view.source.snapshots);
}
export function boundaryNodes(parent: Element) {
  return [...parent.childNodes].filter(node => !(node instanceof Element && (node.hasAttribute('data-pagelet-output') || node.hasAttribute('data-pagelet-hint'))));
}
export function boundaryCurrent(view: View) {
  if (!view.boundary) return true;
  const nodes = boundaryNodes(view.source.parent);
  return nodes.length === view.boundary.length && nodes.every((node,i) => node === view.boundary![i]);
}
export function restore(view: View) {
  setHint(view, null);
  view.provisional = false;
  view.output?.remove(); view.output = undefined;
  if (!view.marker) return;
  if (current(view)) {
    // Restore descendants before their top-level wrappers; original links retain identity.
    for (const saved of [...view.source.snapshots].reverse()) {
      if (saved.text !== undefined) (saved.node as Text).data = saved.text;
      else if (saved.node instanceof Element) saved.node.replaceChildren(...saved.children);
    }
    for (const node of view.nodes ?? []) if (!view.source.nodes.includes(node)) node.parentNode?.removeChild(node);
    for (const node of view.source.nodes) view.marker.parentNode?.insertBefore(node, view.marker);
  }
  if (view.savedStyles) {
    for (const { element, style } of view.savedStyles) {
      if (style === null) element.removeAttribute('style');
      else element.setAttribute('style', style);
    }
    view.savedStyles = undefined;
  }
  view.marker.remove(); view.marker = undefined; view.nodes = undefined; view.saved = undefined;
}
function cloneKept(kept: Node) {
  const clone = kept.cloneNode(true);
  if (clone instanceof Element) {
    clone.removeAttribute('id');
    for (const el of clone.querySelectorAll('[id]')) el.removeAttribute('id');
  }
  return clone;
}
function cloneInline(original: Element) {
  const clone = document.createElement(original.tagName.toLowerCase());
  if (original.className && typeof original.className === 'string') clone.className = original.className;
  const style = getComputedStyle(original);
  const parent = original.parentElement ? getComputedStyle(original.parentElement) : null;
  if (original instanceof HTMLAnchorElement) {
    if (/^(https?:|mailto:)/.test(original.href)) clone.setAttribute('href', original.href);
    clone.setAttribute('rel','noopener noreferrer');
    clone.style.color = style.color;
    clone.style.textDecoration = style.textDecoration;
  }
  const weight = Number(style.fontWeight) || (style.fontWeight === 'bold' || style.fontWeight === 'bolder' ? 700 : 400);
  const parentWeight = parent ? (Number(parent.fontWeight) || 400) : 400;
  if (original.matches('strong,b') || weight > parentWeight || weight >= 600) clone.style.fontWeight = style.fontWeight;
  if (original.matches('em,i') || style.fontStyle === 'italic' || style.fontStyle === 'oblique') {
    clone.style.fontStyle = style.fontStyle === 'normal' ? 'italic' : style.fontStyle;
  }
  if (parent && style.color !== parent.color) clone.style.color = style.color;
  if (parent && style.backgroundColor !== parent.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') {
    clone.style.backgroundColor = style.backgroundColor;
    clone.style.padding = style.padding;
    clone.style.borderRadius = style.borderRadius;
  }
  if (parent && style.textDecorationLine !== parent.textDecorationLine && !(original instanceof HTMLAnchorElement)) {
    clone.style.textDecoration = style.textDecoration;
  }
  if (original.matches('sup,sub,small') || (parent && style.fontSize !== parent.fontSize)) {
    clone.style.fontSize = style.fontSize;
    clone.style.verticalAlign = style.verticalAlign;
    clone.style.lineHeight = style.lineHeight;
  }
  clone.style.fontSynthesis = 'weight style';
  return clone;
}
// Page fonts are usually Latin-only; name the CJK faces so Windows does not
// fall back to a serif such as SimSun, and keep Latin text in the page font.
const CJK_FONTS: Record<string, string> = {
  'zh-CN': '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif',
  ja: '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo","Noto Sans CJK JP",sans-serif',
};
function heading(parent: Element, style: CSSStyleDeclaration) {
  return /^H[1-6]$/.test(parent.tagName) || parent.getAttribute('role') === 'heading' || (parseFloat(style.fontSize) >= 22 && (Number(style.fontWeight) || 400) >= 550);
}
// CJK text needs more leading than Latin and no Latin tracking.
function typesetCjk(element: HTMLElement, style: CSSStyleDeclaration, language: string, isHeading: boolean) {
  const fonts = CJK_FONTS[language];
  if (!fonts) return;
  element.style.fontFamily = `${style.fontFamily},${fonts}`;
  if (style.letterSpacing !== 'normal' && parseFloat(style.letterSpacing) !== 0) element.style.letterSpacing = 'normal';
  const size = parseFloat(style.fontSize), ratio = style.lineHeight === 'normal' ? 1.2 : parseFloat(style.lineHeight) / size;
  if (!isHeading && ratio < 1.6) element.style.lineHeight = '1.7';
}
function outputNode(language: string, parent: Element) {
  const output = document.createElement('span'); output.setAttribute('data-pagelet-output',''); output.lang = language;
  output.style.cssText = 'display:block;margin-top:.4em;color:inherit;font:inherit;font-synthesis:weight style;white-space:pre-wrap;';
  const style = getComputedStyle(parent), isHeading = heading(parent, style);
  // One title per heading: its translation sits a step smaller. Body text
  // is a little softer, so the original and the translation read as two layers.
  if (isHeading) { output.style.fontSize = '.78em'; output.style.marginTop = '.3em'; }
  else output.style.color = 'color-mix(in srgb, currentColor 74%, transparent)';
  return { output, style, isHeading };
}
function place(view: View, nodes: Node[], mode: DisplayMode, language: string) {
  if (mode === 'translated') {
    const parent = view.source.parent as HTMLElement;
    if (getComputedStyle(parent).fontSynthesis.includes('none')) {
      view.savedStyles = [{ element: parent, style: parent.getAttribute('style') }];
      parent.style.fontSynthesis = 'weight style';
    }
    // The translation replaces the original inside the page's own element; fix
    // its CJK typesetting only when that element holds just this paragraph.
    if (sole(view, view.source.nodes)) {
      const before = parent.getAttribute('style');
      typesetCjk(parent, getComputedStyle(parent), language, heading(parent, getComputedStyle(parent)));
      if (parent.getAttribute('style') !== before && !view.savedStyles) view.savedStyles = [{ element: parent, style: before }];
    }
    const marker = document.createComment('pagelet');
    view.source.parent.insertBefore(marker, view.source.nodes[0]!);
    for (const node of view.source.nodes) if (node.parentNode === view.source.parent) node.parentNode.removeChild(node);
    for (const node of nodes) view.source.parent.insertBefore(node, marker);
    view.marker = marker; view.nodes = nodes; view.saved = snapshot(nodes);
  } else {
    const parent = view.source.parent;
    const { output, style, isHeading } = outputNode(language, parent); output.append(...nodes);
    if (['flex','inline-flex','grid','inline-grid'].includes(style.display)) {
      Object.assign(output.style,{color:isHeading ? style.color : `color-mix(in srgb, ${style.color} 74%, transparent)`,font:style.font,fontFamily:style.fontFamily,fontSize:isHeading ? `calc(${style.fontSize} * .78)` : style.fontSize,fontWeight:style.fontWeight,fontStyle:style.fontStyle,lineHeight:style.lineHeight,letterSpacing:style.letterSpacing}); parent.after(output);
    } else parent.insertBefore(output, view.source.nodes.at(-1)!.nextSibling);
    typesetCjk(output, style, language, isHeading);
    view.output = output;
  }
}
export function retain(view: View, previous: HTMLElement, mode: DisplayMode, language: string) {
  restore(view);
  if (!current(view)) return;
  view.lastOutput = previous.cloneNode(true) as HTMLElement;
  place(view, [...previous.childNodes].map(node => node.cloneNode(true)), mode, language);
  view.provisional = true;
  view.boundary = boundaryNodes(view.source.parent);
}
// The page element contains nothing but this paragraph (and our markers).
function sole(view: View, nodes: Node[]) {
  return [...view.source.parent.childNodes].every(node => nodes.includes(node) || node === view.marker || node === view.hint || (node instanceof Text && !node.data.trim()));
}
// A fresh translation fades in instead of popping; replacing one that is
// already visible (cached or provisional) does not flash again.
function fadeIn(view: View, mode: DisplayMode) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const parent = view.source.parent as HTMLElement;
  // Translation-only output has no wrapper; fade the block when it is only this paragraph.
  const target = mode === 'bilingual' ? view.output : sole(view, view.nodes ?? []) ? parent : undefined;
  target?.animate?.([{ opacity: mode === 'bilingual' ? 0 : .3 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
}
export function render(view: View, translated: string, mode: DisplayMode, language: string) {
  const visible = !!(view.output?.isConnected || view.marker?.isConnected);
  restore(view);
  if (!current(view)) return false;
  function build(parts: InlinePart[]): Node[] {
    return parts.flatMap(part => {
      if (typeof part === 'string') return [document.createTextNode(part)];
      if (part.kind === 'k') {
        const kept = view.source.kept[part.id];
        if (kept === undefined) throw new Error('译文的保留内容编号不正确。');
        return [typeof kept === 'string' ? document.createTextNode(kept) : mode === 'translated' ? kept : cloneKept(kept)];
      }
      const original = view.source.inline[part.id];
      if (!original) throw new Error('译文的行内编号不正确。');
      const element = mode === 'translated' ? original : cloneInline(original);
      element.replaceChildren(...build(part.children)); return [element];
    });
  }
  const parts = parseInline(translated);
  // Build the replacement before removing the currently visible translation.
  const nodes = build(parts);
  const remembered = document.createElement('span');
  remembered.append(...nodes.map(node => node.cloneNode(true)));
  place(view, nodes, mode, language);
  view.lastOutput = remembered;
  if (!visible) fadeIn(view, mode);
  return true;
}

const FLOW = ['flex','inline-flex','grid','inline-grid'];
// A small marker right after the paragraph: a dim "⋯" while its translation
// is on the way, or an in-place retry when it failed. It never joins the
// paragraph's own nodes, extraction or feed boundaries.
export function setHint(view: View, kind: HintKind, message = '', retry?: () => void) {
  const shown = view.hint?.isConnected ? view.hint.getAttribute('data-pagelet-hint') : null;
  if (shown === kind && view.hint) { if (kind === 'failed') view.hint.title = message; return; }
  view.hint?.remove(); view.hint = undefined;
  if (!kind) return;
  const parent = view.source.parent, last = view.source.nodes.at(-1);
  if (!last || last.parentNode !== parent || FLOW.includes(getComputedStyle(parent).display)) return;
  const hint = document.createElement('span');
  hint.setAttribute('data-pagelet-hint', kind);
  hint.setAttribute('translate', 'no');
  const base = 'font-weight:normal;font-style:normal;text-decoration:none;text-transform:none;letter-spacing:normal;user-select:none;-webkit-user-select:none;';
  if (kind === 'pending') {
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = '\u2002⋯';
    hint.style.cssText = base + 'pointer-events:none;opacity:.45;';
    hint.animate?.([{ opacity: .2 }, { opacity: .7 }], { duration: 800, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
  } else {
    hint.setAttribute('role', 'button');
    hint.tabIndex = 0;
    hint.title = message;
    hint.textContent = '翻译失败 · 重试';
    hint.style.cssText = base + 'display:inline-block;margin-inline-start:.5em;padding:0 .45em;border-radius:4px;font-size:.8em;line-height:1.6;vertical-align:baseline;color:#d92d20;background:rgba(217,45,32,.1);cursor:pointer;';
    // Sites such as X open the post on any click inside its text.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) hint.addEventListener(type, event => event.stopPropagation());
    const act = (event: Event) => { event.preventDefault(); event.stopPropagation(); retry?.(); };
    hint.addEventListener('click', act);
    hint.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') act(event); });
  }
  parent.insertBefore(hint, last.nextSibling);
  view.hint = hint;
}
