/* 部分改编自 pi-mono（https://github.com/badlogic/pi-mono）
 *   上游：packages/coding-agent/src/ 下 core/tools/edit-diff.ts:11-25,306-314、core/tools/edit.ts:190-197、utils/text.ts:2-4 @ 8676a0d
 *   许可：MIT，Copyright (c) 2025 Mario Zechner（全文见仓库根 THIRD-PARTY-NOTICES.md）
 *   本文件已修改：不再整文件归一为 LF 再整体还原，改为在归一视图里匹配、把命中区间映射回原文偏移只替换这一段；
 *   只折叠 \r\n、不动孤立 \r；加了 UTF-8 往返校验、重叠出现计入唯一性、old_string 开头 U+FEFF 的处理。 */

/**
 * file_edit 的纯函数部分（W1a-2 · 止血波设计稿 §2「工具层」；侦察 tools.md W1a-edit）。
 *
 * 为什么抽出来：原先 files.ts 里四行 readFileSync(utf8) → split 计数 → String.replace → 写回，
 * 每一步都在静默改坏用户文件——replace 会解释 new_string 里的 $$ $& $` $'；CRLF 文件配 LF 的 old_string 找不到，
 * LF 的 new_string 写进 CRLF 文件又留下混合行尾；split 不计重叠出现；空 old_string 会前插；
 * GBK / UTF-16 文件按 utf8 读再写回，不可解码的字节全成了 U+FFFD。偏移映射错一位就写坏文件，
 * 所以这里只放不碰磁盘的纯函数，用独立写法的参照实现随机对拍（tests/edit-text.test.ts）。
 *
 * 和 pi 的差别：pi 把整份正文归一为 LF、替换后再按首个行尾整体还原，混合行尾的文件会被顺手统一掉。
 * 这里只替换命中区间，区间外的字节一律不动——用户文件里其它行的行尾不该因为一次局部编辑而改变。
 */

export type EditFailure =
  | { kind: 'notUtf8' }
  | { kind: 'emptyOld' }
  | { kind: 'notFound' }
  | { kind: 'notUnique'; count: number; capped: boolean };

export type EditResult = { ok: true; text: string } | { ok: false; failure: EditFailure };

/** 不唯一时最多数到这么多处就停。重叠计数要从每个命中位置的下一位接着找，病态的周期文本
 *  （整屏同一个字符、old_string 也是一长串同一个字符）会退化成平方级扫描；报错只需要「不止一处」，数到上限就够了。 */
export const COUNT_CAP = 1000;

const BOM = '﻿';

/**
 * 严格按 UTF-8 解码：解码后再编码回去，与原字节不等就说明文件不是 UTF-8（GBK、UTF-16、截断的多字节序列……），
 * 返回 undefined。Node 的 utf8 解码遇到坏字节不抛错而是换成 U+FFFD，不做这道往返比较，
 * 写回时这些字节就被永久替换掉了。文件里本来就写着的 U+FFFD（EF BF BD）能原样往返，不会误判。
 */
export function decodeUtf8Exact(raw: Buffer): string | undefined {
  const text = raw.toString('utf8');
  return Buffer.from(text, 'utf8').equals(raw) ? text : undefined;
}

/** 剥开头的 BOM。模型不会在 old_string 里写看不见的 BOM，要在去掉 BOM 的正文上匹配，写回时再补上。 */
function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: '', body: text };
}

/** 按首个换行判定文件行尾：首个 \n 前面紧挨着 \r 就算 CRLF；没有换行按 LF。替换文本按它还原。 */
function detectEol(body: string): '\r\n' | '\n' {
  const i = body.indexOf('\n');
  return i > 0 && body[i - 1] === '\r' ? '\r\n' : '\n';
}

/** 只折叠 \r\n → \n。孤立的 \r 不当换行：它和原文一一对应，不影响偏移，归一视图里照原样参与匹配。 */
const crlfToLf = (s: string): string => s.replace(/\r\n/g, '\n');

