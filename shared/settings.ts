import { DEFAULT_LANGUAGES, parseLanguages, type LanguagePair } from './languages';

export const MAX_CONCURRENT_REQUESTS = 10;
export const STORAGE_KEY = 'settings.v1';
export type DisplayMode = 'bilingual' | 'translated';
// Sites (scheme + host) that start translating on their own. Kept apart from
// Settings so saving the options page never overwrites this list.
export const AUTO_SITES_KEY = 'auto-sites.v1';
export interface AutoSite { site: string | null; enabled: boolean }
export function siteOf(url: string | undefined): string | null {
  try { const u = new URL(url || ''); return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.hostname}` : null; }
  catch { return null; }
}
export function sitePattern(site: string) { return `${site}/*`; }

// Request format of the configured service. Both are spoken by many
// providers beyond their originators (DeepSeek, Kimi, GLM, gateways).
export type ApiFormat = 'openai' | 'anthropic';
// How much the model may think before answering. 'default' sends nothing and
// leaves the provider default; 'off' asks the provider to skip thinking.
export type Thinking = 'default' | 'off' | 'low' | 'medium' | 'high';
export const THINKING_LEVELS: Thinking[] = ['default', 'off', 'low', 'medium', 'high'];

export interface Settings extends LanguagePair {
  // Preset the fields came from ('custom' when edited by hand); UI only.
  provider: string;
  format: ApiFormat;
  endpoint: string;
  apiKey: string;
  model: string;
  thinking: Thinking;
  mode: DisplayMode;
  testedAt: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_LANGUAGES,
  provider: 'deepseek',
  format: 'openai',
  endpoint: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  thinking: 'off',
  mode: 'bilingual',
  testedAt: null,
};

export function normalizeEndpoint(value: string, format: ApiFormat = 'openai'): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('请填写完整的服务地址，例如 https://api.deepseek.com'); }
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('服务地址需要使用 HTTPS。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址不能包含账号、密码、查询参数或锚点。');
  }
  // A full request path pasted from provider docs; the call appends its own.
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) {
    throw new Error(format === 'openai' ? '请填写服务根地址，不需要添加 /chat/completions。' : '这是 OpenAI 格式的完整地址，请填写服务根地址并确认接口格式。');
  }
  if (path.endsWith('/messages')) {
    throw new Error(format === 'anthropic' ? '请填写服务根地址，不需要添加 /v1/messages。' : '这是 Anthropic 格式的完整地址，请填写服务根地址并确认接口格式。');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('配置格式不正确，请重新填写。');
  const input = value as Record<string, unknown>;
  if (typeof input.endpoint !== 'string' || typeof input.apiKey !== 'string') {
    throw new Error('请填写服务地址和 API Key。');
  }
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error('请先填写 API Key。');
  if (/\s/.test(apiKey) || apiKey.length > 4096) throw new Error('API Key 格式不正确，请检查是否多复制了内容。');
  if (input.mode !== 'bilingual' && input.mode !== 'translated') throw new Error('请选择译文显示方式。');
  // Settings saved before these fields existed keep working as before.
  const format = input.format === undefined ? 'openai' : input.format;
  if (format !== 'openai' && format !== 'anthropic') throw new Error('请选择接口格式。');
  const model = (input.model === undefined ? DEFAULT_SETTINGS.model : typeof input.model === 'string' ? input.model : '').trim();
  if (!model) throw new Error('请填写模型 ID。');
  if (/\s/.test(model) || model.length > 200) throw new Error('模型 ID 格式不正确。');
  const thinking = input.thinking === undefined ? 'off' : input.thinking;
  if (!THINKING_LEVELS.includes(thinking as Thinking)) throw new Error('请选择思考强度。');
  return {
    ...parseLanguages(input),
    provider: typeof input.provider === 'string' && input.provider ? input.provider : 'custom',
    format, endpoint: normalizeEndpoint(input.endpoint, format), apiKey, model, thinking: thinking as Thinking, mode: input.mode,
    testedAt: typeof input.testedAt === 'string' ? input.testedAt : null,
  };
}

export function permissionOrigin(endpoint: string, format: ApiFormat = 'openai'): string {
  const url = new URL(normalizeEndpoint(endpoint, format));
  return `${url.protocol}//${url.hostname}/*`;
}

export type Reply<T> = ({ ok: true; data: T } | { ok: false; error: string }) & { version?: string };
export interface ConnectionResult { testedAt: string }

export interface UiBridge {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  testConnection(settings: Settings): Promise<ConnectionResult>;
  saveMode(mode: DisplayMode): Promise<void>;
  saveLanguages(pair: LanguagePair): Promise<import('./translation').PageState | void>;
  saveScope?(scope: import('./engine').Scope): Promise<import('./translation').PageState>;
  retryTranslation?(): Promise<import('./translation').PageState>;
  getUsage?(): Promise<import('./usage').UsageRecord[]>;
  watchUsage?(listener: (records: import('./usage').UsageRecord[]) => void): () => void;
  getShortcut(): Promise<string>;
  getPageHost(): Promise<string>;
  openSettings(): void;
  openShortcuts(): void;
  reloadExtension?(): void;
  getPageState?(): Promise<import('./translation').PageState>;
  toggleTranslation?(endpoint: string): Promise<import('./translation').PageState>;
  getAutoSite?(): Promise<AutoSite>;
  saveAutoSite?(site: string, enabled: boolean): Promise<import('./translation').PageState>;
  watchPageState?(listener: (state: import('./translation').PageState) => void): () => void;
}
