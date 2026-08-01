/** 配对管理面展示格式化（MU2b Task 7，设计 §7.1）——纯函数，node 直测。 */

/** 设备指纹展示：剥非 hex 字符、前 12 位大写、两字一组空格分隔（XX XX XX XX XX XX）。
 *  minisd 侧指纹本体即 12 hex（sha256(pubkey) 前 6 字节），截断是防御性兜底。 */
export function fmtFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-fA-F]/g, '').slice(0, 12).toUpperCase();
  return (hex.match(/.{1,2}/g) ?? []).join(' ');
}

/** 8 字配对码展示：XXXX-XXXX（不足 5 字原样返回）。 */
export function fmtPairingCode(code: string): string {
  const c = code.trim();
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** 配对码输入归一化：大写化、剥非字母数字、限 8 位（输入框 @input 即时归一）。 */
export function codeInputNormalize(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}
