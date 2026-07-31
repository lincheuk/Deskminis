/** MU2a Task 3：流式词粒度淡入切分（设计 §2.4/§8，纯模块零 DOM）。
 *  diffWords(prev, next)：prev 是 next 前缀 → 只切新增尾段；否则整体重来（流式重置兜底）。
 *  词粒度：拉丁词按空白切分（尾随空白/换行归入前词，保留换行）；CJK 连续字符按字粒度。
 *  交错节奏：单批 0.08s 窗口均分（delay_i = i * 0.08/N，递增且 <0.08s）——
 *  移植 OpenMinis TextFadeAnimator 的 staggerWindow/wordCount 思路（0.10s→0.08s 桌面适配）。 */

export interface FadeWord { word: string; delay: number }
export interface FadeDiff { stable: string; added: FadeWord[] }

/** 单批交错窗口（秒）：设计 §2.4「同批交错 ≤0.08s」。 */
export const STAGGER_WINDOW_S = 0.08;

/** CJK 字粒度类：汉字（含扩展 A/兼容）、CJK 标点、全角字符。 */
const CJK_RE = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
const WS_RE = /\s/;

/** 切词：拉丁词（非空白非 CJK 的极大段）或单个 CJK 字为单位，尾随空白/换行归入本词。 */
export function splitWords(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let tok = '';
    if (CJK_RE.test(text[i])) {
      tok = text[i]; i++;
    } else if (!WS_RE.test(text[i])) {
      while (i < text.length && !WS_RE.test(text[i]) && !CJK_RE.test(text[i])) { tok += text[i]; i++; }
    }
    // 尾随空白（含换行）归入本词；行首空白自成一词
    while (i < text.length && WS_RE.test(text[i])) { tok += text[i]; i++; }
    if (tok !== '') out.push(tok);
  }
  return out;
}

export function diffWords(prev: string, next: string): FadeDiff {
  const restart = prev === '' || !next.startsWith(prev);
  const stable = restart ? '' : prev;
  const tail = restart ? next : next.slice(prev.length);
  const words = splitWords(tail);
  const step = words.length > 0 ? STAGGER_WINDOW_S / words.length : 0;
  return { stable, added: words.map((word, i) => ({ word, delay: i * step })) };
}
