import { escapeText, plainText, type Scope } from '../shared/engine';

const NO_TRANSLATE = '[translate="no"],.notranslate';
const REMOVED = 'script,style,noscript,pre,textarea,input,select,option,svg,canvas,math,iframe,[contenteditable]:not([contenteditable="false"]),[data-pagelet-output],[data-pagelet-hint],[hidden],[aria-hidden="true"]';
const EXCLUDED = REMOVED + ',' + NO_TRANSLATE;
const BLOCK_DISPLAY = /^(block|flow-root|flex|grid|list-item|table|inline-table|table-row|table-row-group|table-header-group|table-footer-group|table-cell|table-caption)/;
const UI = 'nav,header,footer,button,[role="button"],.pagehead-actions';
const GITHUB_FILES = 'td[class*="react-directory-row-name-cell"],[data-testid="path-name-segment"],relative-time,local-time,time-ago,.blob-code,.react-code-text,.react-code-lines';
const INLINE = new Set(['A','EM','STRONG','B','I','U','S','DEL','INS','MARK','SMALL','SUP','SUB']);
const TWEET_TEXT = '[data-testid="tweetText"]';
const REDDIT_COMMENT = 'shreddit-comment,.comment';
const originalProse = new WeakMap<Element, string>();
// Plain counts and years stay as text (the prompt asks to keep numbers);
// versions, clock times and numbers with units are copied exactly.
const KEEP = /(?:https?:\/\/[^\s<>]+|(?:~\/|\.\/|\.\.\/|\/)?(?:[\w.@-]+\/)+[\w.@-]+|\b[\w-]+\.(?:tsx?|jsx?|py|json|md|ya?ml|toml|css|html|sh|go|rs|java|c|cpp)\b)|\b\d+(?:\.\d+){2,}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d+(?:[.,]\d+)*(?:%|(?:ms|tps|GB|MB|KB)\b)/g;
export interface Snapshot { node: Node; children: Node[]; text?: string }
export interface Source {
  text: string; plain: string; nodes: Node[]; parent: Element;
  inline: Element[]; kept: (Node | string)[]; snapshots: Snapshot[];
}
export interface Extracted { source: Source; unit: Element; kind?: 'feed' | 'document'; unitKey?: string; related?: string }
function isX() { return /(^|\.)(x|twitter)\.com$/.test(location.hostname); }
function isReddit() { return /(^|\.)reddit\.com$/.test(location.hostname); }
export function snapshot(nodes: Node[]): Snapshot[] {
  const saved: Snapshot[] = [];
  function visit(node: Node) {
    saved.push({ node, children: [...node.childNodes], ...(node instanceof Text ? { text: node.data } : {}) });
    node.childNodes.forEach(visit);
  }
  nodes.forEach(visit); return saved;
}
export function matches(saved: Snapshot[]) {
  return saved.every(({node,children,text}) => text !== undefined ? node.textContent === text : node.childNodes.length === children.length && children.every((child,i) => node.childNodes[i] === child));
}
export function composedParent(element: Element): Element | null {
  return element.parentElement ?? ((element.getRootNode() as ShadowRoot).host || null);
}
function ancestors(element: Element, test: (element: Element) => boolean) {
  for (let current: Element | null = element; current; current = composedParent(current)) if (test(current)) return true;
  return false;
}
function ignored(element: Element, scope: Scope) {
  const body = isX() ? element.closest(TWEET_TEXT) : null;
  return ancestors(element, item => {
    if (item.matches(EXCLUDED)) return true;
    if (location.hostname === 'github.com' && item.matches(GITHUB_FILES)) return true;
    if (scope !== 'main' || !item.matches(UI)) return false;
    if (body && item.matches('[role="button"]:not(button)') && item.contains(body)) return false;
    if (item.tagName === 'HEADER' && item.closest('article,main,[role="main"]') && !item.hasAttribute('data-site-nav')) return false;
    return true;
  });
}
export function visible(element: Element) {
  if (getComputedStyle(element).display === 'contents') return getComputedStyle(element).visibility !== 'hidden';
  return (element as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
}
// Inline text the page marks as not-to-translate (GitHub renders inline code
// and @mentions as .notranslate) belongs to its sentence: copy it as a
// protected token instead of cutting the paragraph in two.
function keptInline(element: Element) {
  return element.matches(NO_TRANSLATE) && !element.matches(REMOVED) && !element.matches(UI) && visible(element) && !BLOCK_DISPLAY.test(getComputedStyle(element).display) && /\S/.test(element.textContent ?? '');
}
function readingUnit(element: Element) {
  // One GitHub file or commit row is a single line of a table. Treat the whole
  // table as the reading unit so a batch can carry several rows under one shared
  // context; the repository description keeps its own unit.
  if (location.hostname === 'github.com') {
    const row = element.closest('tr');
    if (row) return row.closest('table') ?? row;
  }
  return element.closest('.markdown-body,.js-comment-body,[slot="comment"],[slot="text-body"],.md,tr,article') ?? element.closest('main,[role="main"]') ?? document.body;
}
export function pageRoots(scope: Scope): Element[] {
  if (scope === 'all') return [document.body];
  // X card wrappers are clickable and contain account names, timestamps and
  // counters. The explicit prose boundary also separates quoted post bodies.
  if (isX()) return [...document.querySelectorAll(TWEET_TEXT)];
  if (isReddit()) {
    const specific = [...document.querySelectorAll('[slot="text-body"],[slot="comment"],.md,shreddit-post h1,h1')];
    if (specific.length) return specific.filter((node,_,all) => !all.some(other => other !== node && other.contains(node)));
  }
  const roots = [...document.querySelectorAll('main,article,[role="main"]')];
  return roots.length ? roots.filter((node,_,all) => !all.some(other => other !== node && other.contains(node))) : [document.body];
}

function stableTextKey(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return 'text:' + (hash >>> 0).toString(36);
}
// Read prose only; textContent would include invisible controls and previously
// inserted bilingual output. A replacement marker means the DOM is translated.
function prose(body: Element, scope: Scope) {
  if (ignored(body, scope) || !visible(body)) return '';
  const markers = document.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  let replaced = false;
  for (let node = markers.nextNode(); node; node = markers.nextNode()) if (node.textContent === 'pagelet') { replaced = true; break; }
  if (replaced) return originalProse.get(body) ?? '';
  const source = encode(body, [...body.childNodes], scope);
  originalProse.set(body, source.plain);
  return source.plain;
}
function statusId(element: Element, boundary: Element) {
  const candidates = [element, ...element.querySelectorAll('a[href], [role="link"][href]')];
  for (const candidate of candidates) {
    // X timestamps are themselves <a role="link">. Only an enclosing
    // quote wrapper belongs to another post; the candidate link is not one.
    const enclosingLink = candidate.parentElement?.closest('[role="link"]');
    if (candidate !== element && enclosingLink && enclosingLink !== boundary && boundary.matches('article,[data-testid="tweet"]')) continue;
    const id = /\/status\/(\d+)(?:[/?#]|$)/.exec(candidate.getAttribute('href') ?? '')?.[1];
    if (id) return id;
  }
  return '';
}
function tweetBoundary(body: Element) {
  const card = body.closest('[data-testid="tweet"],article') ?? body;
  const quote = body.closest('[role="link"]');
  // A link surrounding the quoted post is an explicit relation. An ordinary
  // inline hyperlink inside prose cannot become its reading unit.
  return quote && card.contains(quote) && quote.contains(body) ? quote : card;
}
function commentBody(comment: Element) {
  return [...comment.querySelectorAll('[slot="comment"],.md')].find(body => body.closest(REDDIT_COMMENT) === comment);
}
export function readingContext(parent: Element, scope: Scope = 'main'): Omit<Extracted, 'source'> {
  const tweet = isX() ? parent.closest(TWEET_TEXT) : null;
  if (tweet) {
    const boundary = tweetBoundary(tweet), own = prose(tweet, scope);
    const card = tweet.closest('[data-testid="tweet"],article');
    const related = boundary === card ? [...(card?.querySelectorAll(TWEET_TEXT) ?? [])]
      .filter(body => body !== tweet && tweetBoundary(body) !== card)
      .map(body => prose(body, scope)).filter(Boolean).join('\n') : '';
    return { unit: tweet, kind: 'feed', unitKey: 'x:' + (statusId(boundary, boundary) || stableTextKey(own)), related };
  }
  if (isReddit()) {
    const body = parent.closest('[slot="comment"],[slot="text-body"],.md') ?? parent;
    const comment = body.closest(REDDIT_COMMENT), own = prose(body, scope);
    const ancestor = comment?.parentElement?.closest(REDDIT_COMMENT);
    const relatedBody = ancestor ? commentBody(ancestor) : undefined;
    const owner = comment ?? body.closest('shreddit-post,.thing') ?? body;
    const identity = owner.getAttribute('thingid') || owner.getAttribute('data-fullname') || owner.id;
    return { unit: body, kind: 'feed', unitKey: 'reddit:' + (identity || stableTextKey(own)), related: relatedBody ? prose(relatedBody, scope) : '' };
  }
  return { unit: readingUnit(parent), kind: 'document' };
}
export function openRoots(root: Element | ShadowRoot): (Element | ShadowRoot)[] {
  const result: (Element | ShadowRoot)[] = [root];
  function visit(scope: Element | ShadowRoot) {
    if (scope instanceof Element && scope.shadowRoot) { result.push(scope.shadowRoot); visit(scope.shadowRoot); }
    for (const element of scope.querySelectorAll('*')) if (element.shadowRoot) { result.push(element.shadowRoot); visit(element.shadowRoot); }
  }
  visit(root); return result;
}
function styledSpan(node: Element) {
  if (node.tagName !== 'SPAN' || !node.parentElement) return false;
  const style = getComputedStyle(node), parent = getComputedStyle(node.parentElement);
  return style.fontWeight !== parent.fontWeight || style.fontStyle !== parent.fontStyle ||
    style.color !== parent.color || style.textDecorationLine !== parent.textDecorationLine ||
    (style.backgroundColor !== parent.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent');
}
function encode(parent: Element, nodes: Node[], scope: Scope): Source {
  const source: Source = { parent, nodes, text: '', plain: '', inline: [], kept: [], snapshots: snapshot(nodes) };
  function keep(value: Node | string, text: string) {
    const id = source.kept.push(value) - 1; return '<k' + id + '>' + escapeText(text) + '</k' + id + '>';
  }
  function text(value: string, node: Text) {
    const preservesLines = node.parentElement && /^(pre|pre-wrap|pre-line|break-spaces)$/.test(getComputedStyle(node.parentElement).whiteSpace);
    value = preservesLines ? value.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ') : value.replace(/\s+/g, ' ');
    let cursor = 0, result = '';
    for (const match of value.matchAll(KEEP)) {
      result += escapeText(value.slice(cursor, match.index)) + keep(match[0], match[0]);
      cursor = match.index! + match[0].length;
    }
    return result + escapeText(value.slice(cursor));
  }
  function protectedText(child: Node): string {
    if (child instanceof Text) return child.data;
    if (!(child instanceof Element) || child.matches(EXCLUDED) || ignored(child, scope) || !visible(child)) return '';
    return child.tagName === 'BR' ? '\n' : [...child.childNodes].map(protectedText).join('');
  }
  function walk(node: Node): string {
    if (node instanceof Text) return text(node.data, node);
    if (!(node instanceof Element)) return '';
    if (keptInline(node)) return keep(node, [...node.childNodes].map(protectedText).join(''));
    if (node.matches(EXCLUDED) || !visible(node) || ignored(node, scope)) return '';
    if (node.matches('code,kbd,samp,br')) {
      return keep(node, node.tagName === 'BR' ? '\n' : [...node.childNodes].map(protectedText).join(''));
    }
    const raw = protectedText(node);
    if (!/\p{Letter}/u.test(raw)) {
      if (!raw.trim() && !raw.includes('\n')) return '';
      if (node.matches('sup,sub,a') || /\p{Number}/u.test(raw)) return keep(node, raw.replace(/\s+/g, ' ').trim());
    }
    if (INLINE.has(node.tagName) || styledSpan(node)) {
      const id = source.inline.push(node) - 1;
      return '<i' + id + '>' + [...node.childNodes].map(walk).join('') + '</i' + id + '>';
    }
    return [...node.childNodes].map(walk).join('');
  }
  source.text = nodes.map(walk).join(''); source.plain = plainText(source.text).replace(/\s+/g, ' ').trim();
  return source;
}

// Collect text first; group by actual block boundary, including direct div text
// before/after a nested paragraph. No requirement for a particular prose tag.
export function extract(roots: Element[], scope: Scope, occupied: Set<Node>): Extracted[] {
  const groups = new Map<Element, Set<Node>>();
  const blockMemo = new Map<Element, boolean>();
  function block(element: Element) {
    if (!blockMemo.has(element)) blockMemo.set(element, BLOCK_DISPLAY.test(getComputedStyle(element).display));
    return blockMemo.get(element)!;
  }
  for (const root of roots) for (const tree of openRoots(root)) {
    const walker = document.createTreeWalker(tree, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (occupied.has(node)) return NodeFilter.FILTER_REJECT;
        if (node instanceof Element) return ignored(node, scope) || !visible(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return node instanceof Text && /\p{Letter}/u.test(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || ignored(parent, scope) || !visible(parent) || parent.closest('code,kbd,samp')) continue;
      let container = parent;
      while (!block(container) && container.parentElement && container !== root) container = container.parentElement;
      let child: Node = node;
      while (child.parentNode !== container && child.parentNode) child = child.parentNode;
      if (child.parentNode !== container) continue;
      if (!groups.has(container)) groups.set(container, new Set());
      groups.get(container)!.add(child);
    }
  }
  const result: Extracted[] = [];
  for (const [parent, selected] of groups) {
    let run: Node[] = [];
    function flush() {
      if (run.some(node => selected.has(node))) {
        const source = encode(parent, run, scope);
        if ((source.plain.match(/\p{Letter}/gu)?.length ?? 0) >= 2 && source.text.length <= 32000) result.push({ source, ...readingContext(parent, scope) });
      }
      run = [];
    }
    for (const node of parent.childNodes) {
      const included = selected.has(node) || (node instanceof Text && !/\p{Letter}/u.test(node.data)) || (node instanceof Element && (keptInline(node) || !ignored(node,scope) && visible(node) && !block(node)));
      if (included && !occupied.has(node)) run.push(node); else flush();
    }
    flush();
  }
  return result;
}
