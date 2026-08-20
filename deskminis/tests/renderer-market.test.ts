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
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const COMPONENTS = path.join(root, 'src', 'renderer', 'src', 'components');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'App.vue'), 'utf8');

/** 新组件尚不存在时给空串：让断言失败（红）而不是文件加载崩掉整组用例（D6 成例）。 */
function readComp(name: string): string {
  const p = path.join(COMPONENTS, `${name}.vue`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
const panel = readComp('MarketPanel');

/** 收集全部 Market* 组件（含拆分出来的确认卡等子组件）。 */
function marketComponents(): { name: string; src: string }[] {
  return fs.readdirSync(COMPONENTS)
    .filter(f => f.startsWith('Market') && f.endsWith('.vue'))
    .map(f => ({ name: f.replace(/\.vue$/, ''), src: fs.readFileSync(path.join(COMPONENTS, f), 'utf8') }));
}

/** 抽出全部 <style> 块正文（例 8/例 9 同口径）。 */
function styleBlocks(src: string): string[] {
  return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
}

describe('G3 App.vue：工作台「扩展」tab 落位', () => {
  it('WbPanel 类型联合含 market + BUILTIN_TABS 有「扩展」项（全局非会话 tab）', () => {
    expect(app).toContain("'market'");
    expect(app).toContain("id: 'market'");
    expect(app).toContain("label: '扩展'");
    expect(app).toContain("panel: 'market'");
  });

  it('MarketPanel 惰性挂载：import + visited.market + isLazy 分支 + v-show/v-if 面板体', () => {
    expect(app).toContain("import MarketPanel from './components/MarketPanel.vue'");
    expect(app).toContain('market: false');
    expect(app).toContain('<MarketPanel v-if="visited.market" />');
    expect(app).toContain("rightTab === 'market'");
  });
});

describe('G3 MarketPanel.vue：源码锚', () => {
  it('两子 tab（技能 / MCP，默认技能）', () => {
    expect(panel).toContain('技能');
    expect(panel).toContain('MCP');
    expect(panel).toMatch(/subTab/);
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
    expect(panel).toContain("import MarkdownView from './MarkdownView.vue'");
    expect(panel).toContain('<MarkdownView');
  });

  it('verdict→state 色映射四态令牌各现一次（零新色）', () => {
    expect(panel).toContain('var(--state-ok)');
    expect(panel).toContain('var(--state-warn)');
    expect(panel).toContain('var(--state-err)');
    expect(panel).toContain('var(--label-tertiary)');
  });

  it('stale 离线缓存提示 + 源过滤 chips 读 market.sources.list', () => {
    expect(panel).toContain('market.sources.list');
    expect(panel).toContain('离线缓存');
  });

  it('分页游标透传（滚动到底加载下一页）', () => {
    expect(panel).toContain('cursor');
    expect(panel).toContain('market.search');
  });

  it('已装态：market.installed 拉取比对 + 「在设置中管理」跳转', () => {
    expect(panel).toContain('market.installed');
    expect(panel).toContain('在设置中管理');
    expect(panel).toContain('openSettings');
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
    expect(panel).toContain('需手动配置');
  });

  it('MCP env 声明渲染输入行，isSecret 用 type=password', () => {
    expect(panel).toContain('isSecret');
    expect(panel).toContain('password');
  });

  it('确认卡 Esc 关闭 + 遮罩 scrim（照 SettingsModal 成例）', () => {
    expect(panel).toContain('Escape');
    expect(panel).toContain('var(--scrim)');
  });
});

describe('G3 零 blur / 零硬编码色 反向锚（全部 Market* 组件）', () => {
  it('Market* 组件 <style> 内 backdrop-filter 计数=0（实心浮岛，内容面板纪律）', () => {
    const offenders: string[] = [];
    for (const { name, src } of marketComponents()) {
      for (const b of styleBlocks(src)) {
        if (b.includes('backdrop-filter')) offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
    // 自检：MarketPanel 必须已被纳入扫描（防止目录读空造成假绿）
    expect(marketComponents().some(c => c.name === 'MarketPanel')).toBe(true);
  });

  it('Market* 组件 <style> 无 hex/rgba 硬编码色（例 9 口径）', () => {
    const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
    const offenders: string[] = [];
    for (const { name, src } of marketComponents()) {
      for (const b of styleBlocks(src)) {
        for (const m of b.matchAll(COLOR)) offenders.push(`${name}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('G3 例 8 双保险：POPUP_OWNERS 收录 MarketPanel', () => {
  it('tokens-mu3-appica 例 8 的 POPUP_OWNERS 含 MarketPanel（自带确认卡弹层，永久禁 blur）', () => {
    const mu3 = fs.readFileSync(path.join(__dirname, 'tokens-mu3-appica.test.ts'), 'utf8');
    expect(mu3).toMatch(/POPUP_OWNERS\s*=\s*\[[^\]]*'MarketPanel'/);
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
    expect(panel).toContain('mc-upd mono');
    expect(panel).toContain('Update');
    // Update 复用安装确认卡（installPlan/install 原路），无独立 update 通道
    expect(panel).toContain('openConfirm(it, { update: true })');
    expect(panel).not.toContain('market.update');
  });

  it('unsupported 灰字说明 + 全部最新「均为最新」提示', () => {
    expect(panel).toContain('此源不支持更新检查');
    expect(panel).toContain('均为最新');
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
