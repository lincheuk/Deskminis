/** 注释层浮条（.abar）与气泡（.apop）的落点，纯函数（W2b-2 审查补修）。
 *
 *  浮条与气泡是 position:absolute，挂在注释层自己的根 .anno 里（.anno 以 inset:0 铺满会话视图 .stage），
 *  所以 left/top 的原点是 .anno 的左上角——原点必须量 layer（.anno 的矩形）。选区与点击都发生在滚动区里，
 *  滚动区（host）只拿来夹紧：浮条、气泡不出它的左右边，气泡底下给它留 40。
 *  改前原点量的是 host：.anno 与滚动区顶边重合时看不出差别；W2b-2 在滚动区之上加了「另有 N 个会话在等你批准」一行以后，
 *  两者差出 48px，浮条落到选区上方两三行、气泡盖住刚点的那处高亮。
 *  没有提示行时 layer 与 host 重合，两个函数与改前的原式逐点相同。 */

/** 最小矩形形状：DOMRect 天然满足，测试里写字面量即可。 */
export interface Box { left: number; top: number; width: number; height: number }
export interface Spot { x: number; y: number }

/** 浮条半宽约 74：浮条 translate(-50%) 锚中点，中点离边至少半宽，整条才不捅出滚动区 */
const BAR_HALF = 74;
/** 浮条底边与选区顶边之间的空隙 */
const BAR_GAP = 8;
/** 气泡半宽约 130（260px 宽的卡），道理同浮条 */
const POP_HALF = 130;
/** 气泡顶边在点击点下方多少 */
const POP_GAP = 10;
/** 气泡顶边至少比滚动区底边高这么多，点在最底下一行也不至于整张卡掉出视野 */
const POP_FLOOR = 40;

/** 浮条的落点，坐标相对 layer：x 是浮条中点、y 是浮条底边（浮条自身 translate(-50%, -100%)）。 */
export function placeBar(layer: Box, host: Box, sel: Box): Spot {
  const hx = host.left - layer.left;
  const hy = host.top - layer.top;
  return {
    x: Math.min(Math.max(sel.left + sel.width / 2 - layer.left, hx + BAR_HALF), hx + host.width - BAR_HALF),
    y: Math.max(sel.top - layer.top - BAR_GAP, hy + BAR_GAP),
  };
}

/** 气泡的落点，坐标相对 layer：x 是气泡中点（气泡自身 translateX(-50%)）、y 是气泡顶边。cx、cy 是点击点的视口坐标。 */
export function placePop(layer: Box, host: Box, cx: number, cy: number): Spot {
  const hx = host.left - layer.left;
  const hy = host.top - layer.top;
  return {
    x: Math.min(Math.max(cx - layer.left, hx + POP_HALF), hx + host.width - POP_HALF),
    y: Math.min(cy - layer.top + POP_GAP, hy + host.height - POP_FLOOR),
  };
}
