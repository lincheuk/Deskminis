// Z 波实拍：模型组降级的界面（设计稿 docs/specs/2026-09-24-model-group-ui-design.md §5）。
// **真 provider + 本地假 OpenAI 端点**（mock-openai.mjs：/fail 回 429、/ok 流式回复），不用 FakeProvider——
// FakeProvider 的 __fail__ 会让组里每个成员一起失败，走不到「主力失败、备用接手」。
// 数据根种两个免密钥 ollama 类 provider：「主力（会限流）」→ /fail，「备用」→ /ok；默认模型设为「备用」，
// 这样主力被请求过 = 组确实生效（默认模型永远不会去碰主力）。组本身全程从界面上建。
//
// 一次冷启动顺序跑四段（后一段依赖前一段的状态）：
//   groups    设置 → 模型 → 模型组：空成员被拦 → 先加备用再加主力 → ↑ 把主力提到第一 → 创建 → 列表链
//   bind      新建会话 → 先改名（让自动命名不触发，才验得出改绑广播）→ ⋮ 选组 → 胶囊 → 发消息 → 降级 →
//             不手动刷新，看前端自己跟上改绑（Z1 的广播）+ 事件起点是主力真名 + 任务面板卡
//   assistant 助手编辑器选组 → 保存 → 列表标签
//   delete    会话绑回组 → 删组（确认句报绑定数）→ 胶囊变色 + 下拉禁用项 → 发消息 → 如实报错 + 草稿交回
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startMockOpenAI } from './mock-openai.mjs';

