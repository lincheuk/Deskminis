// H2 自审 driver：真选区 → 浮条 → 标注落库 → Highlight 渲染 → 引用预填 → 重启持久化。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/de13f871-02f4-5133-95e9-9105e3bca00b/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'h2-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
// UI 发送走默认 provider——必须预置 __fake__ 为默认（mu6/use 两驱动同款种子）
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

const MD = '结论段落：Aurora 主题的对比度守卫覆盖了全部二十六对组合，**关键防线**是 OKLCH 到 sRGB 的换算精度。\n\n- 第一点：换算走 float64\n- 第二点：断言含粗体内联';
const log = (...a) => console.log('[h2]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot:', name); };
const waitText = async (page, needle, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if ((await page.evaluate(() => document.body.innerText)).includes(needle)) return true;
    await sleep(500);
  }
  return false;
};

async function launch() {
  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000,
    env: { ...process.env, DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_FAKE_REPLY: MD },
  });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null;
    if (!page) await sleep(500);
  }
  await page.waitForSelector('body', { timeout: 15_000 });
  await sleep(4000);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  return { app, page };
}

// 在首个助手正文根里选中「关键防线」四个字并派发 mouseup
const selectInRoot = (page, needle) => page.evaluate((needle) => {
  const root = document.querySelector('.msg-a [data-anno-root]');
  if (!root) return 'NO_ROOT';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const i = n.data.indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i); r.setEnd(n, i + needle.length);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.querySelector('.stream').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return 'SELECTED';
  }
  return 'NEEDLE_NOT_FOUND';
}, needle);

// ═══ 段 1：发消息 → 选区 → 标注 → 高亮 ═══
{
  const { app, page } = await launch();
  try {
    await page.evaluate(() => {
      const ta = document.querySelector('.composer textarea');
      ta.value = '讲讲对比度守卫'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => { [...document.querySelectorAll('.composer button')].at(-1).click(); });
    log('等助手回复渲染:', await waitText(page, '关键防线'));
    await sleep(1200); // turnEnd 落库 + open() 重取（乐观 id 换正式 id）

    log('选区 →', await selectInRoot(page, '关键防线'));
    await sleep(400); // rAF 后浮条出现
    const bar = await page.evaluate(() => {
      const b = document.querySelector('.annobar');
      return b ? [...b.querySelectorAll('button')].map(x => x.textContent.trim()).join('/') : 'NO_BAR';
    });
    log('浮条:', bar);
    await ss(page, 'h2-annobar');

    // 点「标注」——真实路径是 mousedown（浮条按钮用 mousedown.prevent）
    const hit = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.annobar button')].find(x => x.textContent.includes('标注'));
      if (!b) return 'NO_BTN';
      b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return 'ANNOTATED';
    });
    log('标注 →', hit);
    await sleep(1200); // RPC 往返 + changed 广播 + 重算
    const hl = await page.evaluate(() => ({
      registered: CSS.highlights.has('dm-anno'),
      count: CSS.highlights.get('dm-anno')?.size ?? 0,
    }));
    log('Highlight:', JSON.stringify(hl));
    await ss(page, 'h2-highlighted-dark');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await sleep(400);
    await ss(page, 'h2-highlighted-light');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

    // 引用：再选一段 → 点引用 → 输入框预填 '> '
    log('选区2 →', await selectInRoot(page, '换算走 float64'));
    await sleep(400);
    const q = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.annobar button')].find(x => x.textContent.includes('引用'));
      if (!b) return 'NO_BTN';
      b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return 'QUOTED';
    });
    log('引用 →', q);
    await sleep(400);
    const composer = await page.evaluate(() => document.querySelector('.composer textarea').value);
    log('composer 预填:', JSON.stringify(composer));
    await ss(page, 'h2-quoted');
  } finally { await app.close().catch(() => {}); }
}

// ═══ 段 2：重启 → 高亮持久化重锚定 → 气泡三动作 ═══
{
  const { app, page } = await launch();
  try {
    // 左栏点回既有会话
    await page.evaluate(() => { document.querySelector('[data-sid]')?.click(); });
    log('等历史渲染:', await waitText(page, '关键防线'));
    await sleep(1500);
    const hl = await page.evaluate(() => ({
      registered: CSS.highlights.has('dm-anno'),
      count: CSS.highlights.get('dm-anno')?.size ?? 0,
    }));
    log('重启后 Highlight:', JSON.stringify(hl));
    await ss(page, 'h2-persist');

    // 点击高亮中点 → 气泡
    const popOpen = await page.evaluate(() => {
      const root = document.querySelector('.msg-a [data-anno-root]');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = n.data.indexOf('关键防线');
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i + 2); r.setEnd(n, i + 2);
        const rect = r.getBoundingClientRect();
        const ev = new MouseEvent('mouseup', { bubbles: true, clientX: rect.left + 1, clientY: rect.top + 4 });
        document.querySelector('.stream').dispatchEvent(ev);
        return 'CLICKED@' + Math.round(rect.left) + ',' + Math.round(rect.top);
      }
      return 'NO_TEXT';
    });
    log('点高亮 →', popOpen);
    await sleep(500);
    const pop = await page.evaluate(() => {
      const p = document.querySelector('.annopop');
      return p ? { quote: p.querySelector('.annoquote')?.textContent, focused: document.activeElement?.className } : 'NO_POP';
    });
    log('气泡:', JSON.stringify(pop));
    await ss(page, 'h3-pop-open');

    // 填笔记 → 保存 → 重开验证 note 持久 + noted 高亮档
    await page.evaluate(() => {
      const ta = document.querySelector('.annonote');
      ta.value = '这里要复查换算精度'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.annosave').click();
    });
    await sleep(1000);
    const noted = await page.evaluate(() => CSS.highlights.get('dm-anno-noted')?.size ?? 0);
    log('保存后 noted 高亮档:', noted);
    // 重开气泡看 note 回显
    await page.evaluate(() => {
      const root = document.querySelector('.msg-a [data-anno-root]');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = n.data.indexOf('关键防线');
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i + 2); r.setEnd(n, i + 2);
        const rect = r.getBoundingClientRect();
        document.querySelector('.stream').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.left + 1, clientY: rect.top + 4 }));
        return;
      }
    });
    await sleep(500);
    log('note 回显:', await page.evaluate(() => document.querySelector('.annonote')?.value ?? 'NO_POP'));
    await ss(page, 'h3-pop-note');

    // 删除 → 高亮清零
    await page.evaluate(() => { document.querySelector('.annodel')?.click(); });
    await sleep(1000);
    log('删除后 Highlight:', await page.evaluate(() => CSS.highlights.get('dm-anno')?.size ?? 0));
    await ss(page, 'h3-deleted');
  } finally { await app.close().catch(() => {}); }
}
log('done');
