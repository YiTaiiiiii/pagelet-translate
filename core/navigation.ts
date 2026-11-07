import type { PageSession } from '../shared/translation';

export interface NavigationTarget { documentId: string; url: string }
export function classifyNavigation(previous: PageSession, target: NavigationTarget): 'route' | 'restart' | 'stop' {
  if (previous.documentId === target.documentId) return 'route';
  try {
    return previous.enabled && new URL(previous.url).origin === new URL(target.url).origin ? 'restart' : 'stop';
  } catch { return 'stop'; }
}
interface Lane { revision: number; tail: Promise<void>; closed: boolean }
export class NavigationQueue {
  private lanes = new Map<number, Lane>();
  private lane(tabId: number) {
    let lane = this.lanes.get(tabId);
    if (!lane) {
      lane = { revision: 0, tail: Promise.resolve(), closed: false };
      this.lanes.set(tabId, lane);
    }
    return lane;
  }
  capture(tabId: number): () => boolean {
    const lane = this.lane(tabId);
    const revision = lane.revision;
    return () => !lane.closed && lane.revision === revision;
  }
  enqueue(tabId: number, run: (current: () => boolean) => Promise<void>): Promise<void> {
    const lane = this.lane(tabId);
    const revision = ++lane.revision;
    const current = () => !lane.closed && lane.revision === revision;
    const task = lane.tail.catch(() => {}).then(async () => {
      if (current()) await run(current);
    });
    lane.tail = task;
    return task;
  }
  runIntent<T>(tabId: number, run: (current: () => boolean) => Promise<T>): Promise<T> {
    const lane = this.lane(tabId);
    const task = lane.tail.catch(() => {}).then(async () => {
      while (!lane.closed) {
        const revision = lane.revision;
        const current = () => !lane.closed && lane.revision === revision;
        try {
          const result = await run(current);
          if (current()) return result;
        } catch (error) {
          if (current() || lane.closed) throw error;
        }
      }
      throw new DOMException('页面正在切换，请稍后再试。', 'AbortError');
    });
    lane.tail = task.then(() => {});
    // The caller observes task failures; keep the internal serial tail handled.
    void lane.tail.catch(() => {});
    return task;
  }
  close(tabId: number) {
    const lane = this.lanes.get(tabId);
    if (lane) lane.closed = true;
    this.lanes.delete(tabId);
  }
}
