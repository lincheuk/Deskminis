/** 工具行成组（设计 v2 §2.2）：连续 ≥3 个同 name 卡片折叠成一组，组边界被异名打断；
 *  不足 3 个不成组。纯函数，不改动入参数组与元素（items 保序保引用）。 */
export interface ToolGroup<T = unknown> {
  kind: 'group';
  name: string;
  count: number;
  items: T[];
}

export function isGroup<T extends { name: string }>(x: T | ToolGroup<T>): x is ToolGroup<T> {
  return (x as ToolGroup<T>).kind === 'group';
}

export function groupToolCards<T extends { name: string }>(cards: readonly T[]): (T | ToolGroup<T>)[] {
  const out: (T | ToolGroup<T>)[] = [];
  let i = 0;
  while (i < cards.length) {
    let j = i + 1;
    while (j < cards.length && cards[j].name === cards[i].name) j++;
    if (j - i >= 3) {
      const items = cards.slice(i, j);
      out.push({ kind: 'group', name: cards[i].name, count: items.length, items });
    } else {
      for (let k = i; k < j; k++) out.push(cards[k]);
    }
    i = j;
  }
  return out;
}
