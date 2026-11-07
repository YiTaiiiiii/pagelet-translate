import { test, expect } from '@playwright/test';
import { completedEntries, dropForeignTags, messagesFor, translate } from '../core/translate';
import { cacheKey, hasAllInlineTags, inlineShape, parseInline, reconcileInline, serviceIdentity, type BatchInput } from '../shared/engine';
import { DEFAULT_SETTINGS, normalizeEndpoint, THINKING_LEVELS, type Settings } from '../shared/settings';
import { requestUsage, type RequestUsage } from '../shared/usage';
import { RequestQueue } from '../core/queue';
import { ApiError, complete, requestFor, testConnection, LIMITS } from '../core/connection';
const input: BatchInput = {context:'Page context',priority:0,items:[
  {id:'s0',text:'Click <i0>Settings</i0> to disable <i1>sync</i1>; keep <k0>src/index.ts</k0>.',supplement:''},
  {id:'s1',text:'A second paragraph.',supplement:''},
]};
const correct = '要禁用<i1>同步</i1>，请点击<i0>设置</i0>；保留<k0>src/index.ts</k0>。';
function response(content: string, done = true) {
  return new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:60}})+'\n\n'+(done?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}});
}
test('编号结构允许调序，拒绝受保护文字变化、缺失和重新嵌套',()=> {
  expect(inlineShape(input.items[0]!.text)).toBe(inlineShape(correct));
  for (const bad of [correct.replace('src/index.ts','index.js'),correct.replace('<k0>src/index.ts</k0>',''),correct+'<i9>unknown</i9>']) expect(inlineShape(bad)).not.toBe(inlineShape(correct));
  expect(()=>inlineShape(correct+'<i0>duplicate</i0>')).toThrow();
});
test('宽容修复行内与保留标签：自动恢复原位数字/路径、外层包裹、嵌套对调与缺失闭合', async () => {
  const source = '<i0><i1>A formal no-crash proof.</i1> Runs for <i2>any</i2> input under <k0>64 MB</k0>.<k1>3</k1></i0>';
  const reordered = '<i0><i1>形式化无崩溃证明。</i1>适用于 <i2>小于 <k0>64MB</k0> 的任何</i2>输入。</i0>';
  const fixed = reconcileInline(source, reordered);
  expect(() => parseInline(fixed)).not.toThrow();
  expect(hasAllInlineTags(source, fixed)).toBe(true);
  expect(fixed).toContain('<k0>64 MB</k0>');
  expect(fixed.endsWith('<k1>3</k1></i0>')).toBe(true);
  const droppedTag = '形式化无崩溃证明。适用于小于 64 MB 的任何输入。';
  const fallback = reconcileInline(source, droppedTag);
  expect(() => parseInline(fallback)).not.toThrow();
  expect(fallback.startsWith('<i0>')).toBe(true);
  expect(fallback).toContain('<k0>64 MB</k0>');
  expect(fallback).toContain('<k1>3</k1>');
});
test('SSE 只提取完整 JSON 条目，字符串中的引号和花括号不截断条目',()=> {
  const a = JSON.stringify({id:'s0',text:'quoted " } ] \\ text'});
  expect(completedEntries('{"translations":['+a+',{"id":"s1","text":"incomplete')).toEqual([JSON.parse(a)]);
  expect(completedEntries('{"translations":[{"id":"s0","text":')).toEqual([]);
});
test('请求前缀跨批次一致；一次修复只包括异常条目',async()=> {
  const original = fetch, calls: any[] = [], emitted: string[] = [];
  globalThis.fetch = async (_,init)=> {
    const body=JSON.parse(String(init!.body));calls.push(body);
    const translations = calls.length===1 ? [{id:'s0',text:correct},{id:'s1',text:''}] : [{id:'s1',text:'第二段。'}];
    return response(JSON.stringify({translations}));
  };
  try {
    const results=await translate(DEFAULT_SETTINGS,input,new AbortController().signal,undefined,r=>emitted.push(r.id));
    expect(results).toHaveLength(2);expect(emitted).toEqual(['s0','s1']);expect(calls).toHaveLength(2);
    expect(calls[1].messages.slice(0,2)).toEqual(calls[0].messages.slice(0,2));
    expect(JSON.parse(calls[1].messages[2].content).items.map((i:any)=>i.id)).toEqual(['s1']);
    expect(calls[0]).toMatchObject({stream:true,temperature:1,max_tokens:2048,thinking:{type:'disabled'},stream_options:{include_usage:true}});
    const next=messagesFor(DEFAULT_SETTINGS,{...input,items:[input.items[1]!]});
    expect(next.slice(0,2)).toEqual(calls[0].messages.slice(0,2));
  } finally {globalThis.fetch=original;}
});
test('关闭思考时发送 thinking disabled；只因长度截断的空正文只算本批失败，不暂停全部',async()=> {
  const original=fetch;const calls:any[]=[];
  try {
    globalThis.fetch=async(_,init)=>{calls.push(JSON.parse(String(init!.body)));return new Response('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'length'}],usage:{prompt_tokens:100,completion_tokens:2048}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
    const error=await complete({...DEFAULT_SETTINGS,endpoint:'https://gateway.example.com/v1'},[{role:'user',content:'x'}]).catch(e=>e);
    expect(calls[0].thinking).toEqual({type:'disabled'});
    expect(error).toBeInstanceOf(ApiError);expect(error.policy).toBe('manual');expect(error.message).toContain('长度');
  } finally {globalThis.fetch=original;}
});
test('结构修复至多一次；关闭期间不修复；断流即使有完整段落也不自动重发',async()=> {
  const original=fetch;
  try {
    for (const repair of [true,false]) {
      let calls=0;globalThis.fetch=async()=>{calls++;return response('{"translations":[]}');};
      const results=await translate(DEFAULT_SETTINGS,input,new AbortController().signal,undefined,undefined,()=>repair);
      expect(calls).toBe(repair?2:1);expect(results.every(r=>r.error)).toBe(true);
    }
    let calls=0;const emitted: string[]=[];
    globalThis.fetch=async()=>{calls++;return response(JSON.stringify({translations:[{id:'s0',text:correct}]}),false);};
    await expect(translate(DEFAULT_SETTINGS,input,new AbortController().signal,undefined,r=>emitted.push(r.id))).rejects.toThrow('中断');
    expect(calls).toBe(1);expect(emitted).toEqual(['s0']);
  } finally {globalThis.fetch=original;}
});
test('唯一队列最多 10 个运行请求，前台优先；关闭只移除未发送任务',async()=> {
  const queue=new RequestQueue(), releases: (()=>void)[]=[], started:string[]=[];
  const run=(name:string)=>queue.add(name,async signal=>{
    started.push(name);await new Promise<void>(resolve=>releases.push(resolve));expect(signal.aborted).toBe(false);return name;
  }).catch(e=>e.message);
  const jobs=Array.from({length:10},(_,i)=>run('busy'+i));
  await Promise.resolve();expect(started).toHaveLength(10);
  jobs.push(run('background'),run('foreground'),run('removed'));queue.focus('foreground');queue.cancel('removed',false);
  releases.shift()!();await expect.poll(()=>started.length).toBe(11);expect(started[10]).toBe('foreground');
  queue.pause();releases.splice(0).forEach(r=>r());await expect.poll(()=>releases.length).toBe(0);expect(started).toHaveLength(11);
  queue.resume();await expect.poll(()=>started.length).toBe(12);releases.splice(0).forEach(r=>r());
  expect(await Promise.all(jobs)).toContain('尚未发送。');
});

test('预加载最多两个请求，当前屏插队，滚走的排队任务不发送', async () => {
  const queue = new RequestQueue(), started: string[] = [], releases: (() => void)[] = [];
  queue.focus('tab');
  queue.plan('tab', ['a','b','c','visible'].map(id => ({id,priority:id==='visible'?0:1})));
  const run = (id: string, priority: number) => queue.add('tab', async () => {
    started.push(id); await new Promise<void>(resolve => releases.push(resolve));
  }, priority, id).catch(error => error.message);
  const jobs = ['a','b','c'].map(id => run(id,1));
  await Promise.resolve(); expect(started).toEqual(['a','b']);
  jobs.push(run('visible',0)); await Promise.resolve(); expect(started).toEqual(['a','b','visible']);
  queue.plan('tab', [{id:'visible',priority:0}]);
  expect(await jobs[2]).toBe('尚未发送。');
  releases.splice(0).forEach(release => release()); await Promise.all(jobs);
  expect(started).not.toContain('c');
  expect(await run('c',1)).toBe('尚未发送。');
});

test('预加载任务进入当前屏后提升优先级，不重新发送已经运行的请求', async () => {
  const queue = new RequestQueue(), started: string[] = [], releases: (() => void)[] = [];
  queue.plan('tab', ['a','b','c'].map(id => ({id,priority:1})));
  const jobs = ['a','b','c'].map(id => queue.add('tab', async () => {
    started.push(id); await new Promise<void>(resolve => releases.push(resolve));
  },1,id));
  await Promise.resolve(); expect(started).toEqual(['a','b']);
  queue.plan('tab', [{id:'a',priority:1},{id:'b',priority:1},{id:'c',priority:0}]);
  await Promise.resolve(); expect(started).toEqual(['a','b','c']);
  releases.splice(0).forEach(release => release()); await Promise.all(jobs);
});

test('同一批次内相同的补充语境只发送一次，各段按编号引用', () => {
  const batch = { context: '', priority: 0, items: [
    { id: 's0', text: 'First paragraph.', supplement: 'Parent comment.', unit: 'u0' },
    { id: 's1', text: 'Second paragraph.', supplement: 'Parent comment.', unit: 'u0' },
    { id: 's2', text: 'Other post.', supplement: '', unit: 'u1' },
  ] };
  const sent = JSON.parse(messagesFor(DEFAULT_SETTINGS, batch)[2]!.content);
  expect(sent.notes).toEqual({ n0: 'Parent comment.' });
  expect(sent.items.map((item: { note?: string }) => item.note)).toEqual(['n0', 'n0', undefined]);
  expect(JSON.stringify(sent).match(/Parent comment/g)).toHaveLength(1);
});
test('模型编造的 HTML 标签不进入译文，原文里本来有的同名文字保留', () => {
  expect(dropForeignTags('It took two <i0>person-years</i0>.', '花了两<a>人年</a>，<i0>人年</i0>。')).toBe('花了两人年，<i0>人年</i0>。');
  expect(dropForeignTags('Use the &lt;a&gt; element.', '使用 <a> 元素。')).toBe('使用 <a> 元素。');
  expect(dropForeignTags('Plain.', '<b class="x">粗体</b><br/>')).toBe('粗体');
});

const CLAUDE: Settings = {...DEFAULT_SETTINGS,format:'anthropic',endpoint:'https://api.example.com',model:'claude-example',thinking:'default',apiKey:'fixture-key-not-a-real-secret'};
function sse(events: [string, unknown][]) {
  return new Response(events.map(([name,data])=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
function claudeStream(text: string, stop = 'end_turn') {
  const pieces: [string, unknown][] = [];
  for (let i=0;i<text.length;i+=11) pieces.push(['content_block_delta',{type:'content_block_delta',index:1,delta:{type:'text_delta',text:text.slice(i,i+11)}}]);
  return sse([
    ['message_start',{type:'message_start',message:{usage:{input_tokens:30,cache_read_input_tokens:60,cache_creation_input_tokens:10,output_tokens:1}}}],
    ['ping',{type:'ping'}],
    ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'{"translations":[{"id":"s9","text":"not content"}]}'}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'sig'}}],
    ['content_block_stop',{type:'content_block_stop',index:0}],
    ['content_block_start',{type:'content_block_start',index:1,content_block:{type:'text',text:''}}],
    ...pieces,
    ['content_block_stop',{type:'content_block_stop',index:1}],
    ['message_delta',{type:'message_delta',delta:{stop_reason:stop},usage:{output_tokens:20}}],
    ['message_stop',{type:'message_stop'}],
  ]);
}
async function withFetch<T>(handler: (url: string, init: RequestInit) => Response, run: () => Promise<T>) {
  const original=fetch;globalThis.fetch=async(url,init)=>handler(String(url),init!);
  try { return await run(); } finally { globalThis.fetch=original; }
}
test('思考强度按格式映射，默认不发送字段；输出上限和超时随强度放宽',()=> {
  const messages=[{role:'system' as const,content:'A'},{role:'system' as const,content:'B'},{role:'user' as const,content:'x'},{role:'user' as const,content:'y'}];
  const openai=Object.fromEntries(THINKING_LEVELS.map(level=>[level,requestFor({...DEFAULT_SETTINGS,thinking:level},messages).body]));
  expect(openai.default).not.toHaveProperty('thinking');expect(openai.default).not.toHaveProperty('reasoning_effort');
  expect(openai.off).toMatchObject({thinking:{type:'disabled'},max_tokens:2048,temperature:1,response_format:{type:'json_object'}});expect(openai.off).not.toHaveProperty('reasoning_effort');
  for (const level of ['low','medium','high'] as const) { expect(openai[level]!.reasoning_effort).toBe(level);expect(openai[level]).not.toHaveProperty('thinking'); }
  const claude=Object.fromEntries(THINKING_LEVELS.map(level=>[level,requestFor({...CLAUDE,thinking:level},messages).body]));
  expect(claude.default).not.toHaveProperty('thinking');expect(claude.default).not.toHaveProperty('output_config');
  expect(claude.off!.thinking).toEqual({type:'disabled'});expect(claude.off).not.toHaveProperty('output_config');
  for (const level of ['low','medium','high'] as const) expect(claude[level]).toMatchObject({thinking:{type:'adaptive'},output_config:{effort:level}});
  for (const body of Object.values(claude)) {
    expect(Object.keys(body).filter(key=>['temperature','top_p','top_k','response_format','stream_options'].includes(key))).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
    expect(body).toMatchObject({model:'claude-example',system:'A\n\nB',messages:[{role:'user',content:'x'},{role:'user',content:'y'}],stream:true});
  }
  expect(THINKING_LEVELS.map(level=>[openai[level]!.max_tokens,claude[level]!.max_tokens])).toEqual([[8192,8192],[2048,2048],[8192,8192],[16384,16384],[32000,32000]]);
  expect(LIMITS.off).toEqual({maxTokens:2048,firstMs:15_000,totalMs:45_000});
  // Presets switch thinking off their own way, only when the address matches the preset.
  const off=(provider:string,endpoint:string)=>requestFor({...DEFAULT_SETTINGS,provider,endpoint,thinking:'off'},messages).body;
  expect(off('openai','https://api.openai.com/v1')).toMatchObject({reasoning_effort:'none',max_completion_tokens:2048});
  expect(off('openai','https://api.openai.com/v1')).not.toHaveProperty('max_tokens');expect(off('openai','https://api.openai.com/v1')).not.toHaveProperty('thinking');
  expect(off('dashscope','https://dashscope.aliyuncs.com/compatible-mode/v1')).toMatchObject({enable_thinking:false,max_tokens:2048});
  expect(off('openrouter','https://openrouter.ai/api/v1')).toMatchObject({reasoning:{effort:'none'}});
  for (const [provider,endpoint] of [['gemini','https://generativelanguage.googleapis.com/v1beta/openai'],['kimi','https://api.moonshot.cn/v1']]) { const body=off(provider!,endpoint!); expect(body).not.toHaveProperty('thinking');expect(body).not.toHaveProperty('reasoning_effort'); }
  expect(off('deepseek','https://gateway.example.com/v1')).toMatchObject({thinking:{type:'disabled'},max_tokens:2048});
  expect(off('openai','https://gateway.example.com/v1')).toMatchObject({thinking:{type:'disabled'},max_tokens:2048});
  expect(THINKING_LEVELS.map(level=>LIMITS[level].totalMs)).toEqual([90_000,45_000,90_000,150_000,240_000]);
  expect(requestFor(CLAUDE,messages).headers).toEqual({'content-type':'application/json','x-api-key':CLAUDE.apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'});
  expect(['https://api.example.com','https://api.example.com/v1','https://api.example.com/anthropic'].map(endpoint=>requestFor({...CLAUDE,endpoint},messages).url))
    .toEqual(['https://api.example.com/v1/messages','https://api.example.com/v1/messages','https://api.example.com/anthropic/v1/messages']);
  expect(requestFor({...DEFAULT_SETTINGS,endpoint:'https://gateway.example.com/v1'},messages).url).toBe('https://gateway.example.com/v1/chat/completions');
});
test('粘贴完整请求路径时按格式给出提示',()=> {
  expect(normalizeEndpoint('https://api.example.com/anthropic/','anthropic')).toBe('https://api.example.com/anthropic');
  expect(()=>normalizeEndpoint('https://api.example.com/v1/messages','anthropic')).toThrow('不需要添加 /v1/messages');
  expect(()=>normalizeEndpoint('https://api.example.com/v1/messages','openai')).toThrow('Anthropic 格式的完整地址');
  expect(()=>normalizeEndpoint('https://api.example.com/v1/chat/completions','anthropic')).toThrow('OpenAI 格式的完整地址');
  expect(()=>normalizeEndpoint('https://api.example.com/v1/chat/completions')).toThrow('不需要添加 /chat/completions');
});
test('Anthropic 事件流：只收正文，思考与 ping 不进译文；代码围栏可解析；用量含缓存读写',async()=> {
  const records: RequestUsage[]=[], calls: {url:string;body:any}[]=[];
  const fenced='```json\n'+JSON.stringify({translations:[{id:'s0',text:correct},{id:'s1',text:'第二段。'}]})+'\n```';
  const results=await withFetch((url,init)=>{calls.push({url,body:JSON.parse(String(init.body))});return claudeStream(fenced);},
    ()=>translate(CLAUDE,input,new AbortController().signal,r=>{records.push(r);}));
  expect(calls).toHaveLength(1);expect(calls[0]!.url).toBe('https://api.example.com/v1/messages');
  expect(results).toEqual([{id:'s0',text:correct},{id:'s1',text:'第二段。'}]);
  expect(records[0]).toMatchObject({status:'ok',httpStatus:200,inputTokens:100,outputTokens:20,totalTokens:120,cacheReadTokens:60,cacheMissTokens:40});
  expect(records[0]!.firstContentMs).not.toBeNull();
  await withFetch(()=>claudeStream('Here is the JSON:\n```json\n{"translation":"你好"}\n```'),()=>expect(testConnection(CLAUDE)).resolves.toHaveProperty('testedAt'));
  expect(completedEntries('Sure.\n```json\n{"translations":[{"id":"s0","text":"甲"}]}\n```')).toEqual([{id:'s0',text:'甲'}]);
});
test('Anthropic 停止原因：截断只算本批失败，拒绝不暂停，过载与 529 暂停',async()=> {
  const run=(response: () => Response)=>withFetch(response,()=>complete(CLAUDE,[{role:'user',content:'x'}]).catch(e=>e));
  const length=await run(()=>claudeStream('','max_tokens'));
  expect(length).toBeInstanceOf(ApiError);expect(length.policy).toBe('manual');expect(length.message).toContain('长度');
  expect(await run(()=>claudeStream('{"transl','refusal'))).toMatchObject({message:'模型拒绝处理这段内容。',policy:'manual'});
  const overloaded=await run(()=>sse([['message_start',{type:'message_start',message:{usage:{input_tokens:5}}}],['error',{type:'error',error:{type:'overloaded_error',message:'Overloaded'}}]]));
  expect(overloaded).toMatchObject({policy:'pause'});expect(overloaded.message).toContain('繁忙');
  const failed=await run(()=>sse([['error',{type:'error',error:{type:'api_error',message:'Internal server error'}}]]));
  expect(failed).toMatchObject({policy:'manual'});expect(failed.message).toContain('Internal server error');
  expect(await run(()=>new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',{status:529}))).toMatchObject({policy:'pause'});
  const cut=await run(()=>sse([['message_start',{type:'message_start',message:{usage:{input_tokens:5}}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'{"translations":['}}]]));
  expect(cut.message).toContain('中断');
});
test('400/404/422 附上服务错误原文摘要，不含 Key 和请求内容；401 仍是 Key 提示',async()=> {
  const key=CLAUDE.apiKey;
  for (const [settings,status,body] of [
    [CLAUDE,400,{type:'error',error:{type:'invalid_request_error',message:`thinking.type.disabled is not supported for this model. key ${key}`}}],
    [{...DEFAULT_SETTINGS,apiKey:key},404,{error:{message:'The model `missing-model` does not exist',type:'invalid_request_error'}}],
    [{...DEFAULT_SETTINGS,apiKey:key},422,{error:{message:'x'.repeat(400)}}],
  ] as [Settings,number,unknown][]) {
    const error=await withFetch(()=>new Response(JSON.stringify(body),{status}),()=>complete(settings,[{role:'user',content:'request-only-text'}]).catch(e=>e));
    expect(error).toBeInstanceOf(ApiError);expect(error.policy).toBe('stop');
    expect(error.message).toContain(`（${status}）`);expect(error.message).toContain('服务返回：');
    expect(error.message).not.toContain(key);expect(error.message).not.toContain('request-only-text');
    expect(error.message.split('服务返回：')[1]!.length).toBeLessThanOrEqual(160);
  }
  const unsupported=await withFetch(()=>new Response(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'thinking.type.disabled is not supported for this model'}}),{status:400}),()=>complete(CLAUDE,[]).catch(e=>e));
  expect(unsupported.message).toContain('thinking.type.disabled is not supported');
  const unauthorized=await withFetch(()=>new Response(JSON.stringify({error:{message:'invalid x-api-key'}}),{status:401}),()=>complete(CLAUDE,[]).catch(e=>e));
  expect(unauthorized.message).toBe('Key 未通过验证，请检查配置。');
});
test('OpenAI 思考片段只算活动，不进入译文',async()=> {
  const chunks=[{choices:[{delta:{reasoning_content:'{"translation":"wrong"}'}}]},{choices:[{delta:{reasoning:'more'}}]},{choices:[{delta:{content:'{"translation":"你好"}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}];
  const calls: any[]=[];
  const result=await withFetch((_,init)=>{calls.push(JSON.parse(String(init.body)));return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});},
    ()=>complete({...DEFAULT_SETTINGS,thinking:'high'},[{role:'user',content:'x'}]));
  expect(result).toEqual({content:'{"translation":"你好"}',finishReason:'stop'});
  expect(calls[0]).toMatchObject({reasoning_effort:'high',max_tokens:32000});
});
test('Anthropic 用量换算；OpenAI 字段不受影响',()=> {
  expect(requestUsage({usage:{input_tokens:30,cache_read_input_tokens:60,cache_creation_input_tokens:10,output_tokens:20}},0,1000,'ok',200)).toMatchObject({inputTokens:100,outputTokens:20,totalTokens:120,cacheReadTokens:60,cacheMissTokens:40,averageTps:20});
  expect(requestUsage({usage:{input_tokens:30}},0,1000,'error',200)).toMatchObject({inputTokens:30,outputTokens:null,cacheReadTokens:null});
  expect(requestUsage({usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:60}},0,1000,'ok',200)).toMatchObject({inputTokens:100,outputTokens:20,cacheReadTokens:60,cacheMissTokens:40});
});
test('缓存身份包括格式、地址、模型和思考强度',()=> {
  const pair={sourceLanguage:'auto',targetLanguage:'zh-CN'} as const, key=(settings: Settings)=>cacheKey('Text','Context','',pair,serviceIdentity(settings));
  const variants=[DEFAULT_SETTINGS,{...DEFAULT_SETTINGS,format:'anthropic'},{...DEFAULT_SETTINGS,endpoint:'https://gateway.example.com/v1'},{...DEFAULT_SETTINGS,model:'other-model'},{...DEFAULT_SETTINGS,thinking:'high'}] as Settings[];
  expect(new Set(variants.map(key)).size).toBe(variants.length);
  expect(key({...DEFAULT_SETTINGS,apiKey:'changed',mode:'translated'})).toBe(key(DEFAULT_SETTINGS));
});
