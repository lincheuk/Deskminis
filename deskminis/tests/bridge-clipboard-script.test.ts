/**
 * C2 · 剪贴板脚本源码守卫
 *
 * SET/GET 两段脚本已从 WinForms OLE 路径换成原生 Win32 API + 自带 30×100ms 重试窗口：
 * OLE（[System.Windows.Forms.Clipboard]）内部仅 10×100ms 重试，装有剪贴板监听软件的机器
 * （本机实测：网易UU远程与夸克浏览器会在剪贴板变更后抢开剪贴板）上持续失败于
 * CLIPBRD_E_CANT_OPEN。本测试把「原生路径 + 自控重试 + 内存所有权注释锚点」固化为红线，
 * 防止后人改回 OLE 路径或破坏所有权规则（成功后 GlobalFree 会直接破坏剪贴板数据）。
 * 读 handlers.ts 源码文本断言，与 renderer-* 源码守卫先例一致。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../src/minisd/bridge/handlers.ts'), 'utf8').replace(/\r\n/g, '\n');

/** 提取模板字面量正文（反引号之间），把断言范围限定在脚本本体，避免误伤文件其他位置的注释。 */
function scriptBody(name: string): string {
  const marker = `const ${name} = \``;
  const start = src.indexOf(marker);
  expect(start, `handlers.ts 应存在 ${name}`).toBeGreaterThan(-1);
  const end = src.indexOf('`;', start + marker.length);
  expect(end).toBeGreaterThan(start);
  return src.slice(start + marker.length, end);
}

describe('C2 — 剪贴板脚本原生 Win32 路径守卫', () => {
  it('SET：走 OpenClipboard 重试 + SetClipboardData，不再走 WinForms SetText', () => {
    const set = scriptBody('CLIPBOARD_SET_SCRIPT');
    expect(set).toContain('OpenClipboard');
    expect(set).toContain('SetClipboardData(13'); // 13 = CF_UNICODETEXT
    expect(set).toContain('EmptyClipboard');
    expect(set).toContain('GlobalAlloc(0x0042'); // GMEM_MOVEABLE|GMEM_ZEROINIT（GHND）
    expect(set).toContain('for ($i = 0; $i -lt 30; $i++)'); // 30×100ms 自控重试窗口
    expect(set).toContain('Start-Sleep -Milliseconds 100');
    expect(set).toContain('GetLastWin32Error'); // 重试耗尽的 stderr 必须带 Win32 错误码
    expect(set).toContain('finally'); // 无论成败 CloseClipboard 必须执行
    expect(set).not.toContain('Clipboard]::SetText');
  });

  it('GET：走 OpenClipboard 重试 + GetClipboardData，不再走 WinForms GetText', () => {
    const get = scriptBody('CLIPBOARD_GET_SCRIPT');
    expect(get).toContain('OpenClipboard');
    expect(get).toContain('IsClipboardFormatAvailable(13)');
    expect(get).toContain('GetClipboardData(13');
    expect(get).toContain('PtrToStringUni');
    expect(get).toContain('GlobalUnlock');
    expect(get).toContain('for ($i = 0; $i -lt 30; $i++)'); // 与 SET 同款 30×100ms 重试
    expect(get).toContain('finally');
    // 空/无 CF_UNICODETEXT → 输出空串、exit 0（与 WinForms GetText 空语义一致，桥协议不变）
    expect(get).toContain('exit 1'); // 仅重试耗尽才失败
    expect(get).not.toContain('Clipboard]::GetText');
  });

  it('SET：含「成功后不得 GlobalFree」注释锚点（防后人改坏内存所有权）', () => {
    const set = scriptBody('CLIPBOARD_SET_SCRIPT');
    expect(set).toContain('成功后不得 GlobalFree');
  });
});
