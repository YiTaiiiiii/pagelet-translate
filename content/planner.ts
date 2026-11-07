// Scroll intent is shared by extraction, batching and queue priorities.
export class ReadingWindow {
  direction = 1;
  private y = 0;
  private time = 0;
  private speed = 0;
  private latency = 1000;
  private moved = 0;
  scroll(y: number, now: number) {
    const distance = y - this.y;
    if (Math.abs(distance) > 2) {
      this.direction = Math.sign(distance);
      this.speed = this.time ? Math.abs(distance) / Math.max(16, now - this.time) : 0;
      this.moved = now;
    }
    this.y = y; this.time = now;
  }
  // Our own scroll compensation is not reading movement.
  shift(dy: number) { this.y += dy; }
  completed(ms: number) { this.latency = Math.max(200, Math.min(4000, this.latency * .75 + ms * .25)); }
  priority(rect: { top: number; bottom: number; height: number }, height: number, now: number): 0 | 1 | null {
    if (rect.height <= 0) return null;
    if (rect.bottom > 0 && rect.top < height) return 0;
    const moving = now - this.moved < 180;
    if (moving && this.speed > height / 250) return null;
    // Read far enough ahead that a paragraph is usually translated before it
    // scrolls into view: two screens at rest, up to three while reading fast.
    const distance = Math.min(height * 3, Math.max(height * 2, (moving ? this.speed : 0) * this.latency + height));
    if (this.direction > 0) return rect.top >= height && rect.top < height + distance ? 1 : null;
    return rect.bottom <= 0 && rect.bottom > -distance ? 1 : null;
  }
}
export const PREFETCH_ITEMS = 30;
export const PREFETCH_TOKENS = 4000;
export const CACHE_ENTRIES = 512;
export const CACHE_BYTES = 4 * 1024 * 1024;
