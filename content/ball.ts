// The optional floating ball: a light blue circle half tucked behind an edge
// of the page. Hovering slides it fully out; a click translates the page (or
// restores it while translated). It can be dragged anywhere, fully shown while
// dragged, and settles half hidden on the nearer side edge where it was let go.
// Shadow root on <html>, outside page styles and extraction. Only real clicks
// count: a page script calling click() cannot start a paid translation.
import { BUILD_VERSION, REFRESH_PAGE } from '../shared/runtime';
import type { BallAction, BallMessage, BallPlace, BallRequest, BallStatus, MessageReply } from '../shared/messages';
import type { PageState } from '../shared/translation';

const SIZE = 32, GAP = 8, MARGIN = 8;
// Same glyph as the popup's "翻译此页" button, at the same size as before.
const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 5 10 0M9 3v2M6 5c0 5 6 9 6 9M12 5c0 5-6 9-6 9m7 6 4-10 4 10m-6.5-3h5"/></svg>';
const STYLE = `
:host { all: initial; }
.ball { all: unset; box-sizing: border-box; position: fixed; right: 0; z-index: 2147483644; width: ${SIZE}px; height: ${SIZE}px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; cursor: pointer; color: #3b82f6; background: #fff; touch-action: none; user-select: none; -webkit-user-select: none;
  box-shadow: 0 0 0 1px rgba(59,130,246,.18), 0 1px 6px rgba(59,130,246,.3); opacity: .5; transform: translateX(50%);
  transition: transform .22s ease-out, opacity .22s ease-out, background-color .3s ease, color .3s ease, box-shadow .3s ease; -webkit-tap-highlight-color: transparent; }
/* White with a blue glyph until the page is translated, then blue with white. */
.ball.on { color: #fff; background: #60a5fa; box-shadow: 0 2px 10px rgba(37,99,235,.28); }
/* A wider hit area keeps the pointer on the ball while it slides out under it. */
.ball::before { content: ""; position: absolute; inset: 0 -${GAP}px; }
.ball.left { right: auto; left: 0; transform: translateX(-50%); }
.ball:hover { opacity: 1; transform: translateX(-${GAP}px); }
.ball.left:hover { transform: translateX(${GAP}px); }
.ball.drag, .ball.drag:hover { right: auto; opacity: 1; transform: none; transition: background-color .3s ease, color .3s ease; cursor: grabbing; }
.ball[aria-busy="true"] { cursor: progress; }
.tip { position: fixed; z-index: 2147483644; transform: translateY(-50%); max-width: 260px; width: max-content; padding: 6px 10px; border-radius: 7px;
  font: 12px/1.5 system-ui, -apple-system, "PingFang SC", sans-serif; color: #d92d20; background: #fff; box-shadow: 0 4px 18px rgba(0,0,0,.14), 0 0 0 1px rgba(0,0,0,.07); }
.tip[hidden] { display: none; }
@media (prefers-color-scheme: dark) { .tip { color: #f3b0a6; background: #262a30; box-shadow: 0 4px 18px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.1); } }
@media (prefers-reduced-motion: reduce) { .ball { transition: background-color .3s ease, color .3s ease, box-shadow .3s ease; } }
@media print { .ball, .tip { display: none; } }`;

