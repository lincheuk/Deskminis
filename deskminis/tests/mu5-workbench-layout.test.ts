/** MU5 工作台形态重构守卫（计划 §4 Task 1「先红」）。
 *
 *  依据：docs/specs/2026-08-10-ui-design-v4.md（用户 2026-08-10 拍板：布局 B / 白色默认 /
 *  Noto Sans SC / 组件设计须有真实依据）与入库拍板稿 docs/prototypes/mu5/layout-b.html。
 *
 *  本轮性质：纯 renderer。src/minisd 整目录零改动（计划 §5 红线 1）。
 *
 *  守卫手法沿用 MU2b 决策 5：读源文本，不启动浏览器；行尾一律归一化后再比对
 *  （计划 §5 红线 10——仓库 .gitattributes 强制 LF，但 Windows 检出仍可能带 CRLF）。
 *
 *  ⚠️ 手法的能力边界（MU3 §10 教训，此处重申以免误信）：源文本守卫结构上只能证明
 *  「该出现的出现了」，证明不了「出现的东西真的被渲染到、可点、好看」。目视与
 *  键盘走查仍是必需的验收步骤，不能被本文件替代。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { clampPaneWidth, nextWidth } from '../src/renderer/src/lib/pane/drag';
import { fmtElapsed } from '../src/renderer/src/lib/time/elapsed';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const app = read('src/renderer/src/App.vue');
const chatView = read('src/renderer/src/components/ChatView.vue');
const sessionList = read('src/renderer/src/components/SessionList.vue');
const tokens = read('src/renderer/src/styles/tokens.css');

describe('MU5 三区骨架：图标轨 / 对话列定宽 / 工作台伸展（3 例）', () => {
  it('flex 关系反转：对话列改定宽 336px，工作台承担弹性 flex:1', () => {
    // 反转前是「.pane-c flex:1 + .pane-r 定宽 360px」，反转后对调。
    // 这是本轮最根本的结构改动——不是改数值，是改哪一栏承担弹性（计划 §1）。
    expect(app).toMatch(/\.pane-c\s*\{[^}]*width:\s*336px/);
    expect(app).toMatch(/\.pane-w\s*\{[^}]*flex:\s*1/);
    // 旧的「右栏定宽 360」必须消失，否则等于两套布局并存
    expect(app).not.toMatch(/\.pane-r\s*\{[^}]*width:\s*360px/);
  });

  it('图标轨 52px 常驻，激活项左侧 2px 竖条（来源：AionUi 工作视图）', () => {
    expect(app).toMatch(/\.rail\s*\{[^}]*width:\s*52px/);
    expect(app).toContain('railOpen');
    // 激活项标识：2px 竖条
    expect(app).toMatch(/width:\s*2px/);
  });

  it('会话列表两态：折叠 52px 图标轨 / 展开 212px，且展开为挤压非浮层（计划决策 2-2）', () => {
    // 展开态宽度换锚：MU2b 的 232px → 布局 B 的 212px
    expect(app).toMatch(/\.pane-l\s*\{[^}]*width:\s*212px/);
    expect(app).not.toContain('width: 232px');
    // 挤压而非浮层：不得用 position:absolute/fixed 把展开态浮在对话列之上
    expect(app).not.toMatch(/\.pane-l\s*\{[^}]*position:\s*(absolute|fixed)/);
  });
});

describe('MU5 可拖边界移到对话列右缘（3 例）', () => {
  it('clampPaneWidth 区间改 [280,520]、默认 336（语义由「右栏宽」变「对话列宽」）', () => {
    expect(clampPaneWidth(0)).toBe(280);
    expect(clampPaneWidth(279)).toBe(280);
    expect(clampPaneWidth(280)).toBe(280);
    expect(clampPaneWidth(336)).toBe(336);
    expect(clampPaneWidth(519)).toBe(519);
    expect(clampPaneWidth(520)).toBe(520);
    expect(clampPaneWidth(521)).toBe(520);
    expect(clampPaneWidth(9999)).toBe(520);
  });

  it('nextWidth 拖拽方向随边界换栏取反：右拖增宽（计划 §5 红线 11）', () => {
    // 命门：边界从「右栏左缘」换到「对话列右缘」后方向相反。
    // 只改区间数值不改符号 = 拖拽反向，且若测试只锚区间不锚方向，符号错会绿着漏过。
    expect(nextWidth(1000, 336, 1040)).toBe(376); // 右拖 40px → +40
    expect(nextWidth(1000, 336, 960)).toBe(296);  // 左拖 40px → -40
    expect(nextWidth(1000, 336, 1000)).toBe(336); // 未移动
  });

  it('nextWidth 结果恒 clamp 在 [280,520]', () => {
    expect(nextWidth(1000, 336, 3000)).toBe(520);
    expect(nextWidth(1000, 520, 3000)).toBe(520);
    expect(nextWidth(1000, 336, 0)).toBe(280);
  });
});

describe('MU5 持久化键换名，防旧值被静默改判语义（1 例）', () => {
  it('localStorage 键 deskminis.rightW → deskminis.chatW，且旧键不再被读写（计划决策 2-6）', () => {
    // 命门：旧值 360 落在对话列新区间 [280,520] 内，clamp 拦不住，
    // 会被静默当成「用户设过的对话列宽」复原。换键名即绕开，不写迁移。
    expect(app).toContain("localStorage.setItem('deskminis.chatW'");
    expect(app).toContain("localStorage.getItem('deskminis.chatW')");
    // 精确到**调用形态**而非裸子串：源码注释里写明「旧键 deskminis.rightW 为何要换」
    // 是有价值的文档，不该被守卫误伤。守卫要拦的是「代码还在读写旧键」。
    expect(app).not.toMatch(/localStorage\.(get|set)Item\(\s*'deskminis\.rightW'/);
  });
});

describe('MU5 顶部任务条：把「过程」摆到常驻位（2 例）', () => {
  it('任务条容器 + 状态点 / 当前动作 / 步数 / 耗时 / 上下文水位五项锚', () => {
    // 诊断根一：右栏四标签装的全是「结果」，agent 干活的过程全程不可见。
    // 任务条是本轮对该诊断的正面回应（v4 §2）。
    expect(app).toMatch(/\.taskbar\s*\{/);
    expect(app).toContain('taskbarText');
    expect(app).toContain('上下文');
  });

  it('待批准计数徽标：从原「进度」tab 扩展到任务条与图标轨会话图标', () => {
    expect(app).toContain('pendingPerms.length');
    expect(app).toContain('待批准');
    // 图标轨上的会话图标也要能带徽标（原 .dot-warn 只挂在进度 tab 上）
    expect(app).toMatch(/\.rl-badge\s*\{/);
  });
});

describe('MU5 任务条耗时格式化 · lib/time/elapsed 纯模块（1 例）', () => {
  it('mm:ss，满一小时进位 h:mm:ss；负数与非有限值当 0', () => {
    expect(fmtElapsed(0)).toBe('0:00');
    expect(fmtElapsed(9_000)).toBe('0:09');
    expect(fmtElapsed(72_000)).toBe('1:12');
    expect(fmtElapsed(3_600_000)).toBe('1:00:00');
    expect(fmtElapsed(3_672_000)).toBe('1:01:12');
    // 时钟回拨或 startedAt 未初始化时，常驻位上不该出现「-1:-3」这种东西
    expect(fmtElapsed(-5_000)).toBe('0:00');
    expect(fmtElapsed(Number.NaN)).toBe('0:00');
    expect(fmtElapsed(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('MU5 工作台标签系统：可关闭 / 可多开 / 模式段控 / 动作行（2 例）', () => {
  it('标签改数组渲染（非固定四枚硬编码）且带关闭控件', () => {
    // 现状是四个写死的 <div class="tab">；布局 B 要求同类可多开、逐个可关。
    expect(app).toContain('v-for');
    expect(app).toMatch(/wtabs|wtab/);
    expect(app).toContain('closeTab');
    // 固定四枚的旧写法必须退场
    expect(app).not.toContain('@click="showTab(\'artifacts\')">产物');
  });

  it('模式段控（页面/源码/分屏）+ 右对齐动作行（来源：AionUi 预览区头部）', () => {
    expect(app).toMatch(/\.seg\s*\{/);
    expect(app).toContain('页面');
    expect(app).toContain('源码');
    expect(app).toContain('分屏');
    expect(app).toMatch(/\.wact\s*\{[^}]*margin-left:\s*auto/);
  });
});

describe('MU5 对话列：文档式排版 + 输入卡片形态（2 例）', () => {
  it('助手区行高提到 1.72（文档式排版，来源：AionUi 会话视图）', () => {
    // 申报：计划 Task 1 原写「ChatView 不含气泡容器类」——该断言若照写会**先绿**，
    // 因为 MU2a 早已去掉气泡（.msg-a{padding:0}，源码注释「助手消息：无气泡」）。
    // 先绿即失去先红门控的意义，故改锚在真正会变的量上：行高 1.55 → 1.72。
    expect(chatView).toMatch(/\.abody\s*\{[^}]*line-height:\s*1\.72/);
    expect(chatView).not.toMatch(/\.abody\s*\{[^}]*line-height:\s*1\.55/);
  });

  it('输入区改带阴影卡片：卡面浮起 + 输入框自身去边框 + 附件 ＋ 钮 + 圆形发送', () => {
    // 来源：AionUi 输入区——整体浮起成卡，底部只留 ＋ 与少量 chip，发送为圆钮。
    expect(chatView).toMatch(/\.composer\s*\{[^}]*box-shadow:/);
    // 输入框不再自带边框（卡片本身即边界），避免「框中框」
    expect(chatView).not.toMatch(/\.field\s*\{[^}]*border:\s*1px solid/);
    expect(chatView).toContain('attach');
    expect(chatView).toMatch(/\.send\s*\{[^}]*border-radius:\s*50%/);
  });
});

describe('MU5 侧栏：后端选择器钉底部 + 会话行形态（2 例）', () => {
  it('后端选择器钉在侧栏底部，消费既有 remote.status（来源：Agent Canvas ● Local ⌄）', () => {
    // DeskMinis 有设备与同步能力，却从来没有「当前在哪台机器跑」的常驻入口。
    // 注意：本轮只接既有的 remote.status，不新接任何 RPC（计划 §5 红线 2）。
    expect(sessionList).toContain('backend');
    expect(sessionList).toContain('本机');
    expect(sessionList).toMatch(/\.bkrow\s*\{/);
  });

  it('会话行改「状态点 + 标题 + 右对齐相对时间」，四态徽标类与日期分组保留', () => {
    // 申报：计划 Task 6 写「按状态分组 + 计数徽标」，但拍板稿第一屏的会话列是平铺的
    // 「点 + 标题 + 右对齐时间」；按状态分组 + 计数徽标是第二屏「定时任务卡」的模式（属 M9）。
    // 以拍板稿为准，日期分组保留——这同时满足计划 §3-3「展开态断言锚保持」。
    expect(sessionList).toMatch(/\.sdot\s*\{/);
    expect(sessionList).toMatch(/\.stime\s*\{[^}]*margin-left:\s*auto/);
    // §3-3：既有四态与状态色锚必须继续成立
    expect(sessionList).toContain('datehead');
    expect(sessionList).toContain('var(--state-ok)');
    expect(sessionList).toContain('var(--state-warn)');
    expect(sessionList).toContain('var(--state-err)');
  });
});

describe('MU5 字体与色彩纪律（1 例）', () => {
  it('tokens.css C 区 --font-ui 插入 Noto Sans SC（雅黑兜底保留），A 区不动', () => {
    // 本机 C:\Windows\Fonts\NotoSansSC-VF.ttf 已装（16.9MB 可变字体），零打包成本。
    expect(tokens).toMatch(/--font-ui:[^;]*"Noto Sans SC"/);
    expect(tokens).toMatch(/--font-ui:[^;]*"Microsoft YaHei"/);
    // 等宽不动（计划决策 2-5）
    expect(tokens).toMatch(/--font-mono:[^;]*Cascadia/);
  });
});
