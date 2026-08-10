/** 分栏宽度拖拽纯逻辑。无 DOM 依赖，node 直测；组件只负责采集鼠标坐标并调用。
 *
 *  MU2b Task 1 初版：管的是**右栏**宽度（默宽 360，320–480），分隔条在右栏左缘。
 *  MU5 Task 2 换栏：布局 B 让工作台承担弹性、对话列定宽，可拖边界随之移到**对话列右缘**，
 *  语义由「右栏宽」变「对话列宽」，区间 [280,520]、默宽 336。
 *
 *  ⚠️ 换栏必须连符号一起改（计划 §5 红线 11）：边界在右栏左缘时右拖变窄，在对话列右缘时
 *  右拖变宽。只改区间数值不改符号 = 拖拽反向，而且是那种「测试全绿但一上手就反」的错。
 *
 *  MU5 多尺寸走查追加：**上限不能写死**。窗口 minWidth=900，侧栏展开占 212 时可用宽只有 688，
 *  而固定上限 520 会让工作台只剩 168px——标签条要横向滚动、内容挤成条状。
 *  布局本身不算错乱（无重叠、无页面横向滚动、三区之和恒等于视口），但工作台被饿死了。
 *  故上限改为随可用宽收缩，保证工作台不低于 WORKBENCH_MIN。 */

export const PANE_MIN = 280;
/** 绝对上限，仅用于**不传可用宽**的旧签名（保持 MU2b 起的既有契约不变）。
 *  传了可用宽就走 maxChatWidth 的比例规则，不再参与。 */
export const PANE_MAX = 520;

/** 工作台的最小可用宽。低于此值标签条放不下、内容挤成条状，等于把主区饿死。
 *
 *  360 是**在运行态量出来的**，不是拍的。第一次按「标签宽合计 + 内边距」估成 329 仍然溢出，
 *  漏的是标签之间的 gap。真实构成：六枚内置标签合计 311 + 5 个 3px 间隙 15 + 左右内边距 20 = 346，
 *  取 360 留 14px 余量（兼容字体渲染差异，以及标签被收起时多出来的「＋N」恢复钮）。
 *  取到这个值，六枚内置标签在任何允许的窗口尺寸下都不必横向滚动才够得到。
 *  （动态开出的文件标签超出后照常横滚——那是多开本身的代价，可以接受。） */
export const WORKBENCH_MIN = 360;

/** 对话列最多占可用宽的比例。
 *
 *  为什么不用绝对像素：`PANE_MAX` 520 在 1280 屏上是 40%（合理），到 2560 屏只剩 20.3%——
 *  用户全屏时想把对话列拉宽根本拉不动，这正是「模块比例无法调整」的真身。
 *  换成比例后，同一条规则在任何尺寸下都给出「最多一半」，大屏自然放开。 */
export const CHAT_MAX_RATIO = 0.5;

/** 给定可用宽（视口宽 − 左区宽），求对话列的有效上限。
 *  两条约束取更紧的那条：① 不超过可用宽的一半；② 不让工作台跌破 WORKBENCH_MIN。
 *  可用宽极小时退回 PANE_MIN，防止区间反转。 */
export function maxChatWidth(available: number): number {
  const byRatio = Math.floor(available * CHAT_MAX_RATIO);
  const byFloor = available - WORKBENCH_MIN;
  return Math.max(PANE_MIN, Math.min(byRatio, byFloor));
}

/** 钳制到 [PANE_MIN, 有效上限]。
 *  `available` 省略时按固定 PANE_MAX 封顶——保留旧签名，既有调用点与测试一字不用改。 */
export function clampPaneWidth(px: number, available?: number): number {
  const hi = available === undefined ? PANE_MAX : maxChatWidth(available);
  return Math.min(hi, Math.max(PANE_MIN, px));
}

/** 拖拽中由鼠标位置求新宽：分隔条在对话列右缘，右拖（moveX 增大）增宽——dx 直接相加。 */
export function nextWidth(startX: number, startW: number, moveX: number, available?: number): number {
  return clampPaneWidth(startW + (moveX - startX), available);
}
