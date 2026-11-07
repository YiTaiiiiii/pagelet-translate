import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, STORAGE_KEY, AUTO_SITES_KEY, parseSettings, permissionOrigin, siteOf, sitePattern, type Settings } from '../shared/settings';
import { IDLE_STATE, SESSION_KEY, type PageSession, type PageState } from '../shared/translation';
import { testConnection, ApiError } from '../core/connection';
import { translate } from '../core/translate';
import { RequestQueue } from '../core/queue';
import { parseLanguages, type LanguagePair } from '../shared/languages';
import { USAGE_KEY, USAGE_LIMIT, type UsageRecord, type UsageRecorder } from '../shared/usage';
import { BUILD_VERSION, REFRESH_PAGE } from '../shared/runtime';
import { parseBatch, cacheKey, serviceIdentity, EMPTY_USAGE, type PageUsage, type SegmentResult } from '../shared/engine';
import { TranslationMemo } from '../core/memo';
import { isBackgroundRequest, isPageState, type PageControl, type PageControlCommand, type PageMessage } from '../shared/messages';
import { NavigationQueue, classifyNavigation, type NavigationTarget } from '../core/navigation';

export default defineBackground(() => {
  const queue = new RequestQueue();
  const trustedPages = new Set<string>([browser.runtime.getURL('/popup.html'), browser.runtime.getURL('/options.html')]);
  const sessions = new Map<number, PageSession>();
  const pageUsage = new Map<string, PageUsage>();
  const navigation = new NavigationQueue();
  const memo = new TranslationMemo();
  let blocked: 'pause' | 'stop' | '' = '';
  let persistence = Promise.resolve();
  let usageWrite = Promise.resolve();
  const ready = (async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const saved = (await browser.storage.session.get(SESSION_KEY))[SESSION_KEY];
    if (saved && typeof saved === 'object') {
      for (const [key, value] of Object.entries(saved)) {
        const tabId = Number(key);
        if (Number.isInteger(tabId) && isSavedSession(value)) {
          sessions.set(tabId, value);
          const state = await control(tabId, { action: 'status' }, value.documentId).catch(() => null);
          if (state?.usage) pageUsage.set(value.documentId, state.usage);
        }
      }
    }
  })();
  function recorder(kind: UsageRecord['kind'], pair: LanguagePair, tabId?: number, documentId?: string): UsageRecorder {
    return sample => {
      if (tabId !== undefined && documentId && sessions.get(tabId)?.documentId === documentId) {
        const usage = pageUsage.get(documentId) ?? { ...EMPTY_USAGE };
        usage.requests++; usage.input += sample.inputTokens ?? 0; usage.output += sample.outputTokens ?? 0;
        usage.hit += sample.cacheReadTokens ?? 0;
        if (sample.inputTokens === null || sample.outputTokens === null) usage.unknown++;
        pageUsage.set(documentId, usage);
        void control(tabId, { action: 'usage', usage }, documentId).catch(() => {});
      }
      usageWrite = usageWrite.catch(() => {}).then(async () => {
        const saved = (await browser.storage.local.get(USAGE_KEY))[USAGE_KEY];
        const usage = [...(Array.isArray(saved) ? saved : []), { ...sample, ...pair, kind, id: crypto.randomUUID() }].slice(-USAGE_LIMIT);
        await browser.storage.local.set({ [USAGE_KEY]: usage });
      });
      return usageWrite;
    };
  }
  function persist() {
    persistence = persistence.catch(() => {}).then(async () => {
      await browser.storage.session.set({ [SESSION_KEY]: Object.fromEntries(sessions) });
    });
    return persistence;
  }
  async function settings(): Promise<Settings> {
    const saved = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}), ...parseLanguages(saved) };
  }
  async function autoSites(): Promise<string[]> {
    const saved = (await browser.storage.local.get(AUTO_SITES_KEY))[AUTO_SITES_KEY];
    return Array.isArray(saved) ? saved.filter((site): site is string => typeof site === 'string' && siteOf(site) === site) : [];
  }
  async function autoSite(url: string | undefined) {
    const site = siteOf(url);
    return !!site && (await autoSites()).includes(site) && browser.permissions.contains({ origins: [sitePattern(site)] });
  }
  // A page of an auto-translated site loaded in a tab that is not already
  // translating it (new tab, link from another site, typed address).
  async function autoStart(details: { tabId: number; frameId: number; url: string; documentId?: string; documentLifecycle?: string }) {
    if (details.frameId !== 0 || details.documentLifecycle === 'prerender' || !await autoSite(details.url)) return;
    await ready;
    const session = sessions.get(details.tabId);
    if (session?.enabled && (session.documentId === details.documentId || siteOf(session.url) === siteOf(details.url))) return;
    await navigation.enqueue(details.tabId, async current => {
      const frame = await browser.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 }).catch(() => null);
      if (!current() || !frame?.documentId || (details.documentId && frame.documentId !== details.documentId)) return;
      const latest = sessions.get(details.tabId);
      if (latest?.enabled && latest.documentId === frame.documentId) return;
      await startTab({ id: details.tabId, url: frame.url }, undefined, current, { documentId: frame.documentId, url: frame.url }).catch(() => {});
    });
  }
  async function permitted(config: Settings) {
    if (!await browser.permissions.contains({ origins: [permissionOrigin(config.endpoint, config.format)] })) throw new Error('请先到设置中测试连接，允许访问模型服务。');
  }
  async function activeTab(windowId?: number) {
    const tabs = await browser.tabs.query(windowId !== undefined ? { windowId } : { active: true, lastFocusedWindow: true });
    const ext = browser.runtime.getURL('/');
    const tab = tabs.find(t => t.active && !t.url?.startsWith(ext)) ?? tabs.find(t => !t.url?.startsWith(ext)) ?? tabs.find(t => t.active);
    if (!tab?.id) throw new Error('没有找到当前网页。');
    return tab;
  }
  async function control(tabId: number, command: PageControlCommand, documentId?: string): Promise<PageState & { version?: string }> {
    const message = { type: 'pagelet-control', version: BUILD_VERSION, ...command } satisfies PageControl;
    return browser.tabs.sendMessage(tabId, message, documentId ? { documentId } : { frameId: 0 });
  }
  async function getState(tabId: number) {
    try {
      const state = await control(tabId, { action: 'status' });
      if (state && typeof state.enabled === 'boolean' && state.version !== BUILD_VERSION) return { ...IDLE_STATE, enabled: state.enabled, error: REFRESH_PAGE };
      return isPageState(state) ? state : { ...IDLE_STATE };
    } catch { return { ...IDLE_STATE }; }
  }
  async function cancel(tabId: number, restore = false, current: () => boolean = () => true) {
    if (!current()) return;
    const previous = sessions.get(tabId);
    if (previous) queue.cancel(previous.id);
    sessions.delete(tabId);
    if (previous) pageUsage.delete(previous.documentId);
    await persist();
    if (!current()) return;
    if (restore && previous) {
      await control(tabId, { action: 'reset' }, previous.documentId).catch(() => {});
      if (!current()) return;
    }
    await browser.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
  async function toggle(windowId?: number): Promise<PageState> {
    await ready;
    const tab = await activeTab(windowId);
    const tabId = tab.id!;
    const current = await getState(tabId);
    if (current.enabled) {
      const session = sessions.get(tabId);
      if (session) { session.enabled = false; queue.cancel(session.id,false); await persist(); }
      return control(tabId, { action: 'stop' }, session?.documentId);
    }
    return startTab(tab);
  }
  async function startTab(tab: { id?: number; url?: string }, pairOverride?: LanguagePair, current?: () => boolean, expected?: NavigationTarget): Promise<PageState> {
    const tabId = tab.id!;
    if (!current) return navigation.runIntent(tabId, active => startTab(tab, pairOverride, active));
    const check = () => {
      if (!current()) throw new DOMException('页面正在切换，请稍后再试。', 'AbortError');
    };
    check();
    const config = parseSettings(await settings());
    check();
    const pair = pairOverride ?? parseLanguages(sessions.get(tabId) ?? config);
    if (pair.sourceLanguage === pair.targetLanguage) throw new Error('源语言与目标语言相同。');
    await permitted(config);
    check();
    const beforeInjection = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
    check();
    const tabUrl = tab.url || beforeInjection?.url;
    if (!tabUrl || !/^https?:/.test(tabUrl)) throw new Error('这个页面不允许网页翻译，请打开普通网页后再试。');
    const origin = new URL(tabUrl).origin;
    if (!beforeInjection || new URL(beforeInjection.url).origin !== origin || (expected && beforeInjection.documentId !== expected.documentId)) throw new Error('页面正在切换，请稍后再试。');
    let injection;
    try {
      injection = await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['/translator.js'] });
    } catch {
      check();
      throw new Error('无法读取这个页面，请在网页中重新点击扩展图标后再试。');
    }
    check();
    const documentId = injection[0]?.documentId;
    if (!documentId || (expected && expected.documentId !== documentId)) throw new Error('页面正在切换，请稍后再试。');
    const frame = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
    check();
    if (!frame || frame.documentId !== documentId || new URL(frame.url).origin !== origin) throw new Error('页面正在切换，请稍后再试。');
    const engine = await control(tabId, { action: 'status' }, documentId).catch(() => null);
    check();
    if (engine?.version !== BUILD_VERSION) throw new Error(REFRESH_PAGE);
    const latestFrame = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
    check();
    if (!latestFrame || latestFrame.documentId !== documentId || new URL(latestFrame.url).origin !== origin) throw new Error('页面正在切换，请稍后再试。');
    const previous = sessions.get(tabId);
    const samePage = previous?.documentId === documentId;
    const samePair = previous?.sourceLanguage === pair.sourceLanguage && previous?.targetLanguage === pair.targetLanguage;
    if (previous && (!samePage || !samePair)) queue.cancel(previous.id);
    const session: PageSession = {
      id: samePage && samePair ? previous.id : crypto.randomUUID(),
      documentId,
      url: latestFrame.url,
      enabled: true,
      ...pair,
    };
    if (!samePage && previous) pageUsage.delete(previous.documentId);
    queue.focus(session.id);
    sessions.set(tabId, session);
    // Authorize content messages before start. Do not yield between installing
    // the session and sending start to this exact document.
    const state = await control(tabId, { action: 'start', sessionId: session.id, mode: config.mode, endpoint: serviceIdentity(config), ...pair }, documentId);
    check();
    await persist();
    check();
    const usage = pageUsage.get(documentId);
    if (usage) {
      await control(tabId, { action: 'usage', usage }, documentId);
      check();
    }
    if (blocked) {
      await control(tabId, { action: 'pause', error: blocked === 'pause' ? '服务限流，点击继续恢复。' : '请先检查接口与账户设置。' }, documentId);
      check();
    }
    return state;
  }

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const run = async () => {
      await ready;
      if (sender.id !== browser.runtime.id || !isBackgroundRequest(message)) throw new Error('不允许的操作。');
      const request = message;
      const ui = sender.url && trustedPages.has(sender.url.split(/[?#]/)[0]!);
      if (ui) {
        const winId = sender.tab?.windowId;
        if (request.type === 'get-settings') {
          const config = await settings();
          const tab = await activeTab(winId);
          const session = sessions.get(tab.id!);
          return session ? { ...config, ...parseLanguages(session) } : config;
        }
        if (request.type === 'get-usage') {
          await usageWrite;
          const saved = (await browser.storage.local.get(USAGE_KEY))[USAGE_KEY];
          return Array.isArray(saved) ? saved.slice(-USAGE_LIMIT) : [];
        }
        if (request.type === 'save-languages') {
          const pair = parseLanguages(request.languages);
          const tab = await activeTab(winId);
          const wasEnabled = (await getState(tab.id!)).enabled;
          const previous = parseLanguages(sessions.get(tab.id!) ?? await settings());
          await browser.storage.local.set({ [STORAGE_KEY]: { ...await settings(), ...pair } });
          if (wasEnabled && (pair.sourceLanguage !== previous.sourceLanguage || pair.targetLanguage !== previous.targetLanguage)) {
            if (pair.sourceLanguage !== pair.targetLanguage) return startTab(tab,pair);
            const session = sessions.get(tab.id!);
            if (session) { queue.cancel(session.id); Object.assign(session,pair,{enabled:false}); await persist(); }
            return control(tab.id!, { action: 'stop' }, session?.documentId);
          }
          const session = sessions.get(tab.id!);
          if (session && !wasEnabled) { Object.assign(session,pair); await persist(); }
          return getState(tab.id!);
        }
        if (request.type === 'save-settings') {
          const config = parseSettings(request.settings);
          // Changing credentials cannot silently retarget an already authorized page.
          for (const tabId of [...sessions.keys()]) await cancel(tabId, true);
          await memo.clear();
          blocked = ''; queue.resume();
          await browser.storage.local.set({ [STORAGE_KEY]: config }); return null;
        }
        if (request.type === 'save-mode') {
          if (request.mode !== 'bilingual' && request.mode !== 'translated') throw new Error('显示方式不正确。');
          await browser.storage.local.set({ [STORAGE_KEY]: { ...await settings(), mode: request.mode } });
          const tab = await activeTab(winId);
          await control(tab.id!, { action: 'mode', mode: request.mode }).catch(() => {});
          return null;
        }
        if (request.type === 'test-connection') {
          const config = parseSettings(request.settings); await permitted(config);
          return queue.add('connection-test', signal => testConnection(config, signal, recorder('connection', { sourceLanguage: 'en', targetLanguage: 'zh-CN' })));
        }
        if (request.type === 'save-scope') {
          if (request.scope !== 'main' && request.scope !== 'all') throw new Error('翻译范围不正确。');
          return control((await activeTab(winId)).id!, { action: 'scope', scope: request.scope });
        }
        if (request.type === 'pagelet-retry') {
          if (blocked === 'stop') throw new Error('请先检查并保存接口与账户设置。');
          blocked = ''; queue.resume();
          // Resume all tabs paused by the shared provider limit, preserving their results.
          for (const [id,session] of sessions) if (session.enabled) await control(id, { action: 'retry' }, session.documentId).catch(()=>{});
          return getState((await activeTab(winId)).id!);
        }
        if (request.type === 'pagelet-toggle') return toggle(winId);
        if (request.type === 'get-auto-site') {
          const tab = await activeTab(winId);
          const site = siteOf(tab.url);
          return { site, enabled: await autoSite(tab.url) };
        }
        if (request.type === 'save-auto-site') {
          const tab = await activeTab(winId);
          const site = siteOf(tab.url);
          if (!site) throw new Error('这个页面不能设置自动翻译。');
          const sites = (await autoSites()).filter(value => value !== site);
          if (request.enabled) {
            if (!await browser.permissions.contains({ origins: [sitePattern(site)] })) throw new Error('没有获得这个网站的访问授权，未开启自动翻译。');
            sites.push(site);
          }
          await browser.storage.local.set({ [AUTO_SITES_KEY]: sites });
          const state = await getState(tab.id!);
          return request.enabled && !state.enabled ? startTab(tab) : state;
        }
        if (request.type === 'pagelet-get-state') return getState((await activeTab(winId)).id!);
      }
      const tabId = sender.tab?.id;
      const session = tabId !== undefined ? sessions.get(tabId) : undefined;
      if (!session || sender.frameId !== 0 || sender.documentId !== session.documentId || !('sessionId' in request) || request.sessionId !== session.id) {
        throw new Error('翻译会话已结束，请恢复后重新翻译。');
      }
      if (!('version' in request) || request.version !== BUILD_VERSION) throw new Error(REFRESH_PAGE);
      if (request.type === 'pagelet-plan') {
        queue.plan(session.id, session.enabled ? request.jobs : []);
        return null;
      }
      if (request.type === 'pagelet-translate') {
        const input = parseBatch(request.input);
        if (!session.enabled) throw new DOMException('尚未发送。','AbortError');
        const pair = parseLanguages(session);
        const service = serviceIdentity(parseSettings(await settings()));
        // Finished results from any tab or earlier load of the same text,
        // context and language are reused without a model request.
        const hashes = new Map(await Promise.all(input.items.map(async item => [item.id, await TranslationMemo.hash(cacheKey(item.text, input.context, item.supplement, pair, service))] as const)));
        const saved = input.fresh ? new Map<string, string>() : await memo.get([...hashes.values()]);
        const hits: SegmentResult[] = [];
        const items = input.items.filter(item => {
          const text = saved.get(hashes.get(item.id)!);
          if (text === undefined) return true;
          hits.push({ id: item.id, text }); return false;
        });
        if (!items.length) return hits;
        if (blocked) throw new ApiError('请求已暂停，请检查面板。',blocked);
        const deliver = (result: SegmentResult) => {
          if (sessions.get(tabId!)?.id === session.id) void browser.tabs.sendMessage(tabId!, { type: 'pagelet-result', version: BUILD_VERSION, jobId: request.jobId, result } satisfies PageMessage, { documentId: session.documentId }).catch(()=>{});
        };
        hits.forEach(deliver);
        return queue.add(session.id, async signal => {
          if (sessions.get(tabId!)?.id !== session.id || !session.enabled || !queue.wanted(session.id, request.jobId ?? '')) throw new DOMException('尚未发送。','AbortError');
          const config = { ...parseSettings(await settings()), ...pair }; await permitted(config);
          signal.throwIfAborted();
          // Settings and permissions can yield after a scroll. Check again at
          // the actual send boundary; already-sent requests may finish.
          if (!session.enabled || !queue.wanted(session.id, request.jobId ?? '') || sessions.get(tabId!)?.id !== session.id) throw new DOMException('尚未发送。','AbortError');
          try {
            const results = await translate(config,{...input,items},signal,recorder('translation', pair, tabId, session.documentId), deliver,
              ()=>sessions.get(tabId!)?.id === session.id && session.enabled && !blocked && queue.wanted(session.id, request.jobId ?? ''));
            if (serviceIdentity(config) === service) void memo.put(results.flatMap(result => result.text !== undefined ? [[hashes.get(result.id)!, result.text] as [string, string]] : [])).catch(() => {});
            return [...hits,...results];
          } catch (error) {
            if (error instanceof ApiError && error.policy !== 'manual') {
              blocked = error.policy; queue.pause();
              for (const [id,value] of sessions) { queue.cancel(value.id,false); void control(id, { action: 'pause', error: error.message }, value.documentId).catch(()=>{}); }
            }
            throw error;
          }
        }, input.priority, request.jobId);
      }
      if (request.type === 'pagelet-stop') { await cancel(tabId!, false); return null; }
      if (request.type === 'pagelet-state' && request.state) {
        const state = request.state;
        const badge = state.failed ? '!' : state.pending ? '…' : state.enabled && state.completed ? '文' : '';
        void browser.action.setBadgeText({ tabId, text: badge }).catch(() => {});
        void browser.action.setBadgeBackgroundColor({ tabId, color: '#3346c9' }).catch(() => {});
        void browser.runtime.sendMessage({ type: 'pagelet-ui-state', tabId, state }).catch(() => {});
        return null;
      }
      throw new Error('无法识别此操作。');
    };
    run().then(data => sendResponse({ ok: true, data, version: BUILD_VERSION }), error => sendResponse({ ok: false, error: error instanceof Error ? error.message : '操作失败，请重试。', unsent: error instanceof DOMException && error.message === '尚未发送。', version: BUILD_VERSION }));
    return true;
  });
  browser.commands.onCommand.addListener(command => {
    if (command === 'toggle-translation') void toggle().catch(async () => { await browser.action.openPopup().catch(() => {}); });
  });
  browser.tabs.onRemoved.addListener(tabId => {
    navigation.close(tabId);
    void ready.then(() => cancel(tabId)).catch(() => {});
  });
  browser.tabs.onActivated.addListener(({ tabId }) => queue.focus(sessions.get(tabId)?.id ?? ''));
  async function navigate(details: { tabId: number; frameId: number; url: string; documentId?: string }) {
    if (details.frameId !== 0) return;
    await navigation.enqueue(details.tabId, async current => {
      await ready;
      if (!current()) return;
      const previous = sessions.get(details.tabId);
      if (!previous) return;
      const frame = await browser.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 }).catch(() => null);
      if (!current()) return;
      // Actual frame identity takes precedence over an event queued while the
      // worker starts; history events may refer to a document already replaced.
      const documentId = frame?.documentId ?? details.documentId;
      if (!documentId) return;
      const target = { documentId, url: frame?.url ?? details.url };
      const action = classifyNavigation(previous, target);
      if (action === 'route') {
        previous.url = target.url;
        await persist();
        if (!current()) return;
        await control(details.tabId, { action: 'route' }, documentId).catch(() => {});
        return;
      }
      if (action === 'restart') {
        queue.cancel(previous.id);
        await startTab({ id: details.tabId, url: target.url }, parseLanguages(previous), current, target).catch(() => {});
        return;
      }
      await cancel(details.tabId, true, current);
    });
  }
  browser.webNavigation.onCommitted.addListener(details => { void navigate(details).catch(() => {}); });
  browser.webNavigation.onHistoryStateUpdated.addListener(details => { void navigate(details).catch(() => {}); });
  browser.webNavigation.onDOMContentLoaded.addListener(details => { void autoStart(details).catch(() => {}); });
});

function isSavedSession(value: unknown): value is PageSession {
  if (!value || typeof value !== 'object' || !('id' in value) || !('documentId' in value) || !('url' in value) || !('enabled' in value)) return false;
  if (typeof value.id !== 'string' || typeof value.documentId !== 'string' || typeof value.url !== 'string' || typeof value.enabled !== 'boolean') return false;
  if (!('sourceLanguage' in value) || !('targetLanguage' in value) || typeof value.sourceLanguage !== 'string' || typeof value.targetLanguage !== 'string') return false;
  try { parseLanguages(value); return true; } catch { return false; }
}
