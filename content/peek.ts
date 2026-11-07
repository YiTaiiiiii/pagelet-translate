// In translation-only mode, hovering a translated paragraph shows its original
// text in a small floating card. The card lives in a shadow root mounted on
// <html>, outside every extraction root, so page styles and scans never see it.
export interface PeekTarget { anchor: Element; text: string }

const STYLE = `
:host { all: initial; }
.card { position: fixed; z-index: 2147483647; box-sizing: border-box; max-width: min(560px, calc(100vw - 16px)); max-height: 40vh; overflow: hidden;
  padding: 8px 11px 9px; border-radius: 8px; font: 13px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif; white-space: pre-wrap; overflow-wrap: anywhere;
  color: #1f2328; background: #fff; box-shadow: 0 6px 22px rgba(0,0,0,.16), 0 0 0 1px rgba(0,0,0,.08); pointer-events: none; }
.label { display: block; margin-bottom: 2px; font-size: 11px; color: #6e7781; }
@media (prefers-color-scheme: dark) {
  .card { color: #e6edf3; background: #262a30; box-shadow: 0 6px 22px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.1); }
  .label { color: #8d96a0; }
}`;

export class OriginalPeek {
  private host?: HTMLElement;
  private card?: HTMLElement;
  private body?: HTMLElement;
  private anchor?: Element;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private find: (target: Element) => PeekTarget | null) {
    document.addEventListener('pointerover', this.over, true);
    document.addEventListener('pointerout', this.out, true);
    window.addEventListener('scroll', this.hide, { capture: true, passive: true });
    window.addEventListener('blur', this.hide);
  }
  private over = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || !(event.target instanceof Element)) return;
    const hit = this.find(event.target);
    if (hit?.anchor === this.anchor) return;
    this.hide();
    if (!hit) return;
    this.anchor = hit.anchor;
    this.timer = setTimeout(() => this.show(hit), 450);
  };
  private out = (event: PointerEvent) => {
    const to = event.relatedTarget;
    if (this.anchor && to instanceof Node && this.anchor.contains(to)) return;
    this.hide();
  };
  hide = () => {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.anchor = undefined;
    if (this.host) this.host.style.display = 'none';
  };
  private show({ anchor, text }: PeekTarget) {
    if (!anchor.isConnected || this.anchor !== anchor) return;
    if (!this.host?.isConnected) {
      this.host = document.createElement('pagelet-peek');
      this.host.setAttribute('data-pagelet-hint', 'peek');
      const root = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style'); style.textContent = STYLE;
      this.card = document.createElement('div'); this.card.className = 'card';
      const label = document.createElement('span'); label.className = 'label'; label.textContent = '原文';
      this.body = document.createElement('span');
      this.card.append(label, this.body);
      root.append(style, this.card);
      document.documentElement.append(this.host);
    }
    this.body!.textContent = text;
    this.host.style.display = 'block';
    const card = this.card!, rect = anchor.getBoundingClientRect();
    card.style.left = '0px'; card.style.top = '0px';
    const { width, height } = card.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
    const below = rect.bottom + 6, above = rect.top - height - 6;
    const top = below + height <= innerHeight - 8 || above < 8 ? Math.min(below, Math.max(8, innerHeight - height - 8)) : above;
    card.style.left = `${left}px`; card.style.top = `${top}px`;
  }
}
