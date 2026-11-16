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
// The floating ball is opt-in: it runs on every HTTPS page, so it needs access
// to all of them, asked for only when the reader turns it on.
export const FLOATING_BALL_KEY = 'floating-ball.v1';
export const BALL_ORIGINS = ['https://*/*'];
// Where the reader last left the ball: side edge and share of window height.
export const BALL_PLACE_KEY = 'floating-ball-place.v1';
// Bilingual translations repeat links and emphasis of the original (on by
// default). Kept apart from Settings: switching it neither clears results nor
// stops translating pages.
export const RICH_TEXT_KEY = 'rich-text.v1';
// Optional mark on bilingual translations so they stand apart from the
// original: a very light background with a little padding, or an underline.
export const LOOK_KEY = 'translation-look.v1';
export const LOOK_STYLES = ['none', 'background', 'underline', 'wavy', 'dashed', 'dotted'] as const;
export type LookStyle = typeof LOOK_STYLES[number];
export interface TranslationLook { style: LookStyle; color: string }
export const DEFAULT_LOOK: TranslationLook = { style: 'none', color: '#3b82f6' };
// Inline CSS for a look; shared by the page output and the options preview.
// The colour is chosen for the background only; lines use the default blue.
export function lookStyle({ style, color }: TranslationLook) {
  const line = style !== 'none' && style !== 'background';
  return {
    backgroundColor: style === 'background' ? `color-mix(in srgb, ${color} 10%, transparent)` : '',
    padding: style === 'background' ? '4px 8px' : '',
    borderRadius: style === 'background' ? '4px' : '',
    textDecorationLine: line ? 'underline' : '',
    textDecorationStyle: style === 'underline' ? 'solid' : line ? style : '',
    textDecorationColor: line ? DEFAULT_LOOK.color : '',
    textDecorationThickness: line ? '1px' : '',
    textUnderlineOffset: line ? '4px' : '',
  };
}
export function parseLook(value: unknown): TranslationLook {
  const look = value as Partial<TranslationLook> | null;
  return {
    style: LOOK_STYLES.includes(look?.style as LookStyle) ? look!.style as LookStyle : DEFAULT_LOOK.style,
    color: typeof look?.color === 'string' && /^#[0-9a-f]{6}$/i.test(look.color) ? look.color.toLowerCase() : DEFAULT_LOOK.color,
  };
}

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
  getFloatingBall?(): Promise<boolean>;
  saveFloatingBall?(enabled: boolean): Promise<boolean>;
  getRichText?(): Promise<boolean>;
  saveRichText?(enabled: boolean): Promise<boolean>;
  getLook?(): Promise<TranslationLook>;
  saveLook?(look: TranslationLook): Promise<TranslationLook>;
}