/**
 * 在「\r\n 折成 \n」的归一视图里做一次精确替换，只动命中区间，返回完整新文本（BOM 已补回）。
 *
 * 偏移映射：归一视图里第 k 个由 \r\n 折来的 \n，位置是它在原文的下标减 k（前面每折一对少一位）。
 * 归一偏移 p 换回原文偏移 = p + 「归一位置 < p 的折叠点个数」。命中区间 [start,end) 的两端各换一次：
 * start 若正落在折来的 \n 上，换回去指向 \r；end 是开区间，末字符是折来的 \n 时整对 \r\n 都在区间里。
 * 所以区间两端永远不会把一对 \r\n 劈开。
 */
export function applyExactEdit(text: string, oldString: string, newString: string): EditResult {
  const { bom, body } = splitBom(text);
  let oldN = crlfToLf(oldString);
  let newN = crlfToLf(newString);
  // 文件有 BOM 时，file_read 会把 U+FEFF 原样交给模型，模型从文件开头抄 old_string 就会带上它。
  // 这时 old_string 开头的 U+FEFF 指的就是 BOM：剥掉再匹配；new_string 也照抄了的一并剥掉，否则写回成两个 BOM。
  // 文件没有 BOM 时不剥：那个 U+FEFF 只可能是正文里的零宽字符，按字面匹配。
  if (bom && oldN.startsWith(BOM)) {
    oldN = oldN.slice(1);
    if (newN.startsWith(BOM)) newN = newN.slice(1);
  }
  if (oldN === '') return { ok: false, failure: { kind: 'emptyOld' } };

  const norm = crlfToLf(body);
  const start = norm.indexOf(oldN);
  if (start < 0) return { ok: false, failure: { kind: 'notFound' } };
  // 从 start+1 接着找：重叠出现也算第二处（在 "aaa" 里改 "aa" 有两种读法，不能静默挑第 0 位）
  let count = 1;
  for (let i = norm.indexOf(oldN, start + 1); i >= 0 && count < COUNT_CAP; i = norm.indexOf(oldN, i + 1)) count++;
  if (count > 1) return { ok: false, failure: { kind: 'notUnique', count, capped: count >= COUNT_CAP } };

  // 折叠点：第 k 对 \r\n 在原文下标 i，归一视图里就在 i-k
  const folded: number[] = [];
  for (let i = body.indexOf('\r\n'); i >= 0; i = body.indexOf('\r\n', i + 2)) folded.push(i - folded.length);
  const toRaw = (p: number): number => {
    let k = 0;
    while (k < folded.length && folded[k] < p) k++;
    return p + k;
  };
  const rawStart = toRaw(start);
  const rawEnd = toRaw(start + oldN.length);
  // 替换文本按文件行尾还原；用 slice 拼接而不是 String.replace，new_string 里的 $ 序列逐字落盘
  const insert = detectEol(body) === '\r\n' ? newN.replace(/\n/g, '\r\n') : newN;
  return { ok: true, text: bom + body.slice(0, rawStart) + insert + body.slice(rawEnd) };
}

/** 从磁盘原字节出发：先做 UTF-8 往返校验，再交给 applyExactEdit。 */
export function editUtf8Bytes(raw: Buffer, oldString: string, newString: string): EditResult {
  const text = decodeUtf8Exact(raw);
  if (text === undefined) return { ok: false, failure: { kind: 'notUtf8' } };
  return applyExactEdit(text, oldString, newString);
}

/** 给模型看的失败文案。「未找到」「出现 N 次」沿用改动前的措辞（files-tools.test.ts 断言输出含次数）；
 *  新增的两类要指出替代做法，免得模型反复重试同一个编辑。 */
export function describeEditFailure(f: EditFailure, abs: string): string {
  switch (f.kind) {
    case 'notUtf8':
      return `该文件不是 UTF-8 编码（可能是 GBK 或 UTF-16），file_edit 会损坏它；请改用 shell_execute 或 file_write 整体重写: ${abs}`;
    case 'emptyOld':
      return 'old_string 不能为空；新建或整体覆盖请用 file_write';
    case 'notFound':
      return `old_string 未找到于 ${abs}`;
    case 'notUnique':
      return `old_string 出现 ${f.count} 次${f.capped ? '以上' : ''}，必须唯一。请提供更长的上下文。`;
  }
}
