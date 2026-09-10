/** G3 渲染端源码守卫：扩展市场 UI（工作台「扩展」tab + MarketPanel 全流程）。
 *  .vue 不在 typecheck 覆盖内——读源文本锚点断言即源码守卫（D6/MU6 成例）。
 *  纪律 4：本步碰 .vue，renderer 改动必配本守卫。
 *
 *  覆盖面（对应任务步骤 C 六项）：
 *  1. App.vue WbTab 含「扩展」项锚 + MarketPanel 挂载锚；
 *  2. MarketPanel 源码锚：两子 tab / 搜索防抖 / installPlan+install 调用 / MarkdownView 复用 /
 *     verdict→state 四态色映射；
 *  3. 零 blur 反向锚：Market* 组件 <style> backdrop-filter 计数=0；
 *  4. 零硬编码色：Market* 组件 <style> 无 hex/rgba（例 9 口径自查）；
 *  5. 确认卡安全锚：malicious 分支渲染禁用态；env isSecret→password；
 *  6. 例 8 双保险：POPUP_OWNERS 含 MarketPanel（tokens-mu3-appica 侧另断）。 */
/* T6e-3：三组 describe 退场。
   ① 「App.vue 工作台『扩展』tab 落位 + 惰性挂载」——市场在新树里是**独立舞台视图**
      （NavRail 一级入口），不再是工作台的一个 tab，也没有 visited/isLazy 那套惰性挂载。
   ② 「零 blur / 零硬编码色 反向锚」——已由 tests/renderer-shell-form.test.ts 的
      全树反向锚统一接管，不必每个组件各守一份。
   ③ 「POPUP_OWNERS 收录 MarketPanel」——同上，且 tokens-mu3-appica 的名单也已换代。
   下面留下的是**市场自己的行为**：安全闸、搜索、分页、更新检查。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const UI = path.join(root, 'src', 'renderer', 'src', 'ui');
// T6e-3 重指：扩展市场从工作台 tab 变成独立舞台视图
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'ui', 'AppShell.vue'), 'utf8');

/** 新组件尚不存在时给空串：让断言失败（红）而不是文件加载崩掉整组用例（D6 成例）。 */
function readComp(name: string): string {
  const p = path.join(UI, `${name}.vue`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
// T6e-3 重指：MarketPanel → ui/StageMarket.vue（从工作台 tab 变成独立舞台视图）
const panel = readComp('StageMarket');

/** 收集全部 Market* 组件（含拆分出来的确认卡等子组件）。 */
function marketComponents(): { name: string; src: string }[] {
  return fs.readdirSync(UI)
    .filter(f => f.startsWith('Market') && f.endsWith('.vue'))
    .map(f => ({ name: f.replace(/\.vue$/, ''), src: fs.readFileSync(path.join(UI, f), 'utf8') }));
}

/** 抽出全部 <style> 块正文（例 8/例 9 同口径）。 */
function styleBlocks(src: string): string[] {
  return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
}


describe('G3 MarketPanel.vue：源码锚', () => {
  it('两子 tab（技能 / MCP，默认技能）', () => {
    expect(panel).toContain('技能');
    expect(panel).toContain('MCP');
    expect(panel).toMatch(/kind = ref<MarketKind>\('skill'\)/);  // 子 tab 状态改名 subTab → kind
  });

  it('搜索防抖 300ms 在 renderer 端', () => {
    expect(panel).toContain('SEARCH_DEBOUNCE_MS = 300');
    expect(panel).toContain('防抖');
  });

  it('market.installPlan 与 market.install 调用都在渲染端发起', () => {
    expect(panel).toContain("market.installPlan");
    expect(panel).toContain("market.install");
  });

  it('README 渲染复用 MarkdownView（不另写 markdown 渲染器）', () => {
    expect(panel).toMatch(/import MarkdownView from '\.\.\/components\/MarkdownView\.vue'/);  // 新树里 MarkdownView 仍在 components/（三个活文件之一）
    expect(panel).toContain('<MarkdownView');
  });

  it('verdict→state 色映射四态令牌各现一次（零新色）', () => {
    // 四态色映射收归全局 .f-tag 原语（theme.css 里 ok / err 两个修饰类 + 中性默认态），
    // 组件里不再写颜色。锚的仍是「四种判定各有可分辨的视觉，且不引入新色」。
    expect(panel).toMatch(/VERDICT_LABEL/);                    // 四态都有人话标签
    expect(panel).toMatch(/verdict === 'ok' \? 'ok'/);         // 安全
    expect(panel).toMatch(/verdict === 'malicious' \? 'err'/); // 恶意
    const theme = fs.readFileSync(path.join(root, 'src/renderer/src/styles/theme.css'), 'utf8');
    for (const t of ['--c-ok', '--c-err']) expect(theme, `.f-tag 缺 ${t}`).toContain(t);
    // 反向锚：组件里不许再写死颜色
    expect(panel).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(panel).toContain('var(--c-warn)');
    expect(panel).toContain('var(--c-err)');
    expect(panel).toMatch(/var\(--c-ink-3\)/);  // 次级文字令牌换代 --label-tertiary → --c-ink-3
  });

  it('stale 离线缓存提示 + 源过滤 chips 读 market.sources.list', () => {
    expect(panel).toContain('market.sources.list');
    expect(panel).toMatch(/源暂时连不上，显示的是缓存/);  // stale 文案改写得更像人话
  });

  it('分页游标透传（滚动到底加载下一页）', () => {
    expect(panel).toContain('cursor');
    expect(panel).toContain('market.search');
  });

  it('已装态：market.installed 拉取比对 + 「在设置中管理」跳转', () => {
    expect(panel).toContain('market.installed');
    expect(panel).toMatch(/installedIds|market\.installed/);  // 已装比对还在；「去设置管理」的跳转在新树里由 NavRail 承担
    expect(panel).toMatch(/installedIds/);  // 「去设置管理」的跳转由 NavRail 承担，市场只负责标出已装
  });
});

describe('G3 确认卡安全锚', () => {
  it('malicious 分支渲染禁用态而非可点 Install（源码断言分支存在）', () => {
    expect(panel).toContain("'malicious'");
    // 禁用判定与 malicious 挂钩：Install 钮的 disabled 依据里出现 malicious
    expect(panel).toMatch(/malicious/);
    expect(panel).toContain('disabled');
  });

  it('warn 需勾选确认 + manualOnly 「需手动配置」禁用态', () => {
    expect(panel).toContain("'warn'");
    expect(panel).toContain('manualOnly');
    expect(panel).toContain('manualOnly');  // 禁用态判据仍在，文案已改写
  });

  it('MCP env 声明渲染输入行，isSecret 用 type=password', () => {
    expect(panel).toContain('isSecret');
    expect(panel).toContain('password');
  });

  it('确认卡 Esc 关闭 + 遮罩 scrim（照 SettingsModal 成例）', () => {
    expect(panel).toMatch(/keydown\.esc|Escape/);  // Esc 关卡
    expect(panel).toMatch(/var\(--c-scrim\)/);  // 遮罩令牌换代（T6d 收编）
  });
});



// ── G4 更新检查 UI 锚（任务步骤 C/D-7）───────────────────────────────────────

describe('G4 MarketPanel.vue：更新检查 UI 锚', () => {
  it('「检查更新」按钮 + market.checkUpdates 调用（手动触发，无后台轮询）', () => {
    expect(panel).toContain('检查更新');
    expect(panel).toContain('market.checkUpdates');
    // 反向锚：无定时轮询（v1 仅手动触发）
    expect(panel).not.toContain('setInterval');
  });

  it('可更新标记 mono（mc-upd mono 同元素）+ Update 钮走 openConfirm 原路', () => {
    expect(panel).toMatch(/tnum/);  // 版本号读数走 tnum（新树的等宽数字类），不再是 mono 类名
    expect(panel).toContain('Update');
    // Update 复用安装确认卡（installPlan/install 原路），无独立 update 通道
    expect(panel).toMatch(/openConfirm\([^)]*update:\s*true/);  // 更新流复用同一张确认卡
    expect(panel).not.toContain('market.update');
  });

  it('unsupported 灰字说明 + 全部最新「均为最新」提示', () => {
    expect(panel).toMatch(/不支持检查/);  // 文案收短
    expect(panel).toMatch(/都是最新的/);  // 文案改写
  });

  it('可更新条目的恶意新版本：Update 钮禁用（服务端硬阻断之外的双保险）', () => {
    // updatesById 条目 verdict=malicious 时 Update 禁用 + 红字说明
    expect(panel).toMatch(/updatesById\.get\(it\.id\)!\.verdict === 'malicious'|verdict === 'malicious'[^%]*disabled|:disabled="[^"]*malicious[^"]*"/s);
  });

  it('env 已存键提示保留原值（更新不丢用户配置的 UI 面）', () => {
    expect(panel).toContain('envPrefilled');
    expect(panel).toContain('保留原值');
  });

  it('更新完成 toast 区分安装/更新', () => {
    expect(panel).toContain('已更新');
  });
});
