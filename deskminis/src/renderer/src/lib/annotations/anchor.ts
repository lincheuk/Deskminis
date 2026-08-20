/** H2 选区锚定纯核心（设计稿 §1-1/§2）：TextQuoteSelector 在「渲染后文本」上的重锚定。
 *
 *  匹配域 = 去除**全部**空白的骨架 + 偏移映射表。
 *  为什么不是空白折叠：块级边界处 selection.toString() 有合成换行，而相邻块的
 *  textContent 之间没有任何分隔字符——折叠成单空格两边仍不相等，唯有去尽空白
 *  才能让「选区文本」与「容器文本」落进同一匹配域；中文正文本就无空格，零损失。
 *  代价（骨架上的跨词误配）由 prefix/suffix 全串消歧吸收，且 exact 本就来自真实选区。
 *
 *  resolveOffsets/absoluteOffset 刻意做成 DOM 形状无关（只看 nodeType/childNodes/data）：
 *  纯 node 环境用对象桩即可真测跨节点行为，Range 的创建留给调用方。 */

export interface QuoteSelector { exact: string; prefix?: string; suffix?: string }
export interface MatchRange { start: number; end: number }

/** 结构化最小节点形状：真 DOM 的 Text/Element 天然满足。 */
export interface WalkNode { nodeType: number; childNodes?: ArrayLike<WalkNode>; data?: string }
export interface TextPoint { node: WalkNode; offset: number }

const TEXT_NODE = 3;
const WS = /\s/;

/** 去尽空白；map[i] = 骨架第 i 字符在原文中的偏移。 */
export function skeletonWithMap(text: string): { skel: string; map: number[] } {
  let skel = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (WS.test(ch)) continue;
    skel += ch;
    map.push(i);
  }
  return { skel, map };
}

/** 在 raw 里重锚定：prefix+exact+suffix 全串优先，退 exact 首个命中；命中段映射回原始偏移。 */
export function matchQuote(raw: string, q: QuoteSelector): MatchRange | null {
  const { skel, map } = skeletonWithMap(raw);
  const e = skeletonWithMap(q.exact).skel;
  if (e === '') return null;
  const p = skeletonWithMap(q.prefix ?? '').skel;
  const s = skeletonWithMap(q.suffix ?? '').skel;
  let start = -1;
  if (p !== '' || s !== '') {
    const full = skel.indexOf(p + e + s);
    if (full >= 0) start = full + p.length;
  }
  if (start < 0) start = skel.indexOf(e);
  if (start < 0) return null;
  const end = start + e.length;
  // end 映射到「末字符的原偏移 + 1」：骨架端点间的原文空白归进命中段，高亮才连续
  return { start: map[start], end: map[end - 1] + 1 };
}

/** 深度优先枚举 root 下全部文本节点（含 root 自身为文本节点的退化形）。 */
function* textNodes(root: WalkNode): Generator<WalkNode> {
  if (root.nodeType === TEXT_NODE) { yield root; return; }
  const kids = root.childNodes ?? [];
  for (let i = 0; i < kids.length; i++) yield* textNodes(kids[i]);
}

/** 容器文本偏移 [start, end) → 两个 (文本节点, 节点内偏移) 端点；越界 → null。
 *  end 端点允许恰落在某节点末尾（Range.setEnd 语义一致）。 */
export function resolveOffsets(root: WalkNode, start: number, end: number): { start: TextPoint; end: TextPoint } | null {
  if (start < 0 || end < start) return null;
  let acc = 0;
  let sp: TextPoint | null = null;
  let ep: TextPoint | null = null;
  for (const n of textNodes(root)) {
    const len = (n.data ?? '').length;
    if (sp === null && start < acc + len) sp = { node: n, offset: start - acc };
    if (ep === null && end <= acc + len) { ep = { node: n, offset: end - acc }; break; }
    acc += len;
  }
  // start === 文本总长的空选区无意义，不解析；end 允许等于总长（落在末节点末尾，上面已收）
  return sp && ep ? { start: sp, end: ep } : null;
}

/** resolveOffsets 的逆：(节点, 节点内偏移) → 容器绝对文本偏移。
 *  端点是元素节点时（selection 的 anchorNode 可为元素 + 子下标），取前 offset 个孩子的文本总长。 */
export function absoluteOffset(root: WalkNode, node: WalkNode, offset: number): number {
  if (node.nodeType !== TEXT_NODE) {
    const kids = node.childNodes ?? [];
    let inner = 0;
    for (let i = 0; i < Math.min(offset, kids.length); i++) {
      for (const n of textNodes(kids[i])) inner += (n.data ?? '').length;
    }
    return prefixLengthBefore(root, node) + inner;
  }
  return prefixLengthBefore(root, node) + offset;
}

/** root 文本序里 target 节点之前的文本总长（遇 target 即停，target 可为文本节点或元素）。
 *  target 不在 root 内时返回全文长——调用方（选区端点已验证在 root 内）不会走到。 */
function prefixLengthBefore(root: WalkNode, target: WalkNode): number {
  let acc = 0;
  const walk = (n: WalkNode): boolean => {
    if (n === target) return true;
    if (n.nodeType === TEXT_NODE) { acc += (n.data ?? '').length; return false; }
    const kids = n.childNodes ?? [];
    for (let i = 0; i < kids.length; i++) if (walk(kids[i])) return true;
    return false;
  };
  walk(root);
  return acc;
}
