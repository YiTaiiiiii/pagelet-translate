import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const root = resolve('.output/chrome-mv3');
const port = Number(process.env.PAGELET_TEST_PORT || 5197);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url || '/', 'http://localhost').pathname;
    const path = resolve(root, `.${requestPath === '/' ? '/popup.html' : decodeURIComponent(requestPath)}`);
    if (!path.startsWith(`${root}/`)) { response.writeHead(403).end(); return; }
    const contents = await readFile(path);
    response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }).end(contents);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`测试静态服务：http://127.0.0.1:${port}/`));
