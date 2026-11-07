import { expect, test } from '@playwright/test';
import { classifyNavigation, NavigationQueue } from '../core/navigation';
import type { PageSession } from '../shared/translation';

const session: PageSession = { id: 'session', documentId: 'document', url: 'https://x.com/home', enabled: true, sourceLanguage: 'auto', targetLanguage: 'zh-CN' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('同一文档路由保留；新文档同站重启、跨站或关闭时停止', () => {
  expect(classifyNavigation(session, { documentId: 'document', url: 'https://x.com/user/status/1/photo/1' })).toBe('route');
  expect(classifyNavigation(session, { documentId: 'next', url: 'https://x.com/user/status/1' })).toBe('restart');
  expect(classifyNavigation(session, { documentId: 'next', url: 'https://example.com/' })).toBe('stop');
  expect(classifyNavigation({ ...session, enabled: false }, { documentId: 'next', url: 'https://x.com/home' })).toBe('stop');
});

test('按标签串行，启动等待和持久化等待期间只接受最后一次导航', async () => {
  const queue = new NavigationQueue();
  const ready = deferred();
  const persisted = deferred();
  const arrived = deferred();
  const calls: string[] = [];
  const first = queue.enqueue(1, async current => {
    await ready.promise;
    if (!current()) return;
    calls.push('first');
  });
  await Promise.resolve();
  const second = queue.enqueue(1, async current => {
    calls.push('second');
    arrived.resolve();
    await persisted.promise;
    if (current()) calls.push('second-start');
  });
  ready.resolve();
  await arrived.promise;
  const skipped = queue.enqueue(1, async () => { calls.push('skipped'); });
  const latest = queue.enqueue(1, async current => { if (current()) calls.push('latest'); });
  const independent = queue.enqueue(2, async () => { calls.push('other-tab'); });
  await independent;
  expect(calls).toEqual(['second', 'other-tab']);
  persisted.resolve();
  await Promise.all([first, second, skipped, latest]);
  expect(calls).toEqual(['second', 'other-tab', 'latest']);
});

test('关闭标签使在途票据失效，失败任务后仍处理后续导航', async () => {
  const queue = new NavigationQueue();
  const gate = deferred();
  const entered = deferred();
  const calls: string[] = [];
  const current = queue.capture(1);
  const running = queue.enqueue(1, async active => {
    entered.resolve();
    await gate.promise;
    if (active()) calls.push('closed-tab-start');
  });
  await entered.promise;
  const pending = queue.enqueue(1, async () => { calls.push('closed-tab-route'); });
  queue.close(1);
  gate.resolve();
  await Promise.all([running, pending]);
  expect(current()).toBe(false);
  expect(calls).toEqual([]);
  await queue.enqueue(2, async () => { throw new Error('read failed'); }).catch(() => {});
  await queue.enqueue(2, async () => { calls.push('recovered'); });
  expect(calls).toEqual(['recovered']);
});

test('首次启用意图在准备各阶段遇到路由时继续处理最新网址', async () => {
  const queue = new NavigationQueue();
  const stages = ['settings', 'permission', 'injection'];
  for (const [index, stage] of stages.entries()) {
    const tabId = index + 10;
    const entered = deferred();
    const resumed = deferred();
    let url = 'https://x.com/home';
    let attempts = 0;
    let started = '';
    const intent = queue.runIntent(tabId, async current => {
      attempts++;
      if (attempts === 1) {
        entered.resolve();
        await resumed.promise;
        if (!current()) throw new DOMException(stage, 'AbortError');
      }
      started = url;
      return started;
    });
    await entered.promise;
    url = 'https://x.com/user/status/1';
    const history = queue.enqueue(tabId, async () => {});
    resumed.resolve();
    expect(await intent).toBe(url);
    await history;
    expect(attempts).toBe(2);
    expect(started).toBe(url);
  }
});

test('关闭标签终止首次启用意图，也清除尚未执行的启用', async () => {
  const queue = new NavigationQueue();
  const entered = deferred();
  const resumed = deferred();
  let starts = 0;
  const intent = queue.runIntent(1, async current => {
    entered.resolve();
    await resumed.promise;
    if (!current()) throw new DOMException('closed', 'AbortError');
    starts++;
  });
  await entered.promise;
  const pending = queue.runIntent(1, async () => { starts++; });
  queue.close(1);
  resumed.resolve();
  const results = await Promise.allSettled([intent, pending]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(starts).toBe(0);
});
