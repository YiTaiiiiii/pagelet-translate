import { chromium, test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createSecureServer, type Http2SecureServer } from 'node:http2';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let context: BrowserContext;
let server: Http2SecureServer;
let temp: string;
let extensionUrl: string;
let endpoint: string;
let page: Page;
const requests: { url: string; body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
const FAKE_KEY = 'fixture-key-not-a-real-secret';
let held = false;
let flaky = 0;
let inFlight = 0;
let peak = 0;
const releases: (() => void)[] = [];
const readers: Page[] = [];
const fixture = `<!doctype html><html><head><title>Public reading fixture</title><style>body{font:16px/1.7 sans-serif;margin:36px}p{margin:12px 0}main{max-width:760px}</style></head><body><main class="markdown-body"><h1>Read comfortably</h1><p id="rich">Thanks <a class="user-mention notranslate" href="#ana">@ana</a>, matching <code class="notranslate">app</code> alone is wrong. Read the <a id="original-link" href="#guide">guide</a> and keep <code>npm install</code> in <strong>src/index.ts</strong>.</p><p id="update">A useful tool keeps the page readable.</p><p translate="no">Do not send this excluded sentence.</p><div contenteditable="true"><p>Private editor contents must stay local.</p></div><input value="private-form-value"><pre>private-command-value</pre><p>这一段本来就是中文，不用翻译。</p><div id="new-content"></div><p id="far" style="margin-top:3000px">Only translate <span style="position:relative;top:-99999px">(note)</span> this after scrolling.</p></main></body></html>`;

test.beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'page-translate-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temp, 'key.pem'), '-out', join(temp, 'cert.pem'), '-subj', '/CN=127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  server = createSecureServer({ key: await readFile(join(temp, 'key.pem')), cert: await readFile(join(temp, 'cert.pem')), allowHTTP1: true }, async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = Buffer.concat(parts).toString();
    if (request.url?.startsWith('/page')) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixture); return; }
    if (request.url?.startsWith('/units')) { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<main>'+Array.from({length:18}, (_,i)=>`<article><p>Visible paragraph number ${i} on this page.</p></article>`).join('')+'</main>'); return; }
    if (request.url?.startsWith('/lines')) { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<main style="font:16px/1.5 monospace">'+Array.from({length:60}, (_,i)=>`<p id="p${i}" style="width:40ch">${('Paragraph '+i+' fills this line').padEnd(40,'.')}</p>`).join('')+'</main>'); return; }
    if (request.url?.startsWith('/long')) { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<main style="font:16px/1.6 sans-serif;max-width:600px">'+Array.from({length:60}, (_,i)=>`<p id="p${i}">Long reading paragraph number ${i} keeps the reader busy for a while.</p>`).join('')+'</main>'); return; }
    if (request.url?.startsWith('/many')) { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<main>'+Array.from({length:18}, (_,i)=>`<p>Visible paragraph number ${i} on this page.</p>`).join('')+'</main>'); return; }
    if (request.method === 'POST') requests.push({ url: request.url!, body: JSON.parse(body), headers: request.headers });
    if (request.url?.startsWith('/unauthorized/')) { response.writeHead(401).end(JSON.stringify({ error: { message: `must-not-display-${FAKE_KEY}` } })); return; }
    if (request.url?.startsWith('/rejected/')) { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'model: unknown-model is not available' } })); return; }
    if (request.url?.startsWith('/limited/')) { response.writeHead(429).end('{}'); return; }
    if (request.url?.startsWith('/redirect/')) { response.writeHead(302, { Location: '/leaked/chat/completions' }).end(); return; }
    if (request.url?.startsWith('/empty/')) { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"choices":[]}'); return; }
    if (request.url?.startsWith('/cookie')) { response.writeHead(200, { 'Set-Cookie': 'private-cookie=do-not-send; Path=/' }).end('fixture'); return; }
    if (request.method === 'POST') {
      inFlight++; peak = Math.max(peak, inFlight); response.once('close', () => { inFlight--; });
      if (held) await new Promise<void>(resolveHeld => releases.push(resolveHeld));
      if (response.destroyed || response.writableEnded) return;
      const payload = JSON.parse(body);
      const claude = request.url?.endsWith('/v1/messages');
      if (payload.response_format || claude) {
        const users = claude ? payload.messages : payload.messages.slice(1);
        const batch = users.length > 1 ? JSON.parse(users[1].content) : null;
        const targetLanguage = /to ([a-zA-Z-]+)\./.exec(claude ? payload.system ?? '' : payload.messages[0].content)?.[1] || 'zh-CN';
        const prefix = ({'zh-CN':'译：',en:'Translated: ',fr:'Traduit : ',ru:'Перевод: ',ja:'翻訳：'} as Record<string,string>)[targetLanguage];
        const translations = batch?.items.map(({id,text}:{id:string;text:string})=> {
          let translation = text.includes('Lol-kept') ? text.replace(/,/g, '，').replace(/!/g, '！') : text.includes('malformed-response') || (text.includes('flaky-response') && flaky++ < 2) ? '' : text.includes('unsafe-model-output') ? '译：<img src=x onerror="document.documentElement.dataset.injection=1">' : `${prefix}${text}`;
          if (targetLanguage === 'zh-CN' && text === '这一段本来就是中文，不用翻译。') translation=text;
          if (text === 'Click <i0>Settings</i0> to disable <i1>sync</i1>.') translation='要禁用<i1>同步</i1>，请点击<i0>设置</i0>。';
          return {id,text:translation};
        });
        response.writeHead(200,{'Content-Type':'text/event-stream'});
        const content=JSON.stringify(batch ? {translations} : {translation:'你好'});
        if (claude) {
          // No JSON mode in this format: models may fence the object; thinking and pings are not text.
          const send = (data: Record<string, unknown>) => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
          send({type:'message_start',message:{usage:{input_tokens:30,cache_read_input_tokens:60,cache_creation_input_tokens:10,output_tokens:1}}});
          send({type:'ping'});
          send({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'{"translations":[{"id":"s0","text":"thinking"}]}'}});
          const fenced='```json\n'+content+'\n```';
          for (let i=0;i<fenced.length;i+=13) send({type:'content_block_delta',index:1,delta:{type:'text_delta',text:fenced.slice(i,i+13)}});
          send({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:20}});
          response.end(`event: message_stop\ndata: ${JSON.stringify({type:'message_stop'})}\n\n`);
          return;
        }
        // Deliberately split every JSON string/tag across SSE chunks.
        for (let i=0;i<content.length;i+=13) response.write('data: '+JSON.stringify({choices:[{delta:{content:content.slice(i,i+13)}}]})+'\n\n');
        response.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40}})+'\n\ndata: [DONE]\n\n');
        return;
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'fixture', choices: [{ message: { role: 'assistant', content: '你好' } }], usage: { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7, prompt_tokens_details: { cached_tokens: 0 } } }));
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  endpoint = `https://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const extensionDir = join(temp, 'extension');
  await cp(resolve('.output/chrome-mv3'), extensionDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
  // Test fixture only: pregrant loopback so headless Chrome has no native permission prompt.
  manifest.host_permissions = ['https://127.0.0.1/*', 'https://www.reddit.com/*', 'https://github.com/*', 'https://x.com/*'];
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 950 }, colorScheme: 'light',
    // Isolated test profile, only a local self-signed HTTP/2 fixture. HTTP/1 caps
    // each host at six sockets and cannot verify our ten-request concurrency.
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--ignore-certificate-errors'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const workerUrl = new URL(worker.url());
  extensionUrl = `${workerUrl.protocol}//${workerUrl.host}`;
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>(resolveClose => server?.close(() => resolveClose()));
  if (temp) await rm(temp, { recursive: true, force: true });
});

test.beforeEach(async () => {
  requests.length = 0;
  held = false; peak = 0; flaky = 0;
  page = await context.newPage();
  await page.goto(`${extensionUrl}/options.html`);
  await page.evaluate(() => chrome.storage.local.clear());
  await page.reload();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeEnabled();
});
test.afterEach(async () => { held = false; for (const release of releases.splice(0)) release(); for (const reader of readers.splice(0)) await reader.close(); await page?.close(); });

