// A small status chip in the page corner while paragraphs are being
// translated: progress while requests run, a short "done", and failures with
// a retry button. Shadow root on <html>, outside page styles and extraction.
import type { PageState } from '../shared/translation';

const STYLE = `
:host { all: initial; }
.chip { position: fixed; right: 16px; bottom: 16px; z-index: 2147483645; min-width: 132px; box-sizing: border-box; overflow: hidden;
  display: flex; align-items: center; gap: 10px; padding: 8px 12px 10px; border-radius: 9px; background: rgba(255,255,255,.96); color: #1f2328;
  box-shadow: 0 4px 18px rgba(0,0,0,.14), 0 0 0 1px rgba(0,0,0,.07); font: 12px/1.3 system-ui, -apple-system, "PingFang SC", sans-serif;
  opacity: 0; transform: translateY(6px); transition: opacity .18s ease-out, transform .18s ease-out; pointer-events: none; }
.chip.shown { opacity: 1; transform: none; }
.chip.shown.interactive { pointer-events: auto; }
.text { flex: 1; white-space: nowrap; font-variant-numeric: tabular-nums; }
.track { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(0,0,0,.06); }
.fill { height: 100%; width: 0; background: #2f6fed; transition: width .3s ease-out; }
.failed .fill { background: #d92d20; }
button { all: unset; cursor: pointer; padding: 3px 8px; border-radius: 5px; color: #d92d20; background: rgba(217,45,32,.1); }
button:focus-visible { outline: 2px solid #4b8bf5; outline-offset: 1px; }
.close { color: #6e7781; background: none; padding: 3px 4px; }
@media (prefers-color-scheme: dark) {
  .chip { background: rgba(38,42,48,.96); color: #e6edf3; box-shadow: 0 4px 18px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.1); }
  .track { background: rgba(255,255,255,.08); } .fill { background: #6ea2ff; } .close { color: #8d96a0; }
}
@media (prefers-reduced-motion: reduce) { .chip, .fill { transition: none; } }`;

export class PageProgress {
  private host?: HTMLElement;
  private chip?: HTMLElement;
  private text?: HTMLElement;
  private fill?: HTMLElement;
  private actions?: HTMLElement;
  private busySince = 0;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private dismissed = false;
  private last?: PageState;
  constructor(private retry: () => void) {}
  update(state: PageState) {
    this.last = state;
    if (!state.enabled) { this.busySince = 0; this.dismissed = false; this.hide(); return; }
    if (state.pending > 0) {
      this.dismissed = false;
      clearTimeout(this.hideTimer);
      // Cached pages finish at once; show progress only for real waiting.
      if (!this.busySince) { this.busySince = performance.now(); clearTimeout(this.showTimer); this.showTimer = setTimeout(() => this.last && this.render(this.last), 600); }
      else if (this.visible()) this.render(state);
      return;
    }
    clearTimeout(this.showTimer);
    const wasBusy = this.busySince > 0; this.busySince = 0;
    if (state.failed > 0 && !this.dismissed && (wasBusy || this.visible())) { this.render(state); return; }
    if (this.visible() && state.failed === 0) {
      this.render(state);
      clearTimeout(this.hideTimer); this.hideTimer = setTimeout(() => this.hide(), 1400);
    }
  }
  hide() {
    clearTimeout(this.showTimer); clearTimeout(this.hideTimer);
    this.chip?.classList.remove('shown');
  }
  private visible() { return !!this.chip?.classList.contains('shown') && this.host?.isConnected; }
  private mount() {
    if (this.host?.isConnected) return;
    this.host = document.createElement('pagelet-progress');
    this.host.setAttribute('data-pagelet-hint', 'progress');
    this.host.setAttribute('translate', 'no');
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) this.host.addEventListener(type, event => event.stopPropagation());
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = STYLE;
    this.chip = document.createElement('div'); this.chip.className = 'chip'; this.chip.setAttribute('role', 'status');
    this.text = document.createElement('span'); this.text.className = 'text';
    this.actions = document.createElement('span');
    const track = document.createElement('div'); track.className = 'track';
    this.fill = document.createElement('div'); this.fill.className = 'fill'; track.append(this.fill);
    this.chip.append(this.text, this.actions, track);
    root.append(style, this.chip);
    document.documentElement.append(this.host);
  }
  private render(state: PageState) {
    this.mount();
    const { completed, pending, failed } = state;
    const total = completed + pending + failed;
    const failing = pending === 0 && failed > 0;
    this.text!.textContent = pending > 0 ? `翻译中 ${completed} / ${total} 段` : failing ? `${failed} 段翻译失败` : `已翻译 ${completed} 段`;
    this.fill!.style.width = `${total ? Math.round(100 * (pending > 0 ? completed / total : 1)) : 0}%`;
    this.chip!.classList.toggle('failed', failing);
    this.chip!.classList.toggle('interactive', failing);
    if (failing) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试';
      retry.addEventListener('click', event => { event.preventDefault(); this.retry(); });
      const close = document.createElement('button'); close.type = 'button'; close.className = 'close'; close.textContent = '×'; close.setAttribute('aria-label', '关闭');
      close.addEventListener('click', event => { event.preventDefault(); this.dismissed = true; this.hide(); });
      this.actions!.replaceChildren(retry, close);
    } else this.actions!.replaceChildren();
    this.chip!.classList.add('shown');
  }
}
