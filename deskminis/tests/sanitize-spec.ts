/** URL 凭据脱敏的规格基准：W2a-7 之前 src/minisd/agent/sanitize.ts 里 sanitizeLiteral / sanitizeMultiline 的原样管线，
 *  脱敏那一步直接跑原正则。
 *
 *  为什么要有它：W2a-7 为了线性把实现改成按 '://' 扫描（credentialAt），sanitizeMultiline 与 urlCredentialAcross
 *  从此走同一个判定函数。对拍要是再拿实现当基准，就成了自己对自己，credentialAt 的偏差两边一起骗过去（W2a-7 审查意见 2）。
 *  所以 tests/sanitize.test.ts 的对拍与 tests/compact-bounded.test.ts 的 ⑬ 一律以这里为基准。
 *
 *  两条硬约束：
 *  - 这个文件不 import 任何东西，尤其不能 import 实现（tests/sanitize.test.ts 有源码守卫钉着）；
 *  - 整条管线都要照抄，不只是正则：剥哪些控制字符、在脱敏之前还是之后剥，都影响结果——
 *    夹在凭据里的 \v、U+0085 这类字符，先剥还是后剥，决定了这段凭据认不认得出来（W2a-7 审查意见 1）。
 *  改规格（正则或剥字符的先后）必须同步改实现与这里。 */

/** 原 URL_CRED：scheme=[a-zA-Z][a-zA-Z0-9+.-]*、user=[^/\s:]+、pass=[^/\s@]+，全局从左往右替换成 scheme://***:***@。 */
export const URL_CRED_SPEC = /([a-zA-Z][a-zA-Z0-9+\-.]*):\/\/[^/\s:]+:[^/\s@]+@/g;

const CC = /\p{Cc}/gu;
const CF = /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/gu;
const LS_PS = /[\u2028\u2029]/gu;
const CC_NO_NL_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** 原 sanitizeLiteral：先剥 Cc（含 \t \r \n）→ Cf → LS/PS，再脱敏。 */
export function specLiteral(s: string): string {
  return s.replace(CC, '').replace(CF, '').replace(LS_PS, '').replace(URL_CRED_SPEC, '$1://***:***@');
}

/** 原 sanitizeMultiline：\r\n?→\n，按 \n 切行；逐行剥 Cf → LS/PS → 脱敏 → 剥其余 Cc（保 \t），再拼回。 */
export function specMultiline(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(CF, '').replace(LS_PS, '').replace(URL_CRED_SPEC, '$1://***:***@').replace(CC_NO_NL_TAB, ''))
    .join('\n');
}