async function fillEndpoint(path = '/v1') {
  await page.getByLabel('API Key', { exact: true }).fill(FAKE_KEY);
  await page.getByRole('button', { name: /服务地址/ }).click();
  await page.getByLabel('API 服务地址').fill(`${endpoint}${path}`);
}

test('可安装，只有一个快捷键，默认不自动注入网页脚本和授予 API 主机权限', async () => {
  const manifest = JSON.parse(await readFile('.output/chrome-mv3/manifest.json', 'utf8'));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  expect(Object.keys(manifest.commands)).toEqual(['toggle-translation']);
  expect(manifest.options_ui.open_in_tab).toBe(true);
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('alert')).toContainText('请先填写 API Key');
  expect(requests).toHaveLength(0);
});

test('保存只写本地，重新打开保留设置，弹窗模式持久化', async () => {
  await page.getByLabel('API Key', { exact: true }).fill(FAKE_KEY);
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status')).toContainText('保存到本机');
  await page.reload();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue(FAKE_KEY);
  expect(await page.evaluate(() => chrome.storage.sync.get(null))).toEqual({});
  expect(requests).toHaveLength(0);
  await page.goto(`${extensionUrl}/popup.html`);
  await expect(page.getByRole('button', { name: '翻译此页' })).toBeEnabled();
  await page.getByRole('button', { name: '仅看译文' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '仅看译文' })).toHaveAttribute('aria-pressed', 'true');
});

test('标准 OAI 请求真实经过扩展后台，Key 不进入正文、Cookie 或响应提示', async () => {
  const cookiePage = await context.newPage();
  await cookiePage.goto(`${endpoint}/cookie`);
  await cookiePage.close();
  await fillEndpoint();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('deepseek-flash 已返回文字');
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.url).toBe('/v1/chat/completions');
  expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  expect(request.headers.cookie).toBeUndefined();
  expect(request.headers.referer).toBeUndefined();
  expect(request.body.model).toBe('deepseek-flash');
  expect(request.body.stream).toBe(true);
  expect(Object.keys(request.body).sort()).toEqual(['max_tokens','messages','model','response_format','stream','stream_options','temperature','thinking']);
  expect(JSON.stringify(request.body)).not.toContain(FAKE_KEY);
  expect(await page.getByRole('status').textContent()).not.toContain(FAKE_KEY);
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.reload();
  const testedAt = await page.evaluate(async () => ((await chrome.storage.local.get('settings.v1'))['settings.v1'] as { testedAt: string | null }).testedAt);
  expect(testedAt).toBeTruthy();
  await page.getByLabel('API Key', { exact: true }).fill(`${FAKE_KEY}-changed`);
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status')).toContainText('设置已保存');
  expect(await page.evaluate(async () => ((await chrome.storage.local.get('settings.v1'))['settings.v1'] as { testedAt: string | null }).testedAt)).toBeNull();
});

test('无效地址在发送前拦截，鉴权与限流显示清楚且不回显服务原文', async () => {
  await fillEndpoint();
  await page.getByLabel('API 服务地址').fill('http://example.com');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('HTTPS');
  expect(requests).toHaveLength(0);
  await page.getByLabel('API 服务地址').fill(`${endpoint}/unauthorized`);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Key 未通过验证');
  expect(await page.getByRole('alert').textContent()).not.toContain(FAKE_KEY);
  await page.getByLabel('API 服务地址').fill(`${endpoint}/limited`);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('限流');
  await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
});

test('拒绝重定向和空结果，不伪造连接成功', async () => {
  await fillEndpoint('/redirect');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('连接中断');
  expect(requests.map(request => request.url)).toEqual(['/redirect/chat/completions']);
  await page.getByLabel('API 服务地址').fill(`${endpoint}/empty`);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('没有返回 OAI');
});

test('选择服务商填入地址、格式、模型和思考强度并清空 Key，手动修改地址或格式切到自定义', async () => {
  const provider = page.getByLabel('服务商'), model = page.getByLabel('模型 ID'), thinking = page.getByLabel('思考强度'), key = page.getByLabel('API Key', { exact: true });
  const format = (name: string) => page.getByRole('button', { name, exact: true });
  await expect(provider).toHaveValue('deepseek');
  await expect(model).toHaveValue('deepseek-flash');
  await expect(thinking).toHaveValue('off');
  await expect(page.getByRole('link', { name: '获取 Key' })).toHaveAttribute('href', 'https://platform.deepseek.com/api_keys');
  await key.fill(FAKE_KEY);
  await provider.selectOption({ label: 'Kimi' });
  await expect(key).toHaveValue('');
  await expect(model).toHaveValue('kimi-k3.1-pro-highspeed');
  await expect(thinking).toHaveValue('low');
  await expect(format('OpenAI 兼容')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /服务地址/ })).toContainText('api.moonshot.cn');
  expect(await page.locator('#model-options option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['kimi-k3.1-pro-highspeed', 'kimi-k3.1-pro']);
  await provider.selectOption('anthropic');
  await expect(format('Anthropic 兼容')).toHaveAttribute('aria-pressed', 'true');
  await expect(model).toHaveValue('claude-haiku-5-5');
  await expect(thinking).toHaveValue('off');
  await format('OpenAI 兼容').click();
  await expect(provider).toHaveValue('custom');
  await expect(page.getByRole('link', { name: '获取 Key' })).toHaveCount(0);
  await provider.selectOption('openrouter');
  await key.fill(FAKE_KEY);
  await page.getByRole('button', { name: /服务地址/ }).click();
  await page.getByLabel('API 服务地址').fill(`${endpoint}/v1`);
  await expect(provider).toHaveValue('custom');
  await expect(key).toHaveValue(FAKE_KEY);
  await model.fill('');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('alert')).toContainText('请填写模型 ID');
  await model.fill('fixture-model');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('fixture-model 已返回文字');
  expect(requests.map(request => request.body.model)).toEqual(['fixture-model']);
});

test('模型和思考强度保存后保留，旧版设置按地址和格式匹配服务商', async () => {
  const provider = page.getByLabel('服务商'), model = page.getByLabel('模型 ID'), thinking = page.getByLabel('思考强度');
  await page.getByLabel('API Key', { exact: true }).fill(FAKE_KEY);
  await model.fill('deepseek-v4-pro');
  await thinking.selectOption({ label: '中' });
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status')).toContainText('设置已保存');
  await page.reload();
  await expect(provider).toHaveValue('deepseek');
  await expect(model).toHaveValue('deepseek-v4-pro');
  await expect(thinking).toHaveValue('medium');
  expect(await page.evaluate(async () => (await chrome.storage.local.get('settings.v1'))['settings.v1'])).toMatchObject({ provider: 'deepseek', format: 'openai', model: 'deepseek-v4-pro', thinking: 'medium' });
  const legacy = async (endpoint: string) => {
    await page.evaluate(async endpoint => chrome.storage.local.set({ 'settings.v1': { endpoint, apiKey: 'fixture-key-not-a-real-secret', mode: 'bilingual', testedAt: null } }), endpoint);
    await page.reload();
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue(FAKE_KEY);
  };
  await legacy('https://openrouter.ai/api/v1');
  await expect(provider).toHaveValue('openrouter');
  await expect(model).toHaveValue('deepseek-flash');
  await expect(thinking).toHaveValue('off');
  await legacy(`${endpoint}/v1`);
  await expect(provider).toHaveValue('custom');
  await expect(page.getByLabel('API 服务地址')).toHaveValue(`${endpoint}/v1`);
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status')).toContainText('设置已保存');
  expect(await page.evaluate(async () => (await chrome.storage.local.get('settings.v1'))['settings.v1'])).toMatchObject({ provider: 'custom', format: 'openai', model: 'deepseek-flash', thinking: 'off' });
  expect(requests).toHaveLength(0);
});

