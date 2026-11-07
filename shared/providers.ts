import { normalizeEndpoint, type ApiFormat, type Thinking } from './settings';

// Fill-in data for the settings page. Models are suggestions (first is the
// default pick, chosen for cheap, fast translation); the user can type any ID.
// thinking is the value that suits translation: 'off' where the provider can
// turn thinking off, else the lowest level it accepts.
export interface Provider {
  id: string;
  name: string;
  format: ApiFormat;
  endpoint: string;
  models: string[];
  thinking: Thinking;
  keyUrl?: string;
  note?: string;
  // OpenAI format only: the provider's own switch for thinking 'off' when it
  // is not DeepSeek's thinking.type field ({} when thinking cannot be turned off),
  // and the output-limit field when it is not max_tokens.
  off?: Record<string, unknown>;
  tokenField?: 'max_completion_tokens';
}

export const CUSTOM_PROVIDER = 'custom';

export const PROVIDERS: Provider[] = [
  // https://api-docs.deepseek.com/ , https://api-docs.deepseek.com/guides/thinking_mode
  { id: 'deepseek', name: 'DeepSeek', format: 'openai', endpoint: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'], thinking: 'off', keyUrl: 'https://platform.deepseek.com/api_keys' },
  // https://developers.openai.com/api/docs/models (gpt-6-luna and gpt-6.1-terra accept reasoning effort none)
  { id: 'openai', name: 'OpenAI', format: 'openai', endpoint: 'https://api.openai.com/v1', models: ['gpt-6-luna', 'gpt-6.1-terra'], thinking: 'off', keyUrl: 'https://platform.openai.com/api-keys', off: { reasoning_effort: 'none' }, tokenField: 'max_completion_tokens' },
  // https://platform.claude.com/docs/en/api/overview ; Opus and Sonnet 5.5 reject thinking disabled, Haiku 5.5 accepts it.
  { id: 'anthropic', name: 'Anthropic Claude', format: 'anthropic', endpoint: 'https://api.anthropic.com', models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], thinking: 'off', keyUrl: 'https://platform.claude.com/settings/keys' },
  // https://aistudio.google.com/docs/openai , https://aistudio.google.com/docs/models ; Gemini 3 models cannot turn reasoning off.
  { id: 'gemini', name: 'Google Gemini', format: 'openai', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'], thinking: 'low', keyUrl: 'https://aistudio.google.com/apikey', off: {} },
  // https://openrouter.ai/docs/quickstart , https://openrouter.ai/api/v1/models , reasoning effort none disables reasoning
  { id: 'openrouter', name: 'OpenRouter', format: 'openai', endpoint: 'https://openrouter.ai/api/v1', models: ['deepseek/deepseek-v4.1-flash', 'google/gemini-3.5-flash-lite', 'openai/gpt-6-luna'], thinking: 'off', keyUrl: 'https://openrouter.ai/settings/keys', off: { reasoning: { effort: 'none' } } },
  // https://docs.siliconflow.cn/cn/userguide/quickstart , https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions
  { id: 'siliconflow', name: '硅基流动', format: 'openai', endpoint: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V4-Flash'], thinking: 'off', keyUrl: 'https://cloud.siliconflow.cn/account/ak', off: { enable_thinking: false } },
  // https://platform.kimi.com/docs/guide/start-using-kimi-api , https://platform.kimi.com/docs/guide/use-thinking-models ; K3.1 always reasons.
  { id: 'kimi', name: 'Kimi', format: 'openai', endpoint: 'https://api.moonshot.cn/v1', models: ['kimi-k3.1-pro-highspeed', 'kimi-k3.1-pro'], thinking: 'low', keyUrl: 'https://platform.kimi.com/console/api-keys', off: {} },
  // https://docs.bigmodel.cn/cn/guide/start/quick-start , https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode ; GLM-5.3 forces thinking.
  { id: 'zhipu', name: '智谱 GLM', format: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.7-flashx', 'glm-4.7-flash', 'glm-5.2'], thinking: 'off', keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys' },
  // https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope , https://help.aliyun.com/zh/model-studio/deep-thinking
  { id: 'dashscope', name: '阿里云百炼', format: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3.8-flash', 'qwen-flash', 'qwen-plus'], thinking: 'off', keyUrl: 'https://bailian.console.aliyun.com/model/settings/api-key', off: { enable_thinking: false } },
  // https://docs.ollama.com/api/openai-compatibility , https://docs.ollama.com/faq (extension origins are not allowed by default)
  { id: 'ollama', name: 'Ollama 本机', format: 'openai', endpoint: 'http://localhost:11434/v1', models: [], thinking: 'off', off: { reasoning_effort: 'none' }, note: '需设置 OLLAMA_ORIGINS=chrome-extension://*；Key 可填任意内容。' },
];

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find(provider => provider.id === id);
}

function sameEndpoint(a: string, b: string) {
  try { return normalizeEndpoint(a) === normalizeEndpoint(b); } catch { return false; }
}

// Stored settings may predate the provider field (the background then fills in
// the default 'deepseek'), so trust a preset only when its address and format
// still match; otherwise pick the preset that does, or custom.
export function resolveProvider(settings: { provider?: string; format: ApiFormat; endpoint: string }): string {
  if (settings.provider === CUSTOM_PROVIDER) return CUSTOM_PROVIDER;
  const matches = (provider: Provider) => provider.format === settings.format && sameEndpoint(provider.endpoint, settings.endpoint);
  const named = settings.provider ? providerById(settings.provider) : undefined;
  if (named && matches(named)) return named.id;
  return PROVIDERS.find(matches)?.id ?? CUSTOM_PROVIDER;
}
