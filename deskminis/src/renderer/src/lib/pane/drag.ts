/** 右栏宽度拖拽纯逻辑（MU2b Task 1，设计 §1.2：默宽 360，320–480 可拖）。
 *  无 DOM 依赖，node 直测；组件只负责采集鼠标坐标并调用。 */

export const PANE_MIN = 320;
export const PANE_MAX = 480;

/** 钳制到 [PANE_MIN, PANE_MAX]。 */
export function clampPaneWidth(px: number): number {
  return Math.min(PANE_MAX, Math.max(PANE_MIN, px));
}

/** 拖拽中由鼠标位置求新宽：分隔条在右栏左缘，左拖（moveX 减小）增宽——dx 取反。 */
export function nextWidth(startX: number, startW: number, moveX: number): number {
  return clampPaneWidth(startW - (moveX - startX));
}