test('实际安装后的首次配置与弹窗截图', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/extension-settings-light.png', fullPage: true, animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'test-results/extension-settings-dark.png', fullPage: true, animations: 'disabled' });
  await page.getByLabel('服务商').selectOption('ollama');
  await page.getByRole('button', { name: /服务地址/ }).click();
  await page.screenshot({ path: 'test-results/extension-settings-endpoint-dark.png', fullPage: true, animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: 'test-results/extension-settings-endpoint-light.png', fullPage: true, animations: 'disabled' });
  await page.goto(`${extensionUrl}/popup.html`);
  await expect(page.getByRole('button', { name: '配置模型服务' })).toBeEnabled();
  await page.getByRole('region', { name: '原页翻译面板' }).screenshot({ path: 'test-results/extension-popup-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('region', { name: '原页翻译面板' }).screenshot({ path: 'test-results/extension-popup-dark.png' });
});

async function readPage(path = '/page') {
  await page.evaluate(async ({ endpoint, apiKey }) => chrome.runtime.sendMessage({ type: 'save-settings', settings: { endpoint, apiKey, mode: 'bilingual', testedAt: null } }), { endpoint: `${endpoint}/v1`, apiKey: FAKE_KEY });
  const reader = await context.newPage(); readers.push(reader);
  await reader.goto(`${endpoint}${path}`);
  await reader.bringToFront();
  return reader;
}
test('Anthropic 格式经扩展后台请求 Messages，思考与 ping 不进译文，围栏内的 JSON 可用', async () => {
  const settings = { format: 'anthropic', endpoint, apiKey: FAKE_KEY, model: 'claude-example', thinking: 'medium', mode: 'bilingual', testedAt: null };
  const tested = await page.evaluate(settings => chrome.runtime.sendMessage({ type: 'test-connection', settings }), settings);
  expect(tested.ok, tested.error).toBe(true);
  const request = requests[0]!;
  expect(request.url).toBe('/v1/messages');
  expect(request.headers['x-api-key']).toBe(FAKE_KEY);
  expect(request.headers['anthropic-version']).toBe('2023-06-01');
  expect(request.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  expect(request.headers.authorization).toBeUndefined();
  expect(request.body).toMatchObject({ model: 'claude-example', max_tokens: 16384, stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
  expect(Object.keys(request.body).sort()).toEqual(['max_tokens','messages','model','output_config','stream','thinking']);
  const saved = await page.evaluate(settings => chrome.runtime.sendMessage({ type: 'save-settings', settings }), settings);
  expect(saved.ok).toBe(true);
  const reader = await context.newPage(); readers.push(reader);
  await reader.goto(`${endpoint}/page`); await reader.bringToFront(); await toggleReader();
  await expect(reader.locator('#update [data-pagelet-output]')).toHaveText('译：A useful tool keeps the page readable.');
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(3);
  expect(await reader.locator('body').textContent()).not.toContain('thinking');
  const translation = requests.find(item => item.url === '/v1/messages' && typeof item.body.system === 'string')!;
  expect(translation.body.system).toContain('Return JSON only');
  const records = (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get-usage' }))).data;
  expect(records.filter((r: any) => r.kind === 'translation').every((r: any) => r.inputTokens === 100 && r.outputTokens === 20 && r.cacheReadTokens === 60)).toBe(true);
});
test('模型或思考设置被服务拒绝时，提示里带上服务的原因', async () => {
  for (const format of ['openai', 'anthropic']) {
    const reply = await page.evaluate(settings => chrome.runtime.sendMessage({ type: 'test-connection', settings }), { format, endpoint: `${endpoint}/rejected`, apiKey: FAKE_KEY, model: 'unknown-model', thinking: 'off', mode: 'bilingual', testedAt: null });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('（400）');
    expect(reply.error).toContain('unknown-model is not available');
  }
  expect(requests.map(request => request.url)).toEqual(['/rejected/chat/completions', '/rejected/v1/messages']);
});
async function toggleReader() {
  const reply = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'pagelet-toggle' }));
  expect(reply.ok, reply.error).toBe(true);
  return reply.data;
}
async function switchMode(mode: string) {
  const reply = await page.evaluate(mode => chrome.runtime.sendMessage({ type: 'save-mode', mode }), mode);
  expect(reply.ok, reply.error).toBe(true);
}

test('真实 DOM 双语、替换、恢复，链接身份和代码保留', async () => {
  const reader = await readPage();
  const original = await reader.locator('main').innerHTML();
  await reader.evaluate(() => { (window as any).originalLink = document.querySelector('#original-link'); });
  await toggleReader();
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(3);
  await expect(reader.locator('#rich [data-pagelet-output] a:not(.user-mention)')).toHaveAttribute('href', `${endpoint}/page#guide`);
  await expect(reader.locator('#rich [data-pagelet-output] code:not(.notranslate)')).toHaveText('npm install');
  await expect(reader.locator('#rich [data-pagelet-output] strong')).toContainText('src/index.ts');
  // GitHub-style .notranslate inline code and mentions stay inside one paragraph.
  await expect(reader.locator('#rich [data-pagelet-output]')).toHaveCount(1);
  await expect(reader.locator('#rich [data-pagelet-output] code.notranslate')).toHaveText('app');
  await expect(reader.locator('#rich [data-pagelet-output] a.user-mention')).toHaveText('@ana');
  const sent = JSON.stringify(requests.map(request => request.body));
  for (const excluded of ['private-form-value', 'private-command-value', 'Private editor', 'Do not send', 'Only translate']) expect(sent).not.toContain(excluded);
  await switchMode('translated');
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(0);
  await expect(reader.locator('#rich')).toContainText('译：');
  await expect(reader.locator('#rich code:not(.notranslate)')).toHaveText('npm install');
  expect(await reader.evaluate(() => (window as any).originalLink === document.querySelector('#original-link'))).toBe(true);
  await toggleReader();
  expect(await reader.locator('main').innerHTML()).toBe(original);
});

test('新增内容与网站自行更新能翻译，滚动前不发送远处段落', async () => {
  const reader = await readPage();
  await toggleReader();
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(3);
  await reader.evaluate(() => {
    document.querySelector('#update')!.textContent = 'This paragraph changed on the website.';
    const p = document.createElement('p'); p.id = 'new-paragraph'; p.textContent = 'New comment loaded after opening.';
    document.querySelector('#new-content')!.append(p);
  });
  await expect(reader.locator('#new-paragraph [data-pagelet-output]')).toContainText('New comment');
  await expect(reader.locator('#update [data-pagelet-output]')).toContainText('paragraph changed');
  await reader.locator('#far').scrollIntoViewIfNeeded();
  await expect(reader.locator('#far [data-pagelet-output]')).toContainText('after scrolling');
  await toggleReader();
  await expect(reader.locator('#update')).toHaveText('This paragraph changed on the website.');
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(0);
});

test('译文插在正在读的段落上方时，阅读位置不动', async () => {
  const reader = await readPage('/long');
  await reader.evaluate(() => { const p = document.querySelector('#p30')!; scrollTo({ top: p.getBoundingClientRect().top + scrollY - innerHeight * .3, behavior: 'instant' }); });
  const top = () => reader.evaluate(() => document.querySelector('#p30')!.getBoundingClientRect().top);
  const before = await top(), scrolled = await reader.evaluate(() => scrollY);
  await toggleReader();
  await expect(reader.locator('#p25 [data-pagelet-output]')).toContainText('译：');
  await expect(reader.locator('#p30 [data-pagelet-output]')).toContainText('译：');
  expect(Math.abs(await top() - before)).toBeLessThan(2);
  expect(await reader.evaluate(() => scrollY)).toBeGreaterThan(scrolled + 50);
});

test('等待标记让上方段落多出一行时，阅读位置也不动', async () => {
  const reader = await readPage('/lines');
  await reader.evaluate(() => { const p = document.querySelector('#p30')!; scrollTo({ top: p.getBoundingClientRect().top + scrollY - innerHeight * .3, behavior: 'instant' }); });
  const top = () => reader.evaluate(() => document.querySelector('#p30')!.getBoundingClientRect().top);
  const before = await top(), height = await reader.evaluate(() => document.querySelector('#p25')!.getBoundingClientRect().height);
  held = true;
  await toggleReader();
  await expect(reader.locator('#p25 [data-pagelet-hint="pending"]')).toHaveCount(1);
  expect(await reader.evaluate(() => document.querySelector('#p25')!.getBoundingClientRect().height)).toBeGreaterThan(height);
  expect(Math.abs(await top() - before)).toBeLessThan(2);
  held = false; for (const release of releases.splice(0)) release();
  await expect(reader.locator('#p30 [data-pagelet-output]')).toContainText('译：');
  expect(Math.abs(await top() - before)).toBeLessThan(2);
});

test('两页共享最多 10 并发，首批不超过 3 段，之后不超过 6 段', async () => {
  const first=await readPage('/units');await first.setViewportSize({width:1000,height:1400});held=true;await toggleReader();
  await expect.poll(()=>inFlight).toBe(10);
  const second=await context.newPage();readers.push(second);await second.goto(`${endpoint}/units?second`);await second.bringToFront();await toggleReader();
  held=false;releases.splice(0).forEach(r=>r());
  await expect(first.locator('[data-pagelet-output]')).toHaveCount(18);await expect(second.locator('[data-pagelet-output]')).toHaveCount(18);
  expect(peak).toBe(10);
});
test('关闭不回填在途结果，再开和切换模式零新增请求；语言切回也复用', async () => {
  const reader=await readPage('/many');held=true;await toggleReader();await expect.poll(()=>inFlight).toBe(4);
  await toggleReader();held=false;releases.splice(0).forEach(r=>r());await expect.poll(()=>inFlight).toBe(0);
  await expect.poll(async()=> (await page.evaluate(()=>chrome.runtime.sendMessage({type:'get-usage'}))).data.length).toBe(4);
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(0);
  const count=requests.length;await toggleReader();await expect(reader.locator('[data-pagelet-output]')).toHaveCount(18);
  await switchMode('translated');await toggleReader();await toggleReader();expect(requests).toHaveLength(count);
  expect(JSON.parse((requests[0]!.body.messages as any[])[2].content).items.length).toBe(3);
  expect(requests.every(r=>JSON.parse((r.body.messages as any[])[2].content).items.length<=6)).toBe(true);
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'save-languages',languages:{sourceLanguage:'auto',targetLanguage:'fr'}}));
  await expect(reader.locator('p').first()).toContainText('Traduit');
  const french=requests.length;
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'save-languages',languages:{sourceLanguage:'auto',targetLanguage:'zh-CN'}}));
  await expect(reader.locator('p').first()).toContainText('译：');expect(requests).toHaveLength(french);
});

