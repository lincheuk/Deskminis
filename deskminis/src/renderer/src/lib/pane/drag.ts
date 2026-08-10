/** 分栏宽度拖拽纯逻辑。无 DOM 依赖，node 直测；组件只负责采集鼠标坐标并调用。
 *
 *  MU2b Task 1 初版：管的是**右栏**宽度（默宽 360，320–480），分隔条在右栏左缘。
 *  MU5 Task 2 换栏：布局 B 让工作台承担弹性、对话列定宽，可拖边界随之移到**对话列右缘**，
 *  语义由「右栏宽」变「对话列宽」，区间 [280,520]、默宽 336。
 *
 *  ⚠️ 换栏必须连符号一起改（计划 §5 红线 11）：边界在右栏左缘时右拖变窄，在对话列右缘时
 *  右拖变宽。只改区间数值不改符号 = 拖拽反向，而且是那种「测试全绿但一上手就反」的错。 */

export const PANE_MIN = 280;
export const PANE_MAX = 520;

/** 钳制到 [PANE_MIN, PANE_MAX]。 */
export function clampPaneWidth(px: number): number {
  return Math.min(PANE_MAX, Math.max(PANE_MIN, px));
}

/** 拖拽中由鼠标位置求新宽：分隔条在对话列右缘，右拖（moveX 增大）增宽——dx 直接相加。 */
export function nextWidth(startX: number, startW: number, moveX: number): number {
  return clampPaneWidth(startW + (moveX - startX));
}