const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log('[z1]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};

const mock = await startMockOpenAI();
const DATA = path.join(S, `z1-data-${Date.now()}`);
fs.mkdirSync(DATA, { recursive: true });
const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({
  providers: [
    { id: A, name: '主力（会限流）', kind: 'ollama', baseUrl: `http://127.0.0.1:${mock.port}/fail/v1`, modelId: 'mock-primary' },
    { id: B, name: '备用', kind: 'ollama', baseUrl: `http://127.0.0.1:${mock.port}/ok/v1`, modelId: 'mock-backup' },
  ],
  defaultProviderId: B,
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.waitForSelector('textarea.field', { timeout: 20_000 });
  await sleep(1500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  const ss = async (name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot:', name); };
  const store = (fn, ...args) => page.evaluate(([fn, args]) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat')[fn](...args), [fn, args]);
  const st = () => page.evaluate(() => {
    const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
    const cap = [...document.querySelectorAll('.cap')].find(e => e.querySelector('svg'));
    return {
      activeId: c.activeId, binding: c.sessions.find(s => s.id === c.activeId)?.modelBinding ?? null,
      groups: c.modelGroups.map(g => ({ id: g.id, name: g.name, memberIds: g.memberIds })),
      running: c.running, lastError: c.lastError, fallbackState: c.fallbackState,
      assistants: c.assistants.map(a => ({ name: a.name, modelBinding: a.modelBinding })),
      pill: cap ? { text: cap.textContent.trim(), title: cap.getAttribute('title'), bad: cap.classList.contains('bad') } : null,
    };
  });
  // 文本匹配：trim 全等优先，再退回 includes（「删除」与「确认删除」这类前缀重叠的按钮）
  const clickText = (sel, text) => page.evaluate(({ sel, text }) => {
    const all = [...document.querySelectorAll(sel)];
    const el = all.find(e => e.textContent?.trim() === text) ?? all.find(e => e.textContent?.includes(text));
    if (!el) return 'NOT_FOUND:' + text;
    el.click(); return 'OK';
  }, { sel, text });
  const setSelect = (sel, value) => page.evaluate(({ sel, value }) => {
    const el = document.querySelector(sel);
    if (!el) return 'NO_SELECT:' + sel;
    el.value = value; el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  }, { sel, value });
  async function waitTurn(maxMs = 30_000) {
    let saw = false;
    for (let t = 0; t < maxMs; t += 50) {
      const r = (await st()).running;
      if (r) saw = true; else if (saw) return true;
      await sleep(50);
    }
    return saw;
  }
  async function send(text) {
    await page.evaluate((text) => {
      const ta = document.querySelector('textarea.field');
      ta.focus(); ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await sleep(120);
    await page.keyboard.press('Enter');
  }

  // ================= groups =================
  log('groups: settings →', await clickText('.navit', '设置'));
  await sleep(500);
  log('groups: new →', await clickText('.f-btn', '新建模型组'));
  await sleep(200);
  await page.fill('input[placeholder="如「主力 + 备用」"]', '主备');
  // 空成员先点创建：必须在前端被拦（后端对空 memberIds 静默忽略）
  log('groups: create w/o members →', await clickText('button[type="submit"]', '创建'));
  await sleep(200);
  out.emptyMembersErr = await page.evaluate(() => [...document.querySelectorAll('.errline')].map(e => e.textContent.trim()).join('|'));
  out.groupsAfterEmptyCreate = (await st()).groups.length;
  log('groups: add backup →', await setSelect('.addrow select', B), await clickText('.addrow .f-btn', '加入'));
  await sleep(150);
  log('groups: add primary →', await setSelect('.addrow select', A), await clickText('.addrow .f-btn', '加入'));
  await sleep(150);
  out.orderBeforeMove = await page.evaluate(() => [...document.querySelectorAll('.mlist .mname')].map(e => e.textContent.trim()));
  log('groups: move primary up →', await page.evaluate(() => { const b = document.querySelectorAll('.mlist .mrow')[1]?.querySelector('button[title="上移"]'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
  await sleep(150);
  out.orderAfterMove = await page.evaluate(() => [...document.querySelectorAll('.mlist .mname')].map(e => e.textContent.trim()));
  out.addableLeft = await page.evaluate(() => !!document.querySelector('.addrow'));
  await ss('z1-group-form');
  log('groups: create →', await clickText('button[type="submit"]', '创建'));
  await sleep(600);
  const g0 = (await st()).groups;
  out.groupsCreated = g0;
  out.chainText = await page.evaluate(() => document.querySelector('.gcard .gchain')?.textContent?.trim() ?? '');
  await ss('z1-group-list');
  const GID = g0[0]?.id;

  // ================= bind =================
  log('bind: new session →', await clickText('.newbtn', '新建会话'));
  await sleep(600);
  const sid = (await st()).activeId;
  await store('renameSession', sid, '降级实拍');   // 自动命名不触发 → 前端跟上改绑只能靠 Z1 的广播
  await sleep(300);
  log('bind: open ⋮ →', await page.evaluate(() => { const b = document.querySelector('.srw.on .smore'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
  await sleep(250);
  out.menuOptgroup = await page.evaluate(() => {
    const og = document.querySelector('.smenu select optgroup');
    return og ? { label: og.getAttribute('label'), options: [...og.querySelectorAll('option')].map(o => o.textContent.trim() + '=' + o.value) } : null;
  });
  log('bind: select group →', await setSelect('.smenu select', `group:${GID}`));
  await sleep(500);
  const b1 = await st();
  out.boundBinding = b1.binding;
  out.pillBound = b1.pill;
  out.pillIconIsLink = await page.evaluate(() => {
    const cap = [...document.querySelectorAll('.cap')].find(e => e.querySelector('svg'));
    return cap?.querySelector('svg')?.outerHTML?.length ?? 0;
  });
  await ss('z1-bound');
  await send('测试一下降级');
  log('bind: turn →', await waitTurn());
  await sleep(1200);   // 给改绑广播 + 重拉列表留时间；**不**手动 refreshSessions
  const b2 = await st();
  out.afterTurn = { binding: b2.binding, pill: b2.pill, fallbackState: b2.fallbackState, lastError: b2.lastError };
  out.menuValueAfter = await page.evaluate(() => document.querySelector('.smenu select')?.value ?? null);
  out.mockHits = mock.hits.map(h => h.path + '#' + h.model);
  await ss('z1-after-fallback');
  log('bind: tasks tab →', await clickText('button', '任务'));
  await sleep(400);
  out.taskCard = await page.evaluate(() => [...document.querySelectorAll('.blk')].map(b => b.textContent.replace(/\s+/g, ' ').trim()).find(t => t.startsWith('模型降级')) ?? '');
  await ss('z1-task-card');

  // ================= assistant =================
  log('assistant: view →', await clickText('.navit', '助手'));
  await sleep(500);
  log('assistant: edit first →', await page.evaluate(() => { const b = document.querySelector('.acard .aacts .f-btn[title="编辑"]'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
  await sleep(300);
  out.assistantOptgroup = await page.evaluate(() => [...document.querySelectorAll('form optgroup option')].map(o => o.textContent.trim() + '=' + o.value));
  log('assistant: select group →', await setSelect('form select.f-select', `group:${GID}`));
  await sleep(150);
  await ss('z1-assistant-form');
  log('assistant: save →', await clickText('button[type="submit"]', '保存'));
  await sleep(600);
  out.assistantAfter = (await st()).assistants[0];
  out.assistantTag = await page.evaluate(() => [...document.querySelectorAll('.acard')][0]?.querySelector('.f-tag')?.textContent?.trim() ?? '');
  await ss('z1-assistant-list');

  // ================= delete =================
  // 会话此刻已改绑到备用；绑回组，好让删除确认数得出「1 个会话」
  await store('setSessionModelBinding', sid, `group:${GID}`);
  await sleep(300);
  log('delete: settings →', await clickText('.navit', '设置'));
  await sleep(500);
  log('delete: ask →', await page.evaluate(() => { const b = [...document.querySelectorAll('.gcard .f-btn.danger')].find(e => e.textContent.trim() === '删除'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
  await sleep(200);
  out.deleteAsk = await page.evaluate(() => document.querySelector('.gask .f-confirm')?.textContent?.trim() ?? '');
  await ss('z1-delete-ask');
  log('delete: confirm →', await clickText('.gask .f-btn', '确认删除'));
  await sleep(600);
  out.groupsAfterDelete = (await st()).groups.length;
  log('delete: back to session →', await page.evaluate((sid) => { const rows = [...document.querySelectorAll('.srw')]; const r = rows.find(x => x.textContent.includes('降级实拍')); if (!r) return 'NO_ROW'; r.querySelector('.srow').click(); return 'OK'; }, sid));
  await sleep(700);
  const d1 = await st();
  out.pillAfterDelete = d1.pill;
  // 会话菜单的开合状态跨视图保留（bind 段开过没关）——已开就别再点，⋮ 是开关，再点等于收起
  log('delete: open ⋮ →', await page.evaluate(() => { if (document.querySelector('.srw.on.open')) return 'ALREADY_OPEN'; const b = document.querySelector('.srw.on .smore'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
  await sleep(250);
  out.menuMissingOption = await page.evaluate(() => {
    const sel = document.querySelector('.smenu select');
    const o = sel ? [...sel.options].find(x => x.disabled) : null;
    return o ? { text: o.textContent.trim(), selected: sel.value === o.value } : null;
  });
  await ss('z1-deleted-pill');
  await send('删了组之后再发一条');
  await sleep(1500);
  const d2 = await st();
  out.sendAfterDelete = { lastError: d2.lastError, draft: await page.evaluate(() => document.querySelector('textarea.field')?.value ?? null) };
  out.errBanner = await page.evaluate(() => document.querySelector('.stage .err')?.textContent?.trim() ?? '');
  await ss('z1-deleted-send');
  log('assistant tag after delete →', await clickText('.navit', '助手'));
  await sleep(400);
  out.assistantTagAfterDelete = await page.evaluate(() => { const t = [...document.querySelectorAll('.acard')][0]?.querySelector('.f-tag'); return t ? { text: t.textContent.trim(), err: t.classList.contains('err') } : null; });
} finally {
  out.errors = errors;
  log(JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(S, `z1-result-${Date.now()}.json`), JSON.stringify(out, null, 2));
  await app.close().catch(() => {});
  await mock.close();
}
