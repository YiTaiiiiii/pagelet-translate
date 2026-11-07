import { providerById, resolveProvider } from '../shared/providers';
import { type ConnectionResult, type Settings, type Thinking } from '../shared/settings';
import { requestUsage, type UsageRecorder } from '../shared/usage';
export class ApiError extends Error {
  constructor(message: string, readonly policy: 'stop' | 'pause' | 'manual' = 'manual') { super(message); }
}
export interface Completion { content: string; finishReason: string }
export type Message = { role: 'system' | 'user'; content: string };
// Thinking spends output tokens and time before any text. Reasoning may be
// hidden (only a signature or nothing is streamed), so before the first text the
// wait is the level's first window, renewed by any activity; once text flows a
// 10 s stall on any activity counts as stuck.
export const LIMITS: Record<Thinking, { maxTokens: number; firstMs: number; totalMs: number }> = {
  off: { maxTokens: 2048, firstMs: 15_000, totalMs: 45_000 },
  default: { maxTokens: 8192, firstMs: 45_000, totalMs: 90_000 },
  low: { maxTokens: 8192, firstMs: 45_000, totalMs: 90_000 },
  medium: { maxTokens: 16_384, firstMs: 90_000, totalMs: 150_000 },
  high: { maxTokens: 32_000, firstMs: 120_000, totalMs: 240_000 },
};
const STALL_MS = 10_000;
// 'default' sends no thinking field: providers that do not know one may reject it.
export function requestFor(settings: Settings, messages: Message[]): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const { model, endpoint, apiKey, thinking } = settings, max_tokens = LIMITS[thinking].maxTokens;
  if (settings.format === 'anthropic') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    return {
      url: `${endpoint}${/\/v1$/.test(endpoint) ? '' : '/v1'}/messages`,
      // The request carries the extension's Origin, which the API refuses without this opt-in.
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      // No sampling parameters (current Claude models reject them) and no JSON
      // mode in this format; the system prompt asks for JSON.
      body: { model, max_tokens, ...(system ? { system } : {}), messages: messages.filter(m => m.role === 'user').map(({ role, content }) => ({ role, content })), stream: true,
        ...(thinking === 'off' ? { thinking: { type: 'disabled' } } : thinking !== 'default' ? { thinking: { type: 'adaptive' }, output_config: { effort: thinking } } : {}) },
    };
  }
  const preset = providerById(resolveProvider(settings));
  return {
    url: `${endpoint}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    // 'off' defaults to DeepSeek's switch (also GLM and DeepSeek gateways):
    // these think by default, which can use the whole output budget and leave
    // no translation. Presets whose address matches use their own switch.
    body: { model, messages, [preset?.tokenField ?? 'max_tokens']: max_tokens, temperature: 1.0, stream: true, stream_options: { include_usage: true }, response_format: { type: 'json_object' },
      ...(thinking === 'off' ? preset?.off ?? { thinking: { type: 'disabled' } } : thinking !== 'default' ? { reasoning_effort: thinking } : {}) },
  };
}
// Provider's own error text, so a wrong model ID or unsupported thinking level
// is diagnosable. Only the response is read; the Key is masked if echoed.
async function providerMessage(response: Response, apiKey: string) {
  try {
    const data = JSON.parse((await response.text()).slice(0, 20_000)), error = data?.error;
    return detail(typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : typeof data?.message === 'string' ? data.message : '', apiKey);
  } catch { return ''; }
}
function detail(message: string, apiKey: string) {
  const text = (apiKey ? message.split(apiKey).join('***') : message).replace(/\s+/g, ' ').trim();
  return text.length > 160 ? text.slice(0, 159) + '…' : text;
}
const BUSY = '服务繁忙，已暂停；稍后点击继续。';
// Small SSE call per format. No retries here: a lost response can still have been billed.
export async function complete(settings: Settings, messages: Message[], signal?: AbortSignal, record?: UsageRecorder, delta?: (content: string) => void): Promise<Completion> {
  const startedAt = Date.now(), start = performance.now(), controller = new AbortController(), limit = LIMITS[settings.thinking];
  const anthropic = settings.format === 'anthropic';
  let response: Response | undefined, usage: Record<string, unknown> | undefined, status: 'ok' | 'error' | 'cancelled' = 'error';
  let firstContentMs: number | null = null, timeout = '首段响应超时，请手动重试。';
  let idle = setTimeout(() => controller.abort(), limit.firstMs);
  const total = setTimeout(() => { timeout = `请求超过 ${limit.totalMs / 1000} 秒，请手动重试。`; controller.abort(); }, limit.totalMs);
  let content = '', finishReason = '', done = false;
  function alive() { clearTimeout(idle); idle = setTimeout(() => controller.abort(), firstContentMs === null ? limit.firstMs : STALL_MS); }
  function text(piece: string) {
    firstContentMs ??= performance.now() - start;
    timeout = '正文接收停滞，请手动重试。'; alive();
    content += piece;
    if (content.length > 128_000) throw new ApiError('响应过长，已停止接收。');
    delta?.(content);
  }
  function openai(data: any) {
    if (data.usage) usage = data.usage;
    const choice = data.choices?.[0];
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    // Visible reasoning shows the request is alive but is never translation text.
    if ((typeof choice?.delta?.reasoning_content === 'string' && choice.delta.reasoning_content) || (typeof choice?.delta?.reasoning === 'string' && choice.delta.reasoning)) alive();
    if (typeof choice?.delta?.content === 'string' && choice.delta.content) text(choice.delta.content);
  }
  function claude(name: string, data: any) {
    switch (data.type ?? name) {
      case 'message_start': usage = { ...data.message?.usage }; break;
      case 'content_block_delta':
        if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string' && data.delta.text) text(data.delta.text);
        else if (data.delta?.type === 'thinking_delta' || data.delta?.type === 'signature_delta') alive();
        break;
      case 'message_delta': {
        if (data.usage) usage = { ...usage, ...data.usage };
        const reason = data.delta?.stop_reason;
        if (reason === 'refusal') throw new ApiError('模型拒绝处理这段内容。');
        if (typeof reason === 'string') finishReason = reason === 'end_turn' || reason === 'stop_sequence' ? 'stop' : reason === 'max_tokens' || reason === 'model_context_window_exceeded' ? 'length' : reason;
        break;
      }
      case 'message_stop': done = true; break;
      case 'ping': alive(); break;
      case 'error': {
        if (data.error?.type === 'overloaded_error') throw new ApiError(BUSY, 'pause');
        const message = detail(typeof data.error?.message === 'string' ? data.error.message : '', settings.apiKey);
        throw new ApiError(`模型服务出错，请手动重试。${message ? `服务返回：${message}` : ''}`);
      }
    }
  }
  try {
    const request = requestFor(settings, messages);
    response = await fetch(request.url, {
      method: 'POST', headers: request.headers,
      credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      body: JSON.stringify(request.body),
    });
    if (response.status === 401 || response.status === 403) throw new ApiError('Key 未通过验证，请检查配置。', 'stop');
    if ([400,402,404,422].includes(response.status)) {
      const message = response.status === 402 ? '' : await providerMessage(response, settings.apiKey);
      throw new ApiError(`接口或账户配置有误（${response.status}），请检查设置。${message ? `服务返回：${message}` : ''}`, 'stop');
    }
    if (response.status === 429) throw new ApiError('服务限流，已暂停；稍后点击继续。', 'pause');
    if (anthropic && response.status === 529) throw new ApiError(BUSY, 'pause');
    if (!response.ok) throw new ApiError(`服务返回错误（${response.status}），请手动重试。`);
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new ApiError(`接口没有返回 ${anthropic ? 'Anthropic' : 'OAI'} 事件流，请检查配置。`, 'stop');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    function event(value: string) {
      const lines = value.split('\n');
      const payload = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
      if (!payload) return;
      if (!anthropic && payload === '[DONE]') { done = true; return; }
      let data;
      try { data = JSON.parse(payload); } catch { throw new ApiError('响应事件格式异常，请手动重试。'); }
      if (anthropic) claude(lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? '', data);
      else openai(data);
    }
    try {
      while (!done) {
        const next = await reader.read();
        buffer += decoder.decode(next.value, { stream: !next.done });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while (!done && (boundary = buffer.indexOf('\n\n')) !== -1) { event(buffer.slice(0,boundary)); buffer = buffer.slice(boundary+2); }
        if (next.done) break;
      }
      if (!done && buffer.trim()) event(buffer);
    } finally { await reader.cancel().catch(() => {}); }
    if (!finishReason || !done) throw new ApiError('响应中断，已完成段落保留；其余请手动重试。');
    // Cut off at the output limit with nothing written is a failed batch, not a configuration error.
    if (!content.trim() && finishReason === 'length') throw new ApiError('模型输出超出长度上限，请手动重试。');
    if (!content.trim()) throw new ApiError('模型没有返回正文，请检查配置。', 'stop');
    status = 'ok'; return { content, finishReason };
  } catch (error) {
    if (signal?.aborted) { status = 'cancelled'; throw new DOMException('请求已取消，用量可能未知。', 'AbortError'); }
    if (controller.signal.aborted) throw new ApiError(timeout);
    if (error instanceof ApiError) throw error;
    throw new ApiError('连接中断，请检查网络后手动重试。');
  } finally {
    clearTimeout(idle); clearTimeout(total);
    await record?.({ ...requestUsage(usage && { usage }, startedAt, performance.now()-start, status, response?.status ?? null), firstContentMs });
  }
}
// Formats without a JSON mode may wrap the object in a code fence or a short preface.
export function jsonObject(content: string): unknown {
  const begin = content.indexOf('{'), end = content.lastIndexOf('}');
  return JSON.parse(begin >= 0 && end > begin ? content.slice(begin, end + 1) : content);
}
export async function testConnection(settings: Settings, signal?: AbortSignal, record?: UsageRecorder): Promise<ConnectionResult> {
  const result = await complete(settings, [{ role: 'user', content: 'Translate Hello to Simplified Chinese. Respond with JSON: {"translation":"..."}.' }], signal, record);
  try { if (typeof (jsonObject(result.content) as { translation?: unknown }).translation !== 'string') throw new Error(); }
  catch { throw new ApiError('连接已建立，但响应格式不正确。'); }
  return { testedAt: new Date().toISOString() };
}
