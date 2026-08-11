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
import { clampPaneWidth, nextWidth, maxChatWidth, WORKBENCH_MIN, CHAT_MAX_RATIO } from '../src/renderer/src/lib/pane/drag';
import { fmtElapsed } from '../src/renderer/src/lib/time/elapsed';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const app = read('src/renderer/src/App.vue');
const chatView = read('src/renderer/src/components/ChatView.vue');
const sessionList = read('src/renderer/src/components/SessionList.vue');
const tokens = read('src/renderer/src/styles/tokens.css');
const titleBar = read('src/renderer/src/components/TitleBar.vue');
const PANE_MIN_FOR_TEST = 280;

describe('MU5 三区骨架：图标轨 / 对话列定宽 / 工作台伸展（3 例）', () => {
  it('flex 关系反转：对话列改定宽 336px，工作台承担弹性 flex:1', () => {
    // 反转前是「.pane-c flex:1 + .pane-r 定宽 360px」，反转后对调。
    // 这是本轮最根本的结构改动——不是改数值，是改哪一栏承担弹性（计划 §1）。
    // 外壳类名刻意不叫 .pane-c —— ChatView 根正是 .pane-c，Vue 子组件根会带上父 scope id，
    // 同名会让 App.vue 的 width:336px 泄漏进 ChatView 把它钉死（真机截图逮到）。
    expect(app).toMatch(/\.pane-chat\s*\{[^}]*width:\s*336px/);
    expect(app).not.toMatch(/\.pane-c\s*\{[^}]*width:\s*336px/);
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

describe('MU5 对话列不得把工作台饿死（真机多尺寸走查发现，3 例）', () => {
  it('maxChatWidth：上限随可用宽收缩，保证工作台不低于 WORKBENCH_MIN', () => {
    // 缺陷现场：窗口 minWidth=900，侧栏展开 212 时可用宽 688，
    // 而上限写死 520 → 工作台只剩 168px，标签条要横滚、内容挤成条状。
    // 布局不算「错乱」（无重叠、无页面横向滚动、三区之和恒等于视口），但不可用。
    expect(WORKBENCH_MIN).toBeGreaterThanOrEqual(320);
    expect(maxChatWidth(2508)).toBe(1254);       // 2560 屏：可拖到一半，不再被 520 锁死在 20%
    expect(maxChatWidth(848)).toBe(424);         // 900 宽 + 图标轨 52 → 比例规则给 424（两边对半）
    expect(maxChatWidth(688)).toBe(688 - WORKBENCH_MIN); // 900 宽 + 侧栏 212 → 328（此处工作台下限比比例更紧）
    // 可用宽极小时不得让区间反转（上限跌破下限）
    expect(maxChatWidth(300)).toBe(280);
    expect(maxChatWidth(0)).toBe(280);
  });

  it('clampPaneWidth 带可用宽时按收缩后的上限钳制；不带时维持原契约', () => {
    expect(clampPaneWidth(520, 688)).toBe(328);
    expect(clampPaneWidth(999, 688)).toBe(328);
    expect(clampPaneWidth(300, 688)).toBe(300);
    expect(clampPaneWidth(100, 688)).toBe(280);
    // 不传可用宽 = 老签名，行为一字不变（既有调用点与测试不受影响）
    expect(clampPaneWidth(999)).toBe(520);
    expect(clampPaneWidth(0)).toBe(280);
  });

  it('nextWidth 透传可用宽：窄窗口里右拖到底也停在收缩后的上限', () => {
    expect(nextWidth(1000, 336, 9999, 688)).toBe(328);
    expect(nextWidth(1000, 336, 9999)).toBe(520); // 不传则同旧
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

describe('MU5 全屏下比例可调 + 分区可隐藏（用户 2026-08-10 追加，3 例）', () => {
  it('对话列上限按**比例**而非绝对像素——大屏不再被 520 锁死', () => {
    // 缺陷现场：520 在 1280 屏上是 40%（合理），到 2560 屏只剩 20.3%，
    // 用户在全屏下想把对话列拉宽根本拉不动——「模块比例无法调整」的真身。
    expect(CHAT_MAX_RATIO).toBe(0.5);
    // 同一条规则在各尺寸下都给出「不超过一半」且「工作台不饿死」
    for (const av of [688, 848, 1228, 2508, 3800]) {
      const hi = maxChatWidth(av);
      expect(hi).toBeLessThanOrEqual(Math.floor(av * CHAT_MAX_RATIO));
      if (av - WORKBENCH_MIN >= PANE_MIN_FOR_TEST) expect(av - hi).toBeGreaterThanOrEqual(WORKBENCH_MIN);
    }
    // 大屏确实放开了：2560 - 52 = 2508 可用 → 上限 1254，而不是 520
    expect(maxChatWidth(2508)).toBeGreaterThan(520);
  });

  it('对话列可隐藏，且对话列与工作台不得同时隐藏（至少留一个主区）', () => {
    expect(app).toContain('chatOpen');
    expect(app).toContain('toggleChat');
    expect(app).toContain('toggleWorkbench');
    // 守卫「不能全隐」的那句判断必须在，否则会出现三区皆空的白屏
    expect(app).toMatch(/chatOpen\.value\s*&&\s*!workbenchOpen\.value/);
    expect(app).toMatch(/workbenchOpen\.value\s*&&\s*!chatOpen\.value/);
    expect(app).toContain('v-show="chatOpen"');
  });

  it('三个分区开关提到标题栏可见处，且都是原生 button（不再只藏在「视图」菜单里）', () => {
    // 现状：标题栏只有一个「切换侧栏」图标，工作台开关藏在视图菜单，对话列根本不能隐藏。
    expect(titleBar).toContain("emit('toggle-sidebar')"); // 既有锚保持
    expect(titleBar).toContain("emit('toggle-chat')");
    expect(titleBar).toContain("emit('toggle-right')");
    expect(titleBar).toMatch(/<button[^>]*class="tb-seg"/);
    expect(titleBar).toMatch(/\.tb-seg:focus-visible/);
  });
});

describe('MU5 列宽放开后正文仍须可读（1 例）', () => {
  it('正文与输入卡按可读宽封顶并居中；输入卡必须写 width 而非只写 max-width', () => {
    // 列宽是布局问题，行长是排版问题。对话列现在可拖到可用宽的一半（2560 屏上 1254px），
    // 若正文跟着拉长，实测每行约 157 字符——远超 45–90 的可读区间。
    // 锚**意图**不锚写法（红线 9 / MU5 §15 / MU6 同类第三次）：可读宽是**对话列的统一契约**，
    // 初版只写在 .turn 上，结果空态与事件条不受约束——大屏 + 折叠工作台时空态整块横跨 1877px、
    // 与 792 居中的输入卡差 59px（用户实测报「比例不对」）。现提升为 .stream 全部直接子元素。
    expect(chatView).toMatch(/\.stream > \*\s*\{[^}]*max-width:\s*792px/);
    expect(chatView).toMatch(/\.stream > \*\s*\{[^}]*margin-inline:\s*auto/);
    // 输入卡是**列向 flex 容器里的 flex item**，auto 外边距会关掉 cross 轴 stretch，
    // 只写 max-width 的话它会退回按内容收缩（实测宽列里只剩 339px）。必须写 width。
    expect(chatView).toMatch(/\.composer\s*\{[^}]*width:\s*min\(792px/);
    // 滚动条对称预留：否则正文在「减掉滚动条」的宽里居中、输入卡在完整宽里居中，左缘差 8px
    expect(chatView).toMatch(/scrollbar-gutter:\s*stable both-edges/);
  });
});

describe('MU5 工作台补齐「折叠为图标条」中间态（用户 2026-08-10 追加，2 例）', () => {
  it('工作台三态与侧栏对齐：完整 / 40px 图标条 / 完全隐藏', () => {
    // 缺口现场：侧栏有三态（隐藏 / 52px 图标轨 / 212px 展开），工作台只有两态。
    // 一旦隐藏，开了哪些文件标签、进度上有没有待批准橙点，全都看不见了——
    // 而侧栏折叠成图标轨时这些信息都还在。补齐中间那一档。
    expect(app).toContain('workbenchExpanded');
    expect(app).toContain('collapseWorkbench');
    expect(app).toContain('expandWorkbenchTo');
    expect(app).toMatch(/\.wbrail\s*\{[^}]*width:\s*40px/);
    // 折叠条上仍要能看见待批准徽标——这正是「折叠但不失明」的意义
    expect(app).toMatch(/\.wbr-badge\s*\{/);
  });

  it('折叠态下对话列不再被定宽约束；收起对话列时工作台强制回完整态', () => {
    // 折叠条固定 40px，对话列该自然铺满剩余空间，不该再挂 chatW 的内联定宽。
    expect(app).toContain('workbenchOpen && workbenchExpanded');
    // 否则会出现「对话列没了 + 工作台只剩 40px 窄条」的空壳
    expect(app).toMatch(/if \(chatOpen\.value\) workbenchExpanded\.value = true;/);
  });
});

describe('MU5 窗口尺寸变化时重新钳制对话列（1 例）', () => {
  it('App.vue 监听 resize 并按可用宽重钳；侧栏展开也触发重钳', () => {
    // 缺陷现场：大屏拖到 520 后把窗口缩到 900、或展开侧栏（多吃 160px），
    // 都没有任何重钳逻辑，chatW 一直停在 520 → 工作台被饿死。
    expect(app).toContain("addEventListener('resize'");
    expect(app).toContain("removeEventListener('resize'");
    expect(app).toContain('availableW');
    // 重钳必须由「可用宽」驱动，而不是只在 resize 里写死一次——展开侧栏也要生效
    expect(app).toMatch(/watch\(\s*availableW/);
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
    // 真机截图逮到的缺陷回归锚：对话列收成 336 定宽后，底部 chip 排挤不下会逐字换行。
    // **这条守卫自己出过错**：原本断言 .ctools 必须 overflow:hidden，锚的是当时的实现而非意图，
    // 结果把「容器裁剪」这个错误做法锁死了——它会把 chip 的下拉菜单整个裁掉（点了没反应）。
    // 正确的意图是「chip 不换行」而非「容器裁剪」，故改锚子元素的 nowrap + 省略号，
    // 并反过来禁止容器裁剪，免得弹出层被闷死。
    expect(chatView).toMatch(/\.cpill[^{]*\{[^}]*white-space:\s*nowrap/);
    expect(chatView).toMatch(/\.cpill[^{]*\{[^}]*text-overflow:\s*ellipsis/);
    expect(chatView).not.toMatch(/\.ctools\s*\{[^}]*overflow:\s*hidden/);
    // 两枚 picker 的弹层原本 min-width 240（权限档实测 300）、以 chip 为锚向右展开，
    // 对话列收成 280 后会捅出右缘并被 ChatView 根的 overflow:hidden 裁掉——「点了没反应」。
    // 改以 .ctools 为定位参照、左右对齐铺满，宽度随列宽自适应。
    expect(chatView).toMatch(/\.ctools\s*\{[^}]*position:\s*relative/);
    expect(chatView).toMatch(/\.ctools :deep\(\.wrap\)\s*\{[^}]*position:\s*static/);
    expect(chatView).toMatch(/\.ctools :deep\(\.menu\)\s*\{[^}]*left:\s*0;\s*right:\s*0/);
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
