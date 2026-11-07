import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

// Compile the real extraction modules for an isolated browser DOM. All routes
// below are local fixtures; no extension settings, keys or model calls are used.
async function fixture(page: Page, html: string, host = 'x.com') {
  await page.route(`https://${host}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/__pagelet_tests/')) {
      const module = path.slice('/__pagelet_tests/'.length);
      if (!['content/extract','shared/engine','shared/languages'].includes(module)) throw new Error('Unexpected fixture import: ' + module);
      const input = await readFile(resolve(module + '.ts'), 'utf8');
      const body = stripTypeScriptTypes(input);
      await route.fulfill({ contentType: 'text/javascript', body });
    } else await route.fulfill({ contentType: 'text/html', body: `<style>body{font:16px sans-serif}article{display:block} [data-testid=tweetText]{display:block}</style>${html}` });
  });
  await page.goto(`https://${host}/home`);
  await page.evaluate(async path => { (window as any).extraction = await import(path); }, '/__pagelet_tests/content/extract');
}
async function extracted(page: Page) {
  return page.evaluate(() => {
    const mod = (window as any).extraction;
    return mod.extract(mod.pageRoots('main'), 'main', new Set()).map((item: any) => ({ text: item.source.plain, kind: item.kind, key: item.unitKey, related: item.related, unit: item.unit.id }));
  });
}

test('X 正文排除账号、时间与按钮，可点击卡片仍可提取', async ({ page }) => {
  await fixture(page, '<main><article data-testid="tweet" role="button"><div>Account Name @reader</div><a href="/reader/status/123"><time>12 minutes ago</time></a><div id="prose" data-testid="tweetText">The forecast improved <a href="https://example.org">today</a>.</div><button>Reply</button><div role="button">Share</div></article><aside>Unrelated suggestions</aside></main>');
  expect(await extracted(page)).toEqual([{ text: 'The forecast improved today.', kind: 'feed', key: 'x:123', related: '', unit: 'prose' }]);
});

test('X 引用是独立正文，只把明确引用给外帖，不串相邻帖', async ({ page }) => {
  await fixture(page, '<main><article data-testid="tweet"><a href="/writer/status/101"><time>Today</time></a><div id="outer" data-testid="tweetText">This result changes the argument.</div><div role="link" href="/other/status/202"><div>Quoted Account</div><div id="quote" data-testid="tweetText">The earlier result was uncertain.<span hidden>hidden-secret</span><span contenteditable="true">editor-secret</span></div></div></article><article data-testid="tweet"><a href="/other/status/303">Yesterday</a><div id="next" data-testid="tweetText">Unrelated sibling claim.</div></article></main>');
  expect(await extracted(page)).toEqual([
    { text: 'This result changes the argument.', kind: 'feed', key: 'x:101', related: 'The earlier result was uncertain.', unit: 'outer' },
    { text: 'The earlier result was uncertain.', kind: 'feed', key: 'x:202', related: '', unit: 'quote' },
    { text: 'Unrelated sibling claim.', kind: 'feed', key: 'x:303', related: '', unit: 'next' },
  ]);
});

test('X 同文重绘标识稳定，虚拟卡片复用可重新识别帖子', async ({ page }) => {
  await fixture(page, '<main><article data-testid="tweet"><a href="/user/status/301">Today</a><div id="prose" data-testid="tweetText">A stable source sentence.</div></article></main>');
  const first = await extracted(page);
  await page.locator('article').evaluate(card => { card.innerHTML = '<a href="/user/status/301">Yesterday</a><div id="prose" data-testid="tweetText">A stable source sentence.</div>'; });
  expect(await extracted(page)).toEqual(first);
  await page.locator('article').evaluate(card => { card.innerHTML = '<a href="/user/status/302">Today</a><div id="prose" data-testid="tweetText">A different post sentence.</div>'; });
  expect((await extracted(page))[0]).toMatchObject({ key: 'x:302', text: 'A different post sentence.' });
});

test('X 无帖子链接时同文重建仍有稳定标识，更新正文改变标识', async ({ page }) => {
  await fixture(page, '<main><article><div id="prose" data-testid="tweetText">A source without an identity link.</div></article></main>');
  const first = (await extracted(page))[0]!.key;
  await page.locator('article').evaluate(card => { card.innerHTML = '<div id="prose" data-testid="tweetText">A source without an identity link.</div>'; });
  expect((await extracted(page))[0]!.key).toBe(first);
  await page.locator('#prose').evaluate(body => { body.textContent = 'An updated source without an identity link.'; });
  expect((await extracted(page))[0]!.key).not.toBe(first);
});

test('Reddit 只取父评论安全正文，引用译文不进入语境', async ({ page }) => {
  await fixture(page, '<main><shreddit-comment thingid="t1_parent"><div slot="comment" id="parent"><p>The cache is stale.<span hidden>hidden-secret</span><span style="display:none">css-secret</span><span contenteditable="true">editor-secret</span><span data-pagelet-output>译文-secret</span></p></div><shreddit-comment thingid="t1_child"><div id="child" slot="comment">That does not fix it.</div></shreddit-comment></shreddit-comment><shreddit-comment><div slot="comment">Unrelated sibling.</div></shreddit-comment></main>', 'www.reddit.com');
  const child = (await extracted(page)).find((item: any) => item.unit === 'child');
  expect(child).toMatchObject({ key: 'reddit:t1_child', related: 'The cache is stale.' });
  await page.locator('#parent').evaluate(body => { body.innerHTML = '父评论译文<!--pagelet-->'; });
  const related = await page.locator('#child').evaluate(body => (window as any).extraction.readingContext(body).related);
  expect(related).toBe('The cache is stale.');
});

test('引用正文变化更新语境，隐藏变更不改变语境', async ({ page }) => {
  await fixture(page, '<main><article><a href="/a/status/10">Today</a><div id="outer" data-testid="tweetText">Read this quotation.</div><div role="link" href="/b/status/20"><div id="quote" data-testid="tweetText">First quote.<span hidden>private</span></div></div></article></main>');
  const context = () => page.locator('#outer').evaluate(body => (window as any).extraction.readingContext(body).related);
  expect(await context()).toBe('First quote.');
  await page.locator('#quote span').evaluate(hidden => { hidden.textContent = 'changed-private'; });
  expect(await context()).toBe('First quote.');
  await page.locator('#quote').evaluate(body => { body.firstChild!.textContent = 'Updated quote.'; });
  expect(await context()).toBe('Updated quote.');
});

test('引用正文或外层隐藏时不提取正文，也不发送相关语境', async ({ page }) => {
  await fixture(page, '<main><article><a href="/a/status/10">Today</a><div id="outer" data-testid="tweetText">Read this quotation.</div><div id="wrapper" role="link" href="/b/status/20"><div id="quote" data-testid="tweetText">Sensitive hidden quotation.</div></div></article></main>');
  const variants = [
    ['quote','hidden',''], ['quote','aria-hidden','true'],
    ['wrapper','hidden',''], ['wrapper','aria-hidden','true'],
    ['wrapper','style','display:none'], ['wrapper','style','visibility:hidden'],
  ];
  for (const [id,attribute,value] of variants) {
    await page.evaluate(({ id, attribute, value }) => {
      for (const body of document.querySelectorAll('#quote,#wrapper')) for (const attr of ['hidden','aria-hidden','style']) body.removeAttribute(attr);
      document.getElementById(id!)!.setAttribute(attribute!, value!);
    }, { id, attribute, value });
    expect(await extracted(page)).toEqual([{ text: 'Read this quotation.', kind: 'feed', key: 'x:10', related: '', unit: 'outer' }]);
    expect(await page.locator('#outer').evaluate(body => (window as any).extraction.readingContext(body).related)).toBe('');
  }
});

test('受保护行内元素保留可见文本，隐藏自身与后代不进入正文或语境', async ({ page }) => {
  await fixture(page, '<main><article><a href="/a/status/10">Today</a><div id="outer" data-testid="tweetText">Read this quotation.</div><div role="link" href="/b/status/20"><div id="quote" data-testid="tweetText">Use <code>npm<span hidden>hidden-code-child</span><span style="display:none">css-code-child</span> install</code><kbd>Ctrl<span aria-hidden="true">aria-kbd-child</span></kbd><samp>ready<span contenteditable="true">editor-samp-child</span></samp><code hidden>hidden-code</code><kbd aria-hidden="true">hidden-kbd</kbd><samp style="display:none">hidden-samp</samp><br hidden><br style="visibility:hidden"> safely.</div></div></article></main>');
  const items = await extracted(page);
  expect(items[0]!.related).toBe('Use npm installCtrlready safely.');
  expect(items.filter((item: any) => item.unit === 'quote').map((item: any) => item.text).join(' ')).toBe('Use npm installCtrlready safely.');
  const encoded = await page.evaluate(() => {
    const mod = (window as any).extraction;
    return mod.extract(mod.pageRoots('main'), 'main', new Set()).map((item: any) => item.source.text).join('\n');
  });
  expect(encoded).toContain('npm install');
  expect(encoded).not.toMatch(/hidden-|css-code-child|aria-kbd-child|editor-samp-child/);
  expect(await page.locator('#quote').innerHTML()).toContain('hidden-code-child');
});

test('普通文档继续保持文档阅读单元', async ({ page }) => {
  await fixture(page, '<main><article id="doc"><p>First document paragraph.</p><p>Second document paragraph.</p></article></main>', 'fixture.example');
  expect(await extracted(page)).toEqual([
    { text: 'First document paragraph.', kind: 'document', key: undefined, related: undefined, unit: 'doc' },
    { text: 'Second document paragraph.', kind: 'document', key: undefined, related: undefined, unit: 'doc' },
  ]);
});
