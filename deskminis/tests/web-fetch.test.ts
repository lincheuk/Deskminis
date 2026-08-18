/** web_fetch 工具：HTML→纯文本、编码嗅探、体积/超时防线、web-fetch 权限类目。
 *  fetch 一律构造注入（fakeFetch 按 URL 精确路由，skills-import.test.ts 同款模式）。 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWebFetchTool, htmlToText, sniffCharset } from '../src/minisd/tools/web';
import type { PermissionDecision, PermissionGateway, PermissionRequest } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s);
function cat(...parts: Uint8Array[]): Uint8Array {
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** GBK 编码表（仅测试用到的字）：Node 侧只有 TextDecoder 没有 GBK 编码器，手工列码位。 */
const GBK: Record<string, [number, number]> = { '中': [0xd6, 0xd0], '文': [0xce, 0xc4] };
function gbk(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const b = GBK[ch];
    if (!b) throw new Error(`GBK 码表缺字: ${ch}`);
    out.push(b[0], b[1]);
  }
  return new Uint8Array(out);
}

type Route = { status?: number; contentType?: string; body?: string | Uint8Array; stream?: ReadableStream<Uint8Array> };

/** fetch mock：按完整 URL 精确路由，未命中 404；支持 content-type/字节体/自定义流，并统计调用次数。 */
function fakeFetch(routes: Record<string, Route>, calls: { count: number } = { count: 0 }): typeof fetch {
  return (async (input: unknown, _init?: unknown) => {
    calls.count++;
    const url = String(input);
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    const headers = new Headers();
    if (r.contentType !== undefined) headers.set('content-type', r.contentType);
    return new Response((r.stream ?? r.body ?? '') as BodyInit, { status: r.status ?? 200, headers });
  }) as typeof fetch;
}

const allowAll: PermissionGateway = {
  async check(): Promise<PermissionDecision> { return 'allow'; },
  hasBridgeGrant: () => false,
};

function mkCtx(permissions: PermissionGateway = allowAll, signal?: AbortSignal) {
  const root = mkdtempSync(join(tmpdir(), 'dm-web-'));
  const paths = new MinisPaths(root);
  paths.ensureSessionDirs('S1');
  return { sessionId: 'S1', paths, permissions, signal };
}

const HTML_PAGE = '<!doctype html><html><head><title>示例页</title></head><body><h1>标题一</h1><p>第一段。</p><p>第二段&amp;实体</p></body></html>';

describe('htmlToText 纯函数', () => {
  it('script/style/noscript 整块剥除（含内容），其余正文保留', () => {
    const { text } = htmlToText('<p>a</p><script>alert("x")</script><style>.x{color:red}</style><noscript>无脚本</noscript><p>b</p>');
    expect(text).toContain('a');
    expect(text).toContain('b');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('无脚本');
  });

  it('标题抽取并折叠空白；标题不再重复出现在正文', () => {
    const { title, text } = htmlToText('<html><head><title>  示例\n页 </title></head><body><p>正文</p></body></html>');
    expect(title).toBe('示例 页');
    expect(text).not.toContain('示例');
    expect(text).toContain('正文');
  });

  it('实体解码：命名 + 十进制 + 十六进制；未知命名实体保留原文', () => {
    const { text } = htmlToText('<p>a&amp;b&lt;c&gt;d&quot;e&#39;f&nbsp;g&#20013;h&#x6587;i&amp;junk;</p>');
    expect(text).toBe(`a&b<c>d"e'f g中h文i&junk;`);
  });

  it('块级标签换行：br/</p>/</li>/</h1-6>/</tr> 各成新行', () => {
    const { text } = htmlToText('a<br>b<br/>c</p>d</li>e</h1>f</h2>g</tr>h');
    expect(text).toBe('a\nb\nc\nd\ne\nf\ng\nh');
  });

  it('连续空行折叠为一', () => {
    const { text } = htmlToText('a\n\n\n\n\nb');
    expect(text).toBe('a\n\nb');
  });
});