test('后台休眠重启后仍能继续翻译新进入视野的段落', async () => {
  const reader = await readPage();
  await toggleReader();
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(3);
  const cdp = await context.newCDPSession(reader);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await reader.locator('#far').scrollIntoViewIfNeeded();
  await expect(reader.locator('#far [data-pagelet-output]')).toContainText('after scrolling');
  await toggleReader();
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(0);
  await cdp.detach();
});

test('Reddit 结构样本的正文、直接文本评论和新增评论可以恢复', async () => {
  const reader = await readPage();
  // A local fixture at a routed URL exercises the Reddit selector branch.
  // This is not evidence that the live Reddit website passed acceptance.
  await reader.route('https://www.reddit.com/r/pagelet_fixture/**', route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Reading the web comfortably</h1><div slot="text-body"><p>A thoughtful post with <a href="/r/example">a useful link</a>.</p></div><shreddit-comment><div slot="comment">A direct text comment is readable.</div><button>Reply without translating this button</button></shreddit-comment><aside><p>Unrelated sidebar text must stay local.</p></aside></main>' }));
  await reader.goto('https://www.reddit.com/r/pagelet_fixture/comments/example');
  const original = await reader.locator('main').innerHTML();
  await toggleReader();
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(3);
  await expect(reader.locator('[slot="comment"] [data-pagelet-output]')).toContainText('direct text comment');
  expect(JSON.stringify(requests.map(request => request.body))).not.toContain('Unrelated sidebar');
  expect(JSON.stringify(requests.map(request => request.body))).not.toContain('Reply without');
  await switchMode('translated');
  await expect(reader.locator('[slot="comment"]')).toContainText('译：');
  await toggleReader();
  expect(await reader.locator('main').innerHTML()).toBe(original);
  await toggleReader();
  await reader.evaluate(() => {
    const wrapper = document.createElement('shreddit-comment');
    wrapper.innerHTML = '<div slot="comment">Another comment appeared after opening.</div>';
    document.querySelector('main')!.append(wrapper);
  });
  await expect(reader.locator('[slot="comment"]').last()).toContainText('译：');
  await toggleReader();
  await expect(reader.locator('[slot="comment"]').last()).toHaveText('Another comment appeared after opening.');
});

test('模型编造的 HTML 标签被去掉、不进 DOM，格式错误保留原文并提示', async () => {
  const reader = await readPage();
  await reader.locator('main').evaluate(main => { main.innerHTML = '<p id="unsafe">Test unsafe-model-output handling.</p><p id="malformed">Test malformed-response handling.</p>'; });
  await toggleReader();
  await expect(reader.locator('#unsafe [data-pagelet-output]')).toHaveText('译：');
  await expect(reader.locator('img')).toHaveCount(0);
  expect(await reader.locator('html').getAttribute('data-injection')).toBeNull();
  await expect(reader.locator('#malformed [data-pagelet-output]')).toHaveCount(0);
  await expect(reader.locator('#malformed [data-pagelet-hint="failed"]')).toHaveText('翻译失败 · 重试');
  await expect.poll(async () => (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'pagelet-get-state' }))).data.failed).toBe(1);
  await toggleReader();
  await expect(reader.locator('#unsafe')).toHaveText('Test unsafe-model-output handling.');
});

test('GitHub 警告栏译文不挤入 flex 行，表情和数字不单独送模型', async () => {
  const reader = await readPage();
  await reader.locator('main').evaluate(main => { main.innerHTML = '<div style="padding:20px"><p id="alert" style="display:flex;align-items:center;color:rgb(160,110,0)"><svg width="16" height="16" aria-hidden="true"></svg>Warning</p><h3 id="notes"><g-emoji>⚠️</g-emoji> Important Notes:</h3><p id="number">Keep at least <span>3</span> copies.</p></div>'; });
  const original = await reader.locator('main').innerHTML();
  await toggleReader();
  const output = reader.locator('#alert + [data-pagelet-output]');
  await expect(output).toContainText('Warning');
  const layout = await reader.evaluate(() => {
    const source = document.querySelector('#alert')!;
    const translation = source.nextElementSibling!;
    return { sourceBottom: source.getBoundingClientRect().bottom, translationTop: translation.getBoundingClientRect().top, sourceStyle: source.getAttribute('style'), border: getComputedStyle(translation).borderLeftWidth, color: getComputedStyle(translation).color };
  });
  expect(layout.translationTop).toBeGreaterThanOrEqual(layout.sourceBottom);
  expect(layout.sourceStyle).toBe('display:flex;align-items:center;color:rgb(160,110,0)');
  expect(layout.border).toBe('0px');
  // Follows the alert's own colour, a little softer than the original.
  expect(layout.color).toBe('color(srgb 0.627451 0.431373 0 / 0.74)');
  const inputs = requests.flatMap(request => JSON.parse((request.body.messages as { content: string }[])[2]!.content).items);
  expect(inputs.some(input => input.text === '⚠️ Important Notes:')).toBe(true);
  expect(inputs.some(input => input.text === 'Keep at least <k0>3</k0> copies.')).toBe(true);
  await expect(reader.locator('#notes [data-pagelet-output]')).toContainText('⚠️');
  await switchMode('translated');
  await expect(reader.locator('#notes')).toContainText('⚠️');
  await expect(reader.locator('#number')).toContainText('3');
  await toggleReader();
  expect(await reader.locator('main').innerHTML()).toBe(original);
});

