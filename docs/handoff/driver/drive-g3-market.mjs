// G3 审核：市场 UI 全链路真跑（fixture 注入）——扩展 tab → 列表 → 搜索 → 详情 → 确认卡 → 双主题截图。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/de13f871-02f4-5133-95e9-9105e3bca00b/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'g3-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

// ── fixture 数据（形状照 market-adapters.test.ts 实抓字段） ──
const awesomeIndex = JSON.stringify({
  name: 'awesome-dsh-plugin', count: 2,
  plugins: [
    { name: 'dsh-skill-code-reviewer', owner: 'acme', url: 'https://github.com/acme/reviewer', page: 'https://awesome-dsh-plugin.com/p/acme/r/', category: 'skill', description: { en: 'Code review skill', zh: '代码审查技能' }, npm: null, stars: 31, downloads: 1200, install: 'x', added: '2026-08-17' },
    { name: 'dsh-skill-writer', owner: 'bob', url: 'https://github.com/bob/writer', page: 'https://awesome-dsh-plugin.com/p/bob/w/', category: 'skill', description: { en: 'Writing skill', zh: '写作技能' }, npm: null, stars: 8, downloads: 340, install: 'y', added: '2026-08-16' },
  ],
});
const clawhubSearch = JSON.stringify({ results: [{ slug: 'pdf', displayName: 'Pdf', summary: 'PDF 处理技能', downloads: 47943, ownerHandle: 'awspace', isSuspicious: false, native: { skill: { isSuspicious: false, stats: { downloads: 47943, stars: 120 } } } }] });
const clawhubDetail = JSON.stringify({ skill: { slug: 'pdf', displayName: 'Pdf', summary: 'PDF 处理技能', description: '# Pdf 技能\n\n处理 PDF 的技能正文，含**加粗**与列表：\n\n- 提取文本\n- 合并拆分\n', stats: { downloads: 47943, stars: 120 }, topics: ['tool'] }, latestVersion: { version: '0.1.0' }, owner: { handle: 'awspace', displayName: 'AW Space' }, moderation: null, metadata: null });
const clawhubScan = JSON.stringify({ skill: { slug: 'pdf' }, version: { version: '0.1.0' }, security: { status: 'clean', hasScanResult: true, hasWarnings: false, checkedAt: 1, sha256hash: 'abc' }, moderation: null });
const mcpList = JSON.stringify({
  servers: [{ server: { name: 'io.github.acme/fetcher', title: 'Fetcher', description: '网页抓取 MCP 服务器', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'acme-fetcher-mcp', transport: { type: 'stdio' }, runtimeHint: 'npx', environmentVariables: [{ name: 'API_KEY', description: '服务密钥', isRequired: true, isSecret: true }] }] }, _meta: {} }],
  metadata: { nextCursor: null, count: 1 },
});
const mcpDetail = JSON.stringify({ server: { name: 'io.github.acme/fetcher', title: 'Fetcher', description: '网页抓取 MCP 服务器详情', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'acme-fetcher-mcp', transport: { type: 'stdio' }, runtimeHint: 'npx', environmentVariables: [{ name: 'API_KEY', description: '服务密钥', isRequired: true, isSecret: true }] }] }, _meta: {} });

const server = http.createServer((req, res) => {
  console.log('[fixture]', req.url);
  const u = new URL(req.url, 'http://x');
  const json = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); };
  if (u.pathname === '/plugins.json') return json(awesomeIndex);
  if (u.pathname === '/api/v1/search') return json(u.searchParams.get('q') ? clawhubSearch : JSON.stringify({ results: [] }));
  if (u.pathname === '/api/v1/skills/pdf') return json(clawhubDetail);
  if (u.pathname === '/api/v1/skills/pdf/scan') return json(clawhubScan);
  if (u.pathname === '/v0.1/servers') return json(mcpList);
  if (u.pathname.startsWith('/v0.1/servers/')) return json(mcpDetail);
  res.writeHead(404); res.end('{}');
});

const log = (...a) => console.log('[drive]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('screenshot:', name); };
const clickText = (page, scope, text) => page.evaluate(({ scope, text }) => {
  const els = [...document.querySelectorAll(scope)];
  const el = els.find((e) => e.textContent?.trim() === text) ?? els.find((e) => e.textContent?.includes(text));
  if (!el) return 'NOT_FOUND: ' + text + ' | ' + els.map((e) => e.textContent?.trim()).filter(Boolean).slice(0, 20).join(' / ');
  el.click(); return 'OK';
}, { scope, text });

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${server.address().port}`;
log('fixture at', FIXTURE);

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'],
  cwd: APP_DIR,
  timeout: 45_000,
  env: { ...process.env, DESKMINIS_DATA_DIR: DATA, DESKMINIS_MARKET_FIXTURE_URL: FIXTURE },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null;
    if (!page) await sleep(500);
  }
  if (!page) page = await app.firstWindow();
  await page.waitForSelector('body', { timeout: 15_000 });
  await sleep(4000);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

  const clickRes = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.wtab-main')];
    const b = btns.find((e) => e.textContent?.trim() === '扩展');
    if (!b) return 'NOT_FOUND among ' + btns.map((e) => e.textContent?.trim()).join('/');
    b.click();
    return 'CLICKED';
  });
  log('open market tab →', clickRes);
  await sleep(800);
  log('active tab →', await page.evaluate(() => document.querySelector('.wtab.on')?.textContent?.trim() ?? 'NONE'));
  for (let i = 0; i < 30; i++) {
    const t = await page.evaluate(() => document.body.innerText);
    if (t.includes('代码审查技能') || t.includes('dsh-skill')) break;
    await sleep(400);
  }
  await sleep(600);
  await ss(page, 'g3-list-dark');

  // 搜索 pdf（防抖 300ms）
  await page.evaluate(() => {
    const cands = [...document.querySelectorAll('input')].filter((e) => e.type !== 'file' && e.type !== 'checkbox');
    const inp = cands.find((e) => (e.placeholder ?? '').includes('搜') || e.type === 'search') ?? cands[0];
    if (inp) { inp.value = 'pdf'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await sleep(1500);
  await ss(page, 'g3-search-dark');

  // 详情：点 Pdf 卡
  log('detail →', await clickText(page, 'button, [role="button"], .mcard, div', 'Pdf'));
  await sleep(1200);
  await ss(page, 'g3-detail-dark');

  // 确认卡：点安装
  log('install →', await clickText(page, 'button', 'Install'));
  await sleep(1500);
  await ss(page, 'g3-confirm-dark');

  // 亮色确认卡
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await sleep(400);
  await ss(page, 'g3-confirm-light');

  const bodyText = await page.evaluate(() => document.body.innerText);
  log('确认卡文本采样:', bodyText.split('\n').filter((l) => l.includes('安全') || l.includes('SKILL') || l.includes('sha') || l.includes('安装') || l.includes('来源')).slice(0, 8).join(' | '));
} finally {
  await app.close().catch(() => {});
  server.close();
}
log('done');