export class FloatingBall {
  private host = document.createElement('pagelet-ball');
  private ball = document.createElement('button');
  private tip = document.createElement('span');
  private enabled = false;
  private busy = false;
  private place: BallPlace = { side: 'right', top: .6 };
  private drag?: { id: number; x: number; y: number; moved: boolean };
  private dragged = false;
  private tipTimer: ReturnType<typeof setTimeout> | undefined;
  constructor() {
    // A ball left by an earlier copy of the extension no longer works.
    document.querySelectorAll('pagelet-ball').forEach(node => node.remove());
    this.host.setAttribute('translate', 'no');
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick']) this.host.addEventListener(type, event => event.stopPropagation());
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = STYLE;
    this.ball.type = 'button'; this.ball.className = 'ball'; this.ball.tabIndex = -1; this.ball.innerHTML = ICON;
    this.tip.className = 'tip'; this.tip.hidden = true; this.tip.setAttribute('role', 'status');
    this.ball.addEventListener('click', event => {
      event.preventDefault();
      if (this.dragged) { this.dragged = false; return; }
      if (event.isTrusted) void this.toggle();
    });
    this.ball.addEventListener('pointerdown', this.down);
    this.ball.addEventListener('pointermove', this.move);
    this.ball.addEventListener('pointerup', this.up);
    this.ball.addEventListener('pointercancel', this.up);
    window.addEventListener('resize', () => this.layout(), { passive: true });
    root.append(style, this.ball, this.tip);
    this.layout(); this.render();
    document.documentElement.append(this.host);
    chrome.runtime.onMessage.addListener(this.listen);
    void this.send<BallStatus>({ action: 'status' }).then(reply => {
      if (!reply.ok) return;
      if (!this.drag) { this.place = reply.data.place; this.layout(); }
      if (!this.busy) { this.enabled = reply.data.enabled; this.render(); }
    }).catch(() => {});
  }
  alive() { return this.host.isConnected; }
  private listen = (message: BallMessage, sender: chrome.runtime.MessageSender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'pagelet-ball-state' || message.version !== BUILD_VERSION) return;
    if (message.remove) { this.host.remove(); chrome.runtime.onMessage.removeListener(this.listen); }
    else if (typeof message.enabled === 'boolean' && !this.busy) { this.enabled = message.enabled; this.render(); }
  };
  private clampTop(top: number) { return Math.min(Math.max(MARGIN, top), Math.max(MARGIN, innerHeight - SIZE - MARGIN)); }
  // Resting place: half hidden on one side edge, at a share of the window height.
  private layout() {
    if (this.drag?.moved) return;
    this.ball.classList.toggle('left', this.place.side === 'left');
    this.ball.style.left = ''; this.ball.style.top = `${this.clampTop(this.place.top * innerHeight)}px`;
  }
  private down = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    this.ball.setPointerCapture(event.pointerId);
  };
  private move = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    drag.moved = true; this.hideTip();
    this.ball.classList.add('drag');
    this.ball.style.left = `${Math.min(Math.max(0, event.clientX - SIZE / 2), innerWidth - SIZE)}px`;
    this.ball.style.top = `${this.clampTop(event.clientY - SIZE / 2)}px`;
  };
  private up = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    this.drag = undefined;
    if (this.ball.hasPointerCapture(event.pointerId)) this.ball.releasePointerCapture(event.pointerId);
    if (!drag.moved) return;
    // The click that follows a drag is not a request to translate.
    this.dragged = true; setTimeout(() => { this.dragged = false; }, 0);
    const top = this.clampTop(event.clientY - SIZE / 2);
    this.place = { side: event.clientX < innerWidth / 2 ? 'left' : 'right', top: innerHeight ? top / innerHeight : .6 };
    this.ball.classList.remove('drag');
    this.layout();
    void this.send({ action: 'place', place: this.place }).catch(() => {});
  };
  private render() {
    this.ball.classList.toggle('on', this.enabled);
    const label = this.enabled ? '恢复原文' : '翻译此页';
    this.ball.title = label; this.ball.setAttribute('aria-label', label);
    this.ball.setAttribute('aria-busy', String(this.busy));
  }
  // After the extension is reloaded this copy has no runtime; sendMessage then
  // throws instead of rejecting.
  private send<T>(request: BallAction): Promise<MessageReply<T>> {
    try {
      if (!chrome.runtime?.id) throw new Error(REFRESH_PAGE);
      return chrome.runtime.sendMessage({ type: 'pagelet-ball', version: BUILD_VERSION, ...request } satisfies BallRequest);
    } catch (error) { return Promise.reject(error); }
  }
  private async toggle() {
    if (this.busy) return;
    // The extension was reloaded or removed; this page keeps a dead copy.
    if (!chrome.runtime?.id) { this.host.remove(); return; }
    this.busy = true; this.hideTip(); this.render();
    try {
      const reply = await this.send<PageState>({ action: 'toggle' });
      if (reply?.version && reply.version !== BUILD_VERSION) throw new Error(REFRESH_PAGE);
      if (!reply?.ok) throw new Error(reply?.error || '翻译未能开始，请重试。');
      this.enabled = reply.data.enabled;
    } catch (error) {
      this.showTip(error instanceof Error && error.message ? error.message : '翻译未能开始，请重试。');
    } finally {
      this.busy = false; this.render();
    }
  }
  private showTip(text: string) {
    const rect = this.ball.getBoundingClientRect(), away = `${SIZE + 2 * GAP}px`;
    this.tip.style.top = `${rect.top + rect.height / 2}px`;
    this.tip.style.left = this.place.side === 'left' ? away : '';
    this.tip.style.right = this.place.side === 'left' ? '' : away;
    this.tip.textContent = text; this.tip.hidden = false;
    clearTimeout(this.tipTimer); this.tipTimer = setTimeout(() => this.hideTip(), 4000);
  }
  private hideTip() { clearTimeout(this.tipTimer); this.tip.hidden = true; }
}