test('仓库打开时翻译提交与简介，跳过文件名和按钮，重复提交及网站重绘不重复请求', async () => {
  const reader = await readPage();
  const row = '<tr><td class="react-directory-row-name-cell-large-screen"><a href="/repo/tree/main/src">src</a></td><td class="react-directory-row-commit-cell"><div><a class="Link--secondary" href="/repo/commit/abc">chore(frontend): migrate npm to pnpm</a></div></td><td><relative-time>3 months ago</relative-time></td></tr>';
  await reader.route('https://github.com/UNIkeEN/SJMCL', route => route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><title>Repository fixture</title><style>td{padding:6px}.Link--secondary{color:rgb(140,150,160)}</style><main><ul class="pagehead-actions"><li><a class="btn" href="#star">Star repository</a></li></ul><span data-testid="latest-commit-html"><a href="/repo/commit/latest">Merge pull request</a></span><table><tbody>${row.repeat(3)}</tbody></table><p id="about">A Minecraft launcher built with the community.</p><div hidden><p>Private hidden duplicate.</p></div><article class="markdown-body" style="margin-top:3000px"><p>README should wait until scrolling.</p></article></main>`}));
  await reader.goto('https://github.com/UNIkeEN/SJMCL'); await reader.bringToFront();
  const cell = reader.locator('.react-directory-row-commit-cell').first();
  const original = await cell.innerHTML();
  await toggleReader();
  await expect(reader.locator('.react-directory-row-commit-cell [data-pagelet-output]')).toHaveCount(3);
  await expect(reader.locator('#about [data-pagelet-output]')).toBeVisible();
  await expect(reader.locator('main > [data-pagelet-output]')).toContainText('译：Merge pull request');
  await expect.poll(async () => (await page.evaluate(() => chrome.runtime.sendMessage({type:'pagelet-get-state'}))).data.pending).toBe(0);
  const inputs = requests.flatMap(request => JSON.parse((request.body.messages as {content:string}[])[2]!.content).items);
  expect(inputs.filter(input => input.text.includes('migrate npm to pnpm'))).toHaveLength(1);
  expect(JSON.stringify(inputs)).not.toMatch(/Star repository|README should|Private hidden|3 months ago/);
  await expect(reader.locator('td[class*="row-name-cell"] [data-pagelet-output],.pagehead-actions [data-pagelet-output]')).toHaveCount(0);
  expect(await cell.locator('[data-pagelet-output] a').evaluate(a => getComputedStyle(a).color)).toBe('rgb(140, 150, 160)');
  const count = requests.length;
  await cell.evaluate((element, html) => { element.innerHTML = html; }, original);
  await expect(cell.locator('[data-pagelet-output]')).toBeVisible();
  expect(requests).toHaveLength(count);
  await cell.evaluate(element => { (window as any).latestLink = element.querySelector('a'); });
  await switchMode('translated');
  expect(await cell.evaluate(element => (window as any).latestLink === element.querySelector('a'))).toBe(true);
  await toggleReader();
  expect(await cell.innerHTML()).toBe(original);
});

test('完整段落可调整链接与强调文字顺序，恢复原节点和监听器，保留网站新内容', async () => {
  const reader = await readPage();
  await reader.locator('main').evaluate(main => { main.innerHTML = '<p id="order">Click <a id="settings" href="#settings">Settings</a> to disable <strong>sync</strong>.</p>'; });
  const original = await reader.locator('main').innerHTML();
  await reader.evaluate(() => {
    (window as any).savedLink = document.querySelector('#settings');
    (window as any).savedText = document.querySelector('#order')!.firstChild;
    document.querySelector('#settings')!.addEventListener('click', event => { event.preventDefault(); document.body.dataset.clicked = 'yes'; });
  });
  await toggleReader();
  await expect(reader.locator('#order [data-pagelet-output]')).toHaveText('要禁用同步，请点击设置。');
  await switchMode('translated');
  await expect(reader.locator('#order')).toHaveText('要禁用同步，请点击设置。');
  await reader.locator('#settings').click();
  expect(await reader.locator('body').getAttribute('data-clicked')).toBe('yes');
  expect(await reader.evaluate(() => (window as any).savedLink === document.querySelector('#settings'))).toBe(true);
  await toggleReader();
  expect(await reader.locator('main').innerHTML()).toBe(original);
  expect(await reader.evaluate(() => (window as any).savedText === document.querySelector('#order')!.firstChild)).toBe(true);
  await toggleReader();
  await expect(reader.locator('#order')).toHaveText('要禁用同步，请点击设置。');
  await reader.locator('#order').evaluate(element => { element.textContent = 'New website content must survive restoration.'; });
  await expect(reader.locator('#order')).toContainText('译：New website');
  await toggleReader();
  await expect(reader.locator('#order')).toHaveText('New website content must survive restoration.');
});

test('Reddit 回复带父评论上下文，排除相邻评论、隐藏内容和编辑器', async () => {
  const reader = await readPage();
  await reader.route('https://www.reddit.com/r/context_fixture/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Minecraft discussion</title><main><shreddit-comment><div slot="comment"><p>The cache is stale.<code>secret-code</code><span hidden>hidden-context-secret</span><span style="display:none">css-hidden-secret</span><span contenteditable="true">editor-secret</span></p></div><shreddit-comment><div slot="comment">That does not fix it.</div></shreddit-comment></shreddit-comment><shreddit-comment><div slot="comment">Unrelated sibling discussion.</div></shreddit-comment></main>' }));
  await reader.goto('https://www.reddit.com/r/context_fixture/comments/example');
  await toggleReader();
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(3);
  const batches = requests.map(request => JSON.parse((request.body.messages as { content: string }[])[2]!.content));
  const inputs = batches.flatMap(batch => batch.items);
  const reply = inputs.find(input => input.text === 'That does not fix it.');
  const batch = batches.find(value => value.items.includes(reply));
  expect(batch.notes[reply.note]).toContain('The cache is stale.');
  expect(JSON.stringify(reply)).not.toContain('Unrelated sibling');
  for (const excluded of ['hidden-context-secret', 'css-hidden-secret', 'editor-secret']) expect(JSON.stringify(inputs)).not.toContain(excluded);
});

test('弹窗直接选择源和目标语言，支持五种语言，未配置 Key 也会记住选择', async () => {
  await page.goto(`${extensionUrl}/popup.html`);
  await expect(page.getByLabel('源语言')).toHaveValue('auto');
  await expect(page.getByLabel('目标语言')).toHaveValue('zh-CN');
  expect(await page.getByLabel('源语言').locator('option').allTextContents()).toEqual(['自动检测', '简体中文', '英语', '法语', '俄语', '日语']);
  expect(await page.getByLabel('目标语言').locator('option').allTextContents()).toEqual(['简体中文', '英语', '法语', '俄语', '日语']);
  await page.getByLabel('源语言').selectOption('ja');
  await expect(page.getByLabel('目标语言')).toBeEnabled();
  await page.getByLabel('目标语言').selectOption('en');
  await expect(page.getByLabel('目标语言')).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('源语言')).toHaveValue('ja');
  await expect(page.getByLabel('目标语言')).toHaveValue('en');
});

test('翻译过程中改目标会取消旧请求并重译，不混入旧译文', async () => {
  const reader = await readPage('/many');
  held = true;
  await toggleReader();
  await expect.poll(() => inFlight).toBe(4);
  const result = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'save-languages', languages: { sourceLanguage: 'auto', targetLanguage: 'ru' } }));
  expect(result.ok).toBe(true);
  await expect.poll(() => requests.some(request => (request.body.messages as any[])[0].content.includes('to ru.'))).toBe(true);
  held = false; for (const release of releases.splice(0)) release();
  await expect(reader.locator('[data-pagelet-output][lang="ru"]')).toHaveCount(18);
  expect(await reader.locator('[data-pagelet-output]').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('Перевод:')]));
  expect((await reader.locator('[data-pagelet-output]').allTextContents()).every(text => !text.includes('译：'))).toBe(true);
  expect(peak).toBeLessThanOrEqual(10);
});

test('其他标签页继续使用原语言，中文原文也能发往新目标', async () => {
  const first = await readPage(); await toggleReader();
  await expect(first.locator('[data-pagelet-output]')).toHaveCount(3);
  const second = await context.newPage(); readers.push(second);
  await second.goto(`${endpoint}/page`); await second.bringToFront();
  const saved = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'save-languages', languages: { sourceLanguage: 'auto', targetLanguage: 'fr' } }));
  expect(saved.ok).toBe(true);
  await toggleReader();
  await expect(second.locator('[data-pagelet-output][lang="fr"]')).toHaveCount(4);
  expect(JSON.stringify(requests.map(request => request.body))).toContain('这一段本来就是中文');
  await first.bringToFront(); await first.locator('#far').scrollIntoViewIfNeeded();
  await expect(first.locator('#far [data-pagelet-output]')).toHaveAttribute('lang', 'zh-CN');
  const config = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get-settings' }));
  expect(config.data.targetLanguage).toBe('zh-CN');
});

test('本页和持久记录使用实际 usage，最近记录不含 URL、原文或 Key',async()=> {
  const reader=await readPage('/many');await toggleReader();await expect(reader.locator('[data-pagelet-output]')).toHaveCount(18);
  const all=(await page.evaluate(()=>chrome.runtime.sendMessage({type:'get-usage'}))).data;
  expect(all).toHaveLength(4);expect(all.every((r:any)=>r.inputTokens===100 && r.outputTokens===20 && r.cacheReadTokens===60 && r.averageTps>0 && r.firstContentMs>=0)).toBe(true);
  const state=(await page.evaluate(()=>chrome.runtime.sendMessage({type:'pagelet-get-state'}))).data;
  expect(state.usage).toEqual({requests:4,input:400,output:80,hit:240,unknown:0});
  for(const excluded of ['Visible paragraph',endpoint,FAKE_KEY]) expect(JSON.stringify(all)).not.toContain(excluded);
});
test('开放 Shadow DOM 和 div 直接文字保持顺序；导航区域按需开启',async()=> {
  const reader=await readPage();
  await reader.locator('main').evaluate(main=>{main.innerHTML='<nav>Navigation text</nav><div id="direct">Before text<p>Inner paragraph</p>After text</div><div id="host"></div>';document.querySelector('#host')!.attachShadow({mode:'open'}).innerHTML='<p>Shadow paragraph with <strong>emphasis</strong>.</p>';});
  const original=await reader.locator('#direct').innerHTML();await toggleReader();
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(4);
  await expect(reader.locator('#host [data-pagelet-output]')).toContainText('Shadow paragraph');
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'save-scope',scope:'all'}));await expect(reader.locator('nav [data-pagelet-output]')).toBeVisible();
  await switchMode('translated');await toggleReader();expect(await reader.locator('#direct').innerHTML()).toBe(original);
});
test('同文档路由复用，刷新重译，跨站和新标签默认关闭',async()=> {
  const reader=await readPage();await toggleReader();await expect(reader.locator('[data-pagelet-output]')).toHaveCount(3);
  const count=requests.length;
  await reader.evaluate(()=>history.pushState({},'', '#anchor'));await switchMode('translated');await switchMode('bilingual');expect(requests).toHaveLength(count);
  await reader.evaluate(()=>history.pushState({},'', '/page?next'));
  await switchMode('translated');
  await switchMode('bilingual');
  expect(requests).toHaveLength(count);
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(3);
  // A new document starts a new page session; finished translations come from
  // the background session memo without new model requests.
  const next=requests.length;await reader.goto(`${endpoint}/page?reload`);await expect(reader.locator('[data-pagelet-output]')).toHaveCount(3);expect(requests).toHaveLength(next);
  expect((await page.evaluate(()=>chrome.runtime.sendMessage({type:'pagelet-get-state'}))).data.usage?.requests ?? 0).toBe(0);
  await reader.route('https://example.com/**',r=>r.fulfill({contentType:'text/html',body:'<main><p>Other origin.</p></main>'}));
  await reader.goto('https://example.com/');await expect.poll(async()=> (await page.evaluate(()=>chrome.runtime.sendMessage({type:'pagelet-get-state'}))).data.enabled).toBe(false);
});

const feedFixture = '<!doctype html><title>Feed fixture</title><style>body{margin:0;font:16px/1.6 sans-serif}main{width:600px;margin:auto}article{box-sizing:border-box;min-height:420px;padding:20px;border-bottom:1px solid #ccc}</style><main>'+Array.from({length:24},(_,i)=>`<article data-testid="tweet" id="post-${i}"><div data-testid="User-Name"><a href="/writer">Writer Name</a><a href="/writer/status/${100+i}"><time>Oct 12</time></a></div><div data-testid="tweetText">Post number ${i}: Read this independent statement before moving to the next item in the feed.</div><button>Reply Like Repost</button></article>`).join('')+'</main>';

async function readFeed() {
  const reader = await readPage();
  await reader.route('https://x.com/pagelet_fixture/**', route => route.fulfill({contentType:'text/html',body:feedFixture}));
  await reader.goto('https://x.com/pagelet_fixture/home');
  await toggleReader(); return reader;
}

test('信息流未入屏就有译文，短帖合批，回滚和虚拟列表重建复用', async () => {
  const reader = await readFeed();
  await expect(reader.locator('#post-3 [data-pagelet-output]')).toHaveCount(1);
  expect(await reader.locator('#post-3').evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThan(950);
  const inputs = requests.flatMap(r => JSON.parse((r.body.messages as any[])[2].content).items);
  expect(inputs.length).toBeGreaterThanOrEqual(4);
  expect(requests.length).toBeLessThan(inputs.length);
  const bodies = JSON.stringify(requests.map(r => r.body));
  expect(bodies).not.toContain('Writer Name'); expect(bodies).not.toContain('Reply Like');
  expect(bodies).not.toContain('Post number 12:');
  expect(inputs.every(i => i.unit && !i.supplement)).toBe(true);
  // Each independent body is sent only once, not copied into a context prefix.
  expect((bodies.match(/Read this independent statement/g) || []).length).toBe(inputs.length);
  const count = requests.length;
  await reader.evaluate(() => {
    const old = document.querySelector('#post-1')!;
    const clone = old.cloneNode(true) as Element; clone.querySelectorAll('[data-pagelet-output]').forEach(el => el.remove()); old.replaceWith(clone);
  });
  await expect(reader.locator('#post-1 [data-pagelet-output]')).toHaveCount(1);
  expect(requests.length).toBe(count);
  await reader.evaluate(() => scrollTo(0,420));
  await expect(reader.locator('#post-3 [data-pagelet-output]')).toHaveCount(1);
  await reader.evaluate(() => scrollTo(0,0));
  await expect(reader.locator('#post-1 [data-pagelet-output]')).toHaveCount(1);
  await reader.screenshot({path:'test-results/feed-prefetch-040.png'});
  await toggleReader(); await expect(reader.locator('[data-pagelet-output]')).toHaveCount(0);
});

test('快速跳过信息流不继续发送旧位置排队内容，迟到结果不覆盖复用节点', async () => {
  const reader = await readPage();
  await reader.route('https://x.com/pagelet_fixture/**', route => route.fulfill({contentType:'text/html',body:feedFixture}));
  await reader.goto('https://x.com/pagelet_fixture/home'); held=true; await toggleReader();
  await expect.poll(()=>requests.length).toBeGreaterThan(0);
  await reader.evaluate(() => { scrollTo(0,420*18); document.querySelector('#post-0 [data-testid="tweetText"]')!.textContent='The website replaced this post.'; });
  await reader.waitForTimeout(250);
  held=false; releases.splice(0).forEach(release => release());
  await expect(reader.locator('#post-18 [data-pagelet-output]')).toHaveCount(1);
  const sent = JSON.stringify(requests.map(r=>r.body));
  expect(sent).not.toContain('Post number 10:');
  await reader.evaluate(()=>scrollTo(0,0));
  await expect(reader.locator('#post-0 [data-pagelet-output]')).toContainText('website replaced');
  await toggleReader(); await expect(reader.locator('#post-0 [data-testid="tweetText"]')).toHaveText('The website replaced this post.');
});


test('后台查找缓存仍在等待时划走，旧批次不发出首次模型请求', async () => {
  const reader = await readPage();
  await reader.route('https://x.com/pagelet_fixture/**', route => route.fulfill({contentType:'text/html',body:feedFixture}));
  await reader.goto('https://x.com/pagelet_fixture/home');
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(() => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    (globalThis as any).__originalDigest = original;
    (crypto.subtle as any).digest = async (...args: Parameters<SubtleCrypto['digest']>) => {
      await new Promise(resolve => setTimeout(resolve, 300)); return original(...args);
    };
  });
  try {
    await toggleReader(); await reader.waitForTimeout(70); expect(requests.length).toBe(0);
    await reader.evaluate(() => scrollTo(0,420*18));
    await expect(reader.locator('#post-18 [data-pagelet-output]')).toHaveCount(1);
    const inputs = requests.flatMap(r => JSON.parse((r.body.messages as any[])[2].content).items);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every(i => !/Post number [0-4]:/.test(i.text))).toBe(true);
  } finally {
    await worker.evaluate(() => { delete (crypto.subtle as any).digest; });
  }
});


const collapsedPost = 'A complete opening sentence explains why this comment needs more room.';
const expandedPost = collapsedPost + '\n\nA second paragraph adds the details that were hidden before expansion.';
async function readExpansion() {
  const reader = await readPage();
  await reader.route('https://x.com/pagelet_expansion/**', route => route.fulfill({ contentType:'text/html', body: '<!doctype html><style>body{font:16px sans-serif}article{width:500px}#body{white-space:pre-wrap}</style><main><article data-testid="tweet"><a id="identity" href="/author/status/6001">Author</a><div id="body" data-testid="tweetText">'+collapsedPost+'</div></article></main>' }));
  await reader.goto('https://x.com/pagelet_expansion/post'); await toggleReader();
  await expect(reader.locator('#body [data-pagelet-output]')).toHaveCount(1);
  return reader;
}
for (const mode of ['bilingual','translated']) for (const change of ['text','append','replace']) {
  test(`展开${change}时${mode}保留旧译文，完成后只显示全文，恢复全文`, async () => {
    const reader = await readExpansion(); if (mode === 'translated') await switchMode(mode);
    const before = requests.length; held = true;
    await reader.evaluate(({full,tail,change}) => {
      const body = document.querySelector('#body')!;
      if (change === 'replace') {
        const next = body.cloneNode(false); next.textContent = full; body.replaceWith(next);
      } else if (change === 'append') {
        const extra = document.createElement('span'); extra.textContent = tail; body.append(extra);
      } else body.textContent = full;
    },{full:expandedPost,tail:expandedPost.slice(collapsedPost.length),change});
    await expect.poll(()=>requests.length).toBe(before+1);
    if (mode === 'bilingual') await expect(reader.locator('#body [data-pagelet-output]')).toHaveText('译：'+collapsedPost);
    else await expect(reader.locator('#body')).toHaveText('译：'+collapsedPost);
    held=false; releases.splice(0).forEach(release=>release());
    if (mode === 'bilingual') {
      await expect(reader.locator('#body [data-pagelet-output]')).toHaveText('译：'+expandedPost);
      expect(await reader.locator('#body [data-pagelet-output]').evaluate(el=>getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
    } else await expect(reader.locator('#body')).toHaveText('译：'+expandedPost);
    await toggleReader(); expect(await reader.locator('#body').textContent()).toBe(expandedPost);
    expect(requests.length).toBe(before+1);
  });
}

test('虚拟列表复用同一正文节点但帖子ID改变，不保留上一帖的旧译文', async () => {
  const reader=await readExpansion(); const before=requests.length; held=true;
  await reader.evaluate(full=>{
    document.querySelector('#identity')!.setAttribute('href','/author/status/6002');
    document.querySelector('#body')!.textContent=full;
  },expandedPost);
  await expect.poll(()=>requests.length).toBe(before+1);
  await expect(reader.locator('#body [data-pagelet-output]')).toHaveCount(0);
  held=false; releases.splice(0).forEach(release=>release());
  await expect(reader.locator('#body [data-pagelet-output]')).toHaveText('译：'+expandedPost);
});

test('展开失败保留已有双语译文，重新开启后失败原因仍可见', async () => {
  const reader=await readExpansion(); const full=collapsedPost+' Additional malformed-response details.';
  await reader.evaluate(text=>{document.querySelector('#body')!.textContent=text},full);
  const state=async()=> (await page.evaluate(()=>chrome.runtime.sendMessage({type:'pagelet-get-state'}))).data;
  await expect.poll(async()=> (await state()).failed).toBe(1);
  expect((await state()).error).toContain('译文格式不完整');
  await expect(reader.locator('#body [data-pagelet-output]')).toHaveText('译：'+collapsedPost);
  await toggleReader(); expect(await reader.locator('#body').textContent()).toBe(full);
  const count=requests.length; await toggleReader();
  await expect.poll(async()=> (await state()).failed).toBe(1);
  expect((await state()).error).toContain('译文格式不完整'); expect(requests.length).toBe(count);
});

test('等待译文的段落有淡色提示，译文回来后消失', async () => {
  held = true;
  const reader = await readPage();
  await toggleReader();
  await expect(reader.locator('#update [data-pagelet-hint="pending"]')).toHaveCount(1);
  await expect(reader.locator('#update [data-pagelet-output]')).toHaveCount(0);
  held = false; for (const release of releases.splice(0)) release();
  await expect(reader.locator('#update [data-pagelet-output]')).toContainText('译：');
  await expect(reader.locator('span[data-pagelet-hint]')).toHaveCount(0);
  await switchMode('translated');
  await toggleReader();
  await expect(reader.locator('span[data-pagelet-hint]')).toHaveCount(0);
});

test('失败段落在网页上原地重试，只重发这一段，不触发网页自己的点击', async () => {
  const reader = await readPage();
  await reader.locator('main').evaluate(main => { main.innerHTML = '<a id="wrap" href="#clicked"><p id="flaky">Test flaky-response handling.</p></a><p id="fine">A normal paragraph.</p>'; });
  await toggleReader();
  const hint = reader.locator('#flaky [data-pagelet-hint="failed"]');
  await expect(hint).toBeVisible();
  await expect(reader.locator('#fine [data-pagelet-output]')).toContainText('译：');
  const before = requests.length;
  await hint.click();
  await expect(reader.locator('#flaky [data-pagelet-output]')).toContainText('译：Test flaky-response handling.');
  await expect(reader.locator('span[data-pagelet-hint]')).toHaveCount(0);
  expect(reader.url()).not.toContain('#clicked');
  const resent = requests.slice(before).flatMap(request => JSON.parse((request.body.messages as { content: string }[])[2]!.content).items.map((item: { text: string }) => item.text));
  expect(resent).toEqual(['Test flaky-response handling.']);
  await expect.poll(async () => (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'pagelet-get-state' }))).data.failed).toBe(0);
});

test('仅看译文时悬停段落显示原文，双语模式和恢复后不显示', async () => {
  const reader = await readPage();
  await toggleReader();
  await switchMode('translated');
  await expect(reader.locator('#update')).toContainText('译：');
  await reader.locator('#update').hover();
  const card = reader.locator('pagelet-peek .card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('A useful tool keeps the page readable.');
  await reader.mouse.move(5, 5);
  await expect(card).toBeHidden();
  await switchMode('bilingual');
  await reader.locator('#update').hover();
  await reader.waitForTimeout(700);
  await expect(card).toBeHidden();
  const sent = JSON.stringify(requests.map(request => request.body));
  expect(sent).not.toContain('原文');
});

test('总是翻译此网站：当前页立即开始，同站新标签页自动翻译，关闭后不再自动', async () => {
  const reader = await readPage();
  const enable = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'save-auto-site', enabled: true }));
  expect(enable.ok, enable.error).toBe(true);
  expect(enable.data.enabled).toBe(true);
  await expect(reader.locator('#update [data-pagelet-output]')).toContainText('译：');
  const site = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get-auto-site' }));
  expect(site.data).toEqual({ site: 'https://127.0.0.1', enabled: true });
  const second = await context.newPage(); readers.push(second);
  await second.goto(`${endpoint}/many`); await second.bringToFront();
  await expect(second.locator('[data-pagelet-output]').first()).toContainText('译：');
  const disable = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'save-auto-site', enabled: false }));
  expect(disable.ok, disable.error).toBe(true);
  const third = await context.newPage(); readers.push(third);
  const before = requests.length;
  await third.goto(`${endpoint}/units`); await third.bringToFront();
  await third.waitForTimeout(800);
  await expect(third.locator('[data-pagelet-output]')).toHaveCount(0);
  expect(requests.length).toBe(before);
});

test('双语译文分层：标题译文小一号，正文译文稍淡，中文字体与行距单独设置', async () => {
  const reader = await readPage();
  await toggleReader();
  await expect(reader.locator('h1 [data-pagelet-output]')).toContainText('译：');
  await expect(reader.locator('#update [data-pagelet-output]')).toContainText('译：');
  const look = await reader.evaluate(() => {
    const h1 = document.querySelector('h1')!, title = h1.querySelector('[data-pagelet-output]')!, body = document.querySelector('#update [data-pagelet-output]')!;
    return { h1: parseFloat(getComputedStyle(h1).fontSize), title: parseFloat(getComputedStyle(title).fontSize), color: getComputedStyle(body).color, font: getComputedStyle(body).fontFamily, lineHeight: parseFloat(getComputedStyle(body).lineHeight) / parseFloat(getComputedStyle(body).fontSize) };
  });
  expect(look.title / look.h1).toBeCloseTo(.78, 2);
  expect(look.color).toMatch(/\/ 0\.74\)$/);
  expect(look.font).toContain('PingFang SC');
  expect(look.lineHeight).toBeCloseTo(1.7, 1);
});

test('悬停段落出现操作条：单段改回原文再切回不发请求，重译只重发这一段且跳过缓存', async () => {
  const reader = await readPage();
  await toggleReader();
  await expect(reader.locator('#update [data-pagelet-output]')).toContainText('译：');
  const bar = reader.locator('pagelet-bar .bar');
  await reader.locator('#update').hover();
  await expect(bar.getByRole('button', { name: '原文' })).toBeVisible();
  const before = requests.length;
  await bar.getByRole('button', { name: '原文' }).click();
  await expect(reader.locator('#update [data-pagelet-output]')).toHaveCount(0);
  await expect(reader.locator('#rich [data-pagelet-output]')).toHaveCount(1);
  await reader.mouse.move(5, 5); await reader.locator('#update').hover();
  await bar.getByRole('button', { name: '译文' }).click();
  await expect(reader.locator('#update [data-pagelet-output]')).toContainText('译：');
  expect(requests).toHaveLength(before);
  await reader.mouse.move(5, 5); await reader.locator('#update').hover();
  await bar.getByRole('button', { name: '重译' }).click();
  await expect.poll(() => requests.length).toBe(before + 1);
  const items = JSON.parse((requests.at(-1)!.body.messages as { content: string }[])[2]!.content).items;
  expect(items.map((item: { text: string }) => item.text)).toEqual(['A useful tool keeps the page readable.']);
  await expect(reader.locator('#update [data-pagelet-output]')).toContainText('译：');
  expect(reader.url()).toBe(`${endpoint}/page`);
});

const sentTexts = () => requests.filter(r => (r.body.messages as unknown[] | undefined)?.length === 3).flatMap(r => JSON.parse((r.body.messages as { content: string }[])[2]!.content).items.map((item: { text: string }) => item.text) as string[]);

test('操作条不盖住段落右侧紧挨的侧栏；模型原样返回的段落标“原文已保留”', async () => {
  const reader = await readPage();
  await reader.locator('main').evaluate(main => {
    main.insertAdjacentHTML('afterbegin', '<div id="cols" style="display:flex;gap:4px"><p id="col" style="flex:1;margin:0">A column paragraph sits right next to a sidebar here.</p><aside id="side" style="width:260px;flex:none">Sidebar text that must stay readable.</aside></div><p id="kept">Lol-kept, ok!</p><p id="mixed">我观察了x简中ai区两个月了,我的claude账号已经3个月了,codex什么时候重置啊!!!kimi太贵了</p>');
  });
  await toggleReader();
  await expect(reader.locator('#col [data-pagelet-output]')).toContainText('译：');
  // Chinese with English product names: decided locally, never sent.
  await expect.poll(() => sentTexts().some(text => text.includes('Lol-kept'))).toBe(true);
  expect(sentTexts().some(text => text.includes('claude'))).toBe(false);
  await expect(reader.locator('#mixed [data-pagelet-output], #kept [data-pagelet-output]')).toHaveCount(0);
  const bar = reader.locator('pagelet-bar .bar');
  await reader.locator('#col').hover();
  await expect(bar.getByRole('button', { name: '原文' })).toBeVisible();
  const [b, side] = [await bar.boundingBox(), await reader.locator('#side').boundingBox()];
  expect(b!.x + b!.width <= side!.x || b!.y + b!.height <= side!.y).toBe(true);
  await reader.mouse.move(5, 5);
  await expect.poll(() => reader.evaluate(() => getComputedStyle(document.querySelector('#kept')!).opacity)).toBe('1');
  await reader.locator('#kept').hover();
  await expect(bar).toContainText('原文已保留');
  await expect(bar.getByRole('button', { name: '原文' })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: '重译' })).toBeVisible();
});

test('页面角落显示翻译进度，完成后消失；失败时显示重试', async () => {
  const reader = await readPage();
  held = true;
  await toggleReader();
  const chip = reader.locator('pagelet-progress .chip');
  await expect(chip).toHaveClass(/shown/);
  await expect(chip).toContainText('翻译中 0 /');
  held = false; for (const release of releases.splice(0)) release();
  await expect(chip).toContainText('已翻译');
  await expect(chip).not.toHaveClass(/shown/, { timeout: 4000 });
  await reader.locator('main').evaluate(main => { main.insertAdjacentHTML('afterbegin', '<p id="broken">Test malformed-response handling here.</p>'); });
  await expect(chip).toContainText('1 段翻译失败');
  await expect(chip.getByRole('button', { name: '重试' })).toBeVisible();
});

test('X 长文：翻译标题和正文段落，跳过代码块和操作按钮', async () => {
  const block = (tag: string, cls: string, text: string) => `<${tag} class="${cls}" data-block="true" data-offset-key="${cls}-0"><div data-offset-key="${cls}-0-0"><span data-offset-key="${cls}-0-0"><span data-text="true">${text}</span></span></div></${tag}>`;
  const page = '<!doctype html><title>X article fixture</title><style>body{font:16px/1.6 sans-serif}main{width:600px;margin:auto}</style><main><article data-testid="tweet" role="article"><article data-testid="twitterArticleReadView" role="article">'
    + '<div data-testid="twitter-article-title"><span>Your coding agents made you a manager</span></div>'
    + '<div role="group"><button data-testid="reply">Reply 12</button><button data-testid="bookmark">Save</button></div>'
    + '<div data-testid="twitterArticleRichTextView"><div class="DraftEditor-root"><div class="DraftEditor-editorContainer"><div class="public-DraftEditor-content" contenteditable="false" data-testid="longformRichTextComponent">'
    + block('h2', 'longform-header-two', 'Give it a way to check its work')
    + block('div', 'longform-unstyled', 'Provide the agent with a mechanism to validate its work, like a test suite.')
    + block('li', 'longform-unordered-list-item', 'Ask how a manager stays confident without reading everything.')
    + '<section data-block="true"><pre><code>pnpm test --watch</code></pre><button>Copy</button></section>'
    + '</div></div></div></div></article></article></main>';
  const reader = await readPage();
  await reader.route('https://x.com/pagelet_article/**', route => route.fulfill({ contentType: 'text/html', body: page }));
  await reader.goto('https://x.com/pagelet_article/status/7001'); await toggleReader();
  for (const text of ['made you a manager', 'check its work', 'validate its work', 'stays confident'])
    await expect(reader.locator('[data-pagelet-output]', { hasText: text })).toHaveCount(1);
  const sent = sentTexts().join('\n');
  for (const excluded of ['pnpm test', 'Copy', 'Reply', 'Save']) expect(sent).not.toContain(excluded);
  await toggleReader();
  await expect(reader.locator('[data-pagelet-output]')).toHaveCount(0);
});
