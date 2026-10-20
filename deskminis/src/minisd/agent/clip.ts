import { urlCredentialAcross } from './sanitize';

function isHighSurrogate(c: number): boolean { return c >= 0xd800 && c <= 0xdbff; }
function isLowSurrogate(c: number): boolean { return c >= 0xdc00 && c <= 0xdfff; }

/**
 * 超长文本取头 head、尾 tail 两段的切点规则（F03 从 compact.ts 的 clip 里挪出来：摘要压平与请求侧第 3 级裁剪共用）。
 * s 必须已过 stripInvisible——凭据判定与脱敏要看到同样的字符。调用方保证 s.length > head + tail。
 *
 * 切点若落在 scheme://user:pass@ 中间，头半段没有 '@'、尾半段没有 scheme，URL 凭据脱敏两边都认不出，口令碎片就原样进了请求——
 * 而且切点固定，每次都再发一遍。所以把切点挪到整段凭据 URL 之外：头挪到段首、尾挪到段尾，整段归入「中间省略」。
 *
 * 切点按 UTF-16 码元算，落在 emoji 这类代理对中间就把它切成半个：孤立代理项进了请求体，严格的 JSON 端（Anthropic）直接 400。
 * 所以头的末位是高代理项就少取一位，尾的首位是低代理项就后挪一位。不整串 Array.from：这里是十万字级的长文本，挪切点只看两个码元。
 * 凭据段首是 ASCII 字母、段尾是 '@'，挪过的切点不会再落进代理对；两步的先后不影响结果。
 */
export function headTailCut(s: string, head: number, tail: number): { head: string; tail: string } {
  let h = head;
  let t = s.length - tail;
  h = urlCredentialAcross(s, h)?.[0] ?? h;
  t = urlCredentialAcross(s, t)?.[1] ?? t;
  if (h > 0 && isHighSurrogate(s.charCodeAt(h - 1))) h -= 1;
  if (t < s.length && isLowSurrogate(s.charCodeAt(t))) t += 1;
  return { head: s.slice(0, h), tail: s.slice(t) };
}
