// Z 波立项前的探针（现有构建 ba4b919，不改任何代码）：核实两个推断——
//   ① 输入卡模型胶囊无视会话绑定（绑定到组后仍显示默认模型）；
//   ② 降级成功后后端把会话改绑到 provider:<接手者>，但不广播 chat.sessions.changed，
//      前端 sessions[].modelBinding 停在 group:（自动命名只在首回合广播一次，先改名让它不触发）。
// 组与 provider 直接种进数据根 providers.json（现有 store 没有建组的 action）。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startMockOpenAI } from './mock-openai.mjs';

const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log('[z0]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMockOpenAI();
const DATA = path.join(S, `z0-data-${Date.now()}`);
fs.mkdirSync(DATA, { recursive: true });
const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';
const G = 'CCCCCCCC-0000-4000-8000-000000000003';
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({
  providers: [
    { id: A, name: '主力（会限流）', kind: 'ollama', baseUrl: `http://127.0.0.1:${mock.port}/fail/v1`, modelId: 'mock-primary' },
    { id: B, name: '备用', kind: 'ollama', baseUrl: `http://127.0.0.1:${mock.port}/ok/v1`, modelId: 'mock-backup' },
  ],
  // 默认设成「备用」：默认模型永远不会去碰主力，主力被请求过 = 组确实生效
  defaultProviderId: B,
  modelGroups: [{ id: G, name: '主备', memberIds: [A, B], createdAt: Date.now() / 1000 }],
}, null, 2));

const env = { ...process.env, DESKMINIS_DATA_DIR: DATA };
delete env.DESKMINIS_FAKE_PROVIDER;
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000, env,
});
const errors = [];
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
  if (!page) page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e?.message ?? e)));
  await page.waitForSelector('textarea.field', { timeout: 20_000 });
  await sleep(1500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const store = (fn, ...args) => page.evaluate(([fn, args]) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat')[fn](...args), [fn, args]);
  const st = () => page.evaluate(() => {
    const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
    return {
      activeId: c.activeId, binding: c.sessions.find(s => s.id === c.activeId)?.modelBinding ?? null,
      title: c.sessions.find(s => s.id === c.activeId)?.title, running: c.running, lastError: c.lastError,
      fallbackState: c.fallbackState, notes: c.eventNotes.map(n => n.kind + ':' + (n.detail ?? '')),
      pill: document.querySelector('.composer .cap, .cap')?.textContent?.trim() ?? null,
    };
  });

  await store('newSession');
  await sleep(300);
  const sid = (await st()).activeId;
  await store('renameSession', sid, '改名后的会话');           // 自动命名不再触发 → 不会顺手广播 sessions.changed
  await store('setSessionModelBinding', sid, `group:${G}`);
  await sleep(300);
  const before = await st();
  log('before send:', JSON.stringify(before));
  await page.screenshot({ path: path.join(SHOTS, 'z0-before.png') });

  await page.evaluate(() => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = '测试一下降级'; ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(120);
  await page.keyboard.press('Enter');
  let saw = false;
  for (let t = 0; t < 30_000; t += 50) {
    const r = (await st()).running;
    if (r) saw = true; else if (saw) break;
    await sleep(50);
  }
  await sleep(1500);   // 给可能的广播与重拉留足时间
  const after = await st();
  log('after turn:', JSON.stringify(after));
  // 后端真相：直接读数据根里的 sqlite 太重，这里让 store 重拉一次列表对比（重拉前先记下前端的旧值）
  const staleBinding = after.binding;
  await store('refreshSessions');
  await sleep(200);
  const truth = (await st()).binding;
  log(JSON.stringify({ staleBinding, backendTruthAfterRefresh: truth, stale: staleBinding !== truth, mockHits: mock.hits.map(h => h.path + '#' + h.model), errors }));
  await page.screenshot({ path: path.join(SHOTS, 'z0-after.png') });
} finally {
  await app.close().catch(() => {});
  await mock.close();
}