describe('sniffCharset 纯函数', () => {
  it('content-type 头 charset 优先（含引号形态）', () => {
    expect(sniffCharset('text/html; charset=GBK', utf8(''))).toBe('GBK');
    expect(sniffCharset('text/html; charset="utf-8"', utf8(''))).toBe('utf-8');
  });

  it('头无 charset → 前 1024 字节嗅探 <meta charset>', () => {
    expect(sniffCharset('text/html', utf8('<html><head><meta charset="gb2312">'))).toBe('gb2312');
  });

  it('meta http-equiv 形式同样嗅探', () => {
    expect(sniffCharset(null, utf8('<meta http-equiv="Content-Type" content="text/html; charset=gbk">'))).toBe('gbk');
  });

  it('都无 → undefined（调用方回落 utf-8）', () => {
    expect(sniffCharset('text/html', utf8('<p>无编码声明</p>'))).toBeUndefined();
    expect(sniffCharset(null, new Uint8Array())).toBeUndefined();
  });
});

describe('web_fetch 工具', () => {
  it('定义：name=web_fetch + required url/tool_title', () => {
    const tool = makeWebFetchTool(fakeFetch({}));
    expect(tool.definition.name).toBe('web_fetch');
    expect(tool.definition.required).toContain('url');
    expect(tool.definition.required).toContain('tool_title');
  });

  it('HTML 抓取：URL/状态/标题 元信息行 + 正文转纯文本', async () => {
    const tool = makeWebFetchTool(fakeFetch({ 'https://e.com/page': { contentType: 'text/html; charset=utf-8', body: HTML_PAGE } }));
    const r = await tool.execute({ url: 'https://e.com/page', tool_title: '抓网页' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('URL: https://e.com/page');
    expect(r.output).toContain('状态: 200');
    expect(r.output).toContain('标题: 示例页');
    expect(r.output).toContain('第一段。');
    expect(r.output).toContain('第二段&实体');
  });

  it('编码：头无 charset + meta gbk + GBK 字节 → 中文正确', async () => {
    const body = cat(
      utf8('<!doctype html><html><head><meta charset="gbk"><title>'),
      gbk('中文'),
      utf8('</title></head><body><p>'),
      gbk('中文'),
      utf8('</p></body></html>'),
    );
    const tool = makeWebFetchTool(fakeFetch({ 'https://e.com/gbk': { contentType: 'text/html', body } }));
    const r = await tool.execute({ url: 'https://e.com/gbk', tool_title: '抓 GBK 页' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('标题: 中文');
    expect(r.output).toContain('中文');
  });

  it('未知 charset 标签回退 utf-8 不崩', async () => {
    const tool = makeWebFetchTool(fakeFetch({
      'https://e.com/unknown': { contentType: 'text/html; charset=x-no-such', body: '<html><body><p>纯文本回退</p></body></html>' },
    }));
    const r = await tool.execute({ url: 'https://e.com/unknown', tool_title: '抓未知编码' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('纯文本回退');
  });

  it('体积：超 1MB 的流式 body → 截断注明且不再继续读', async () => {
    const counter = { pulled: 0 };
    const chunk = new Uint8Array(300_000).fill(0x61); // 'a' × 300KB，10 块共 ~3MB
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (counter.pulled >= 10) { c.close(); return; }
        counter.pulled++;
        c.enqueue(chunk);
      },
    });
    const tool = makeWebFetchTool(fakeFetch({ 'https://e.com/big': { contentType: 'text/plain', stream } }));
    const r = await tool.execute({ url: 'https://e.com/big', tool_title: '抓大文件' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('1MB');            // 截断注明
    expect(counter.pulled).toBeLessThan(10);      // 到限即断开，没把 3MB 全读完
    expect(counter.pulled).toBeLessThanOrEqual(5);
    expect(r.output).toContain('[输出超过 100KB 被截断]'); // 最终输出上限同步生效
  });

  it('非文本 content-type → 元信息输出', async () => {
    const tool = makeWebFetchTool(fakeFetch({ 'https://e.com/img': { contentType: 'image/png', body: 'abcd' } }));
    const r = await tool.execute({ url: 'https://e.com/img', tool_title: '抓图片' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('[非文本内容: image/png,');
    expect(r.output).toContain('字节]');
  });

  it('HTTP 404 → success:false 含状态码与响应体前 500 字符', async () => {
    const tool = makeWebFetchTool(fakeFetch({
      'https://e.com/404': { status: 404, contentType: 'text/plain', body: 'ERMARKER' + 'x'.repeat(600) },
    }));
    const r = await tool.execute({ url: 'https://e.com/404', tool_title: '抓 404' }, mkCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('404');
    expect(r.output).toContain('ERMARKER');
    expect(r.output.length).toBeLessThan(1000); // 错误体 600+ 字符只留前 500
  });

  it('file:// URL → 拒绝且不发起请求', async () => {
    const calls = { count: 0 };
    const tool = makeWebFetchTool(fakeFetch({}, calls));
    const r = await tool.execute({ url: 'file:///C:/secret.txt', tool_title: '读本地文件' }, mkCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('http');
    expect(calls.count).toBe(0);
  });

  it('无效 URL 字符串 → success:false', async () => {
    const tool = makeWebFetchTool(fakeFetch({}));
    const r = await tool.execute({ url: 'not a url', tool_title: '坏地址' }, mkCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('URL');
  });

  it('预先 abort 的 ctx.signal → [已取消] 且不发起请求', async () => {
    const ac = new AbortController(); ac.abort();
    const calls = { count: 0 };
    const tool = makeWebFetchTool(fakeFetch({}, calls));
    const r = await tool.execute({ url: 'https://e.com/x', tool_title: '抓取' }, mkCtx(allowAll, ac.signal));
    expect(r.success).toBe(false);
    expect(r.output).toBe('[已取消]');
    expect(calls.count).toBe(0);
  });

  it('权限 DenyAll → asked 一条 kind web-fetch 且 detail 为完整 URL，不发起请求', async () => {
    const asked: PermissionRequest[] = [];
    const denyAll: PermissionGateway = {
      async check(req): Promise<PermissionDecision> { asked.push(req); return 'deny'; },
      hasBridgeGrant: () => false,
    };
    const calls = { count: 0 };
    const tool = makeWebFetchTool(fakeFetch({ 'https://e.com/perm?q=1': { body: 'x' } }, calls));
    const r = await tool.execute({ url: 'https://e.com/perm?q=1', tool_title: '抓取' }, mkCtx(denyAll));
    expect(r.success).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'web-fetch', detail: 'https://e.com/perm?q=1' });
    expect(calls.count).toBe(0);
  });

  it('text/plain 原文返回且无标题行', async () => {
    const tool = makeWebFetchTool(fakeFetch({ 'https://e.com/txt': { contentType: 'text/plain; charset=utf-8', body: 'plain body here' } }));
    const r = await tool.execute({ url: 'https://e.com/txt', tool_title: '抓文本' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('plain body here');
    expect(r.output).not.toContain('标题:');
  });

  it('application/json 原文返回', async () => {
    const tool = makeWebFetchTool(fakeFetch({ 'https://e.com/data.json': { contentType: 'application/json', body: '{"ok":true}' } }));
    const r = await tool.execute({ url: 'https://e.com/data.json', tool_title: '抓 JSON' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('{"ok":true}');
  });

  it('最终输出超 100KB 字符 → 截断注明', async () => {
    const tool = makeWebFetchTool(fakeFetch({ 'https://e.com/long': { contentType: 'text/plain', body: 'y'.repeat(150_000) } }));
    const r = await tool.execute({ url: 'https://e.com/long', tool_title: '抓长文' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output.endsWith('[输出超过 100KB 被截断]')).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(100 * 1024 + 30);
  });
});
