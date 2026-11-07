// Hovering a translated paragraph shows a small bar beside it: switch this
// paragraph back to its original (and again to the translation), or translate
// it once more. It lives in a shadow root on <html>, outside page styles,
// extraction and the page's own click handlers.
// kept: the model returned this paragraph unchanged, so there is nothing to switch.
export interface BarTarget { key: string; anchor: Element; original: boolean; kept?: boolean }
export type BarAction = 'original' | 'retranslate';

const STYLE = `
:host { all: initial; }
.bar { position: fixed; z-index: 2147483646; display: flex; gap: 2px; padding: 2px; border-radius: 7px; background: #fff;
  box-shadow: 0 2px 10px rgba(0,0,0,.14), 0 0 0 1px rgba(0,0,0,.08); font: 12px/1 system-ui, -apple-system, "PingFang SC", sans-serif; opacity: 0; transition: opacity .12s ease-out; }
.bar.shown { opacity: 1; }
button { all: unset; cursor: pointer; padding: 5px 8px; border-radius: 5px; color: #57606a; white-space: nowrap; }
button:hover { background: #f0f2f5; color: #1f2328; }
button:focus-visible { outline: 2px solid #4b8bf5; outline-offset: 1px; }
.note { padding: 5px 4px 5px 8px; color: #8c959f; white-space: nowrap; }
@media (prefers-color-scheme: dark) {
  .bar { background: #262a30; box-shadow: 0 2px 10px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.1); }
  button { color: #9aa4af; } button:hover { background: #343a42; color: #e6edf3; }
}
@media (prefers-reduced-motion: reduce) { .bar { transition: none; } }`;

export class ParagraphBar {
  private host?: HTMLElement;
  private bar?: HTMLElement;
  private shown?: BarTarget;
  private waiting?: BarTarget;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private find: (target: Element) => BarTarget | null, private act: (key: string, action: BarAction) => void) {
    document.addEventListener('pointerover', this.over, true);
    // A scroll moves the paragraph away from a shown bar. It does not cancel a
    // bar that is about to appear: scroll events arrive a frame late.
    window.addEventListener('scroll', () => { if (this.shown) this.hide(); }, { capture: true, passive: true });
    window.addEventListener('blur', this.hide);
  }
  private over = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || !(event.target instanceof Element)) return;
    if (this.host && event.composedPath().includes(this.host)) { clearTimeout(this.hideTimer); return; }
    const hit = this.find(event.target);
    if (hit && hit.key === (this.shown ?? this.waiting)?.key) { clearTimeout(this.hideTimer); return; }
    clearTimeout(this.showTimer); this.waiting = undefined;
    if (!hit) { if (this.shown) { clearTimeout(this.hideTimer); this.hideTimer = setTimeout(this.hide, 250); } return; }
    this.waiting = hit;
    clearTimeout(this.hideTimer);
    this.showTimer = setTimeout(() => { this.waiting = undefined; this.show(hit); }, this.shown ? 120 : 350);
  };
  hide = () => {
    clearTimeout(this.showTimer); clearTimeout(this.hideTimer);
    this.waiting = undefined; this.shown = undefined;
    if (this.host) { this.host.style.display = 'none'; this.bar?.classList.remove('shown'); }
  };
  private mount() {
    if (this.host?.isConnected) return;
    this.host = document.createElement('pagelet-bar');
    this.host.setAttribute('data-pagelet-hint', 'bar');
    this.host.setAttribute('translate', 'no');
    // Sites such as X open the post on any click; keep ours to ourselves.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick']) this.host.addEventListener(type, event => event.stopPropagation());
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = STYLE;
    this.bar = document.createElement('div'); this.bar.className = 'bar';
    this.bar.addEventListener('pointerleave', () => { clearTimeout(this.hideTimer); this.hideTimer = setTimeout(this.hide, 250); });
    root.append(style, this.bar);
    document.documentElement.append(this.host);
  }
  private button(label: string, title: string, action: BarAction, key: string) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label; button.title = title;
    button.addEventListener('click', event => { event.preventDefault(); this.hide(); this.act(key, action); });
    return button;
  }
  private show(target: BarTarget) {
    if (!target.anchor.isConnected) return;
    this.mount();
    this.shown = target;
    const bar = this.bar!;
    const note = document.createElement('span'); note.className = 'note'; note.textContent = '原文已保留';
    note.title = '模型认为这一段不需要翻译（如人名），原样保留';
    bar.replaceChildren(...(target.kept
      ? [note, this.button('重译', '重新翻译这一段', 'retranslate', target.key)]
      : [this.button(target.original ? '译文' : '原文', target.original ? '这一段改回显示译文' : '这一段只显示原文', 'original', target.key),
        ...(target.original ? [] : [this.button('重译', '重新翻译这一段', 'retranslate', target.key)])]));
    this.host!.style.display = 'block';
    this.host!.style.visibility = 'hidden';
    const rect = target.anchor.getBoundingClientRect();
    bar.style.left = '0px'; bar.style.top = '0px';
    const { width, height } = bar.getBoundingClientRect();
    const place = placement(target.anchor, rect, width, height);
    bar.style.left = `${place.left}px`; bar.style.top = `${place.top}px`;
    this.host!.style.visibility = '';
    requestAnimationFrame(() => bar.classList.add('shown'));
  }
}

// Try beside the paragraph, then above and below its right end; take the first
// spot that covers only background of a container around the paragraph (page
// margin, its column), not the paragraph itself, a neighbouring sidebar, or
// other text. Otherwise sit just above its right end.
function placement(anchor: Element, rect: DOMRect, width: number, height: number) {
  const clampX = (x: number) => Math.min(Math.max(8, x), innerWidth - width - 8);
  const clampY = (y: number) => Math.min(Math.max(8, y), innerHeight - height - 8);
  const candidates = [
    { left: rect.right + 8, top: rect.top },
    { left: rect.right - width, top: rect.top - height - 4 },
    { left: rect.right - width, top: rect.bottom + 4 },
  ].map(({ left, top }) => ({ left: clampX(left), top: clampY(top) }));
  const free = ({ left, top }: { left: number; top: number }) => [[left + 2, top + 2], [left + width - 2, top + 2], [left + 2, top + height - 2], [left + width - 2, top + height - 2], [left + width / 2, top + height / 2]]
    .every(([x, y]) => { const hit = document.elementFromPoint(x!, y!); return !hit || (hit !== anchor && hit.contains(anchor) && !hasOwnText(hit)); });
  return candidates.find(free) ?? { left: clampX(rect.right - width), top: clampY(rect.top - height - 4) };
}
// A container with text of its own outside the paragraph would be covered.
function hasOwnText(element: Element) {
  return [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && /\S/.test(node.textContent ?? ''));
}
