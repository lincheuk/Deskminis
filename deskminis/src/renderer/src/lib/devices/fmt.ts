/** 配对管理面展示格式化（MU2b Task 7，设计 §7.1）——纯函数，node 直测。 */

/** 设备指纹展示：剥非 hex 字符、前 12 位大写、两字一组空格分隔（XX XX XX XX XX XX）。
 *  minisd 侧指纹本体即 12 hex（sha256(pubkey) 前 6 字节），截断是防御性兜底。 */
export function fmtFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-fA-F]/g, '').slice(0, 12).toUpperCase();
  return (hex.match(/.{1,2}/g) ?? []).join(' ');
}

/** 配对码展示：每 4 个字符一组用 - 连接。8 位旧码是 XXXX-XXXX，12 位认证配对码（F11C）是 0XXX-XXXX-XXXX；
 *  不超过 4 个字符原样返回。 */
export function fmtPairingCode(code: string): string {
  const c = code.trim();
  return c.length > 4 ? (c.match(/.{1,4}/g) ?? []).join('-') : c;
}

/** 配对码输入归一化：大写化、剥非字母数字、限 12 位（输入框 @input 即时归一）。
 *  F11C：上限从 8 改成 12（认证配对码 12 位）。这里只管输入框里的即时整理，不判断码的种类——
 *  种类由引擎的 classifyPairingCode 判断，格式不对的码在本机就被拒，不发任何网络请求。 */
export function codeInputNormalize(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}
