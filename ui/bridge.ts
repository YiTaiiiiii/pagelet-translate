import { type Reply, type UiBridge, type ConnectionResult, type Settings, type AutoSite, parseSettings, permissionOrigin, sitePattern } from '../shared/settings';
import { type PageState } from '../shared/translation';
import { USAGE_KEY, type UsageRecord } from '../shared/usage';
import { BUILD_VERSION, ExtensionUpdateError } from '../shared/runtime';

async function send<T>(message: object): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage(message);
  if (reply && reply.version !== BUILD_VERSION) throw new ExtensionUpdateError();
  if (!reply?.ok) throw new Error(reply?.error || '无法连接扩展，请重新打开面板。');
  return reply.data;
}

export const extensionBridge: UiBridge = {
  getSettings: () => send<Settings>({ type: 'get-settings' }),
  saveSettings: settings => send<void>({ type: 'save-settings', settings }),
  async testConnection(input) {
    const settings = parseSettings(input);
    // Request only the configured API host, directly from the user's click.
    const permitted = await chrome.permissions.request({ origins: [permissionOrigin(settings.endpoint)] });
    if (!permitted) throw new Error('你取消了连接授权，Key 没有发送。');
    return send<ConnectionResult>({ type: 'test-connection', settings });
  },
  saveScope: scope => send<PageState>({ type: 'save-scope', scope }),
  retryTranslation: () => send<PageState>({ type: 'pagelet-retry' }),
  saveMode: mode => send<void>({ type: 'save-mode', mode }),
  saveLanguages: languages => send<PageState>({ type: 'save-languages', languages }),
  getUsage: () => send<UsageRecord[]>({ type: 'get-usage' }),
  watchUsage(listener) {
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && Array.isArray(changes[USAGE_KEY]?.newValue)) listener(changes[USAGE_KEY]!.newValue);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  },
  async getShortcut() {
    const commands = await chrome.commands.getAll();
    return commands.find(command => command.name === 'toggle-translation')?.shortcut || '';
  },
  async getPageHost() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try { return new URL(tab?.url || '').hostname || '当前网页'; }
    catch { return '当前网页'; }
  },
  openSettings: () => { void chrome.runtime.openOptionsPage(); },
  openShortcuts: () => { void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); },
  reloadExtension: () => chrome.runtime.reload(),
  getPageState: () => send<PageState>({ type: 'pagelet-get-state' }),
  async toggleTranslation(endpoint) {
    const current = await send<PageState>({ type: 'pagelet-get-state' });
    if (!current.enabled && !await chrome.permissions.contains({ origins: [permissionOrigin(endpoint)] })) {
      throw new Error('请先在设置中测试连接并允许访问模型服务。');
    }
    return send<PageState>({ type: 'pagelet-toggle' });
  },
  getAutoSite: () => send<AutoSite>({ type: 'get-auto-site' }),
  async saveAutoSite(site, enabled) {
    // Ask for this one site directly from the user's click, before any await.
    if (enabled && !await chrome.permissions.request({ origins: [sitePattern(site)] })) throw new Error('没有获得这个网站的访问授权，未开启自动翻译。');
    return send<PageState>({ type: 'save-auto-site', enabled });
  },
  watchPageState(listener) {
    let tabId: number | undefined;
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => { tabId = tab?.id; });
    const onMessage = (message: { type?: string; tabId?: number; state?: PageState }) => {
      if (message.type === 'pagelet-ui-state' && message.tabId === tabId && message.state) listener(message.state);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  },
};
