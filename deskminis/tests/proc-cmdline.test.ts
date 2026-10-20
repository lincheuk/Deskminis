/**
 * F09 C 组：Windows 命令行拼接（proc/win-cmdline.ts）。
 * 这里钉的是规则本身；「与 Node 对同一组参数生成的命令行逐字相同」由真实进程的差分用例钉（proc-own-windows.test.ts 的 P2：
 * 同一组参数分别直起与经 launcher 启动，目标看到的 argv 逐个相等）。
 */
import { describe, it, expect } from 'vitest';
import { directCommand, winCommandLine } from '../src/minisd/proc/win-cmdline';

describe('winCommandLine', () => {
  const one = (arg: string): string => winCommandLine('x', [arg]).slice(2);

  it('空串 → 一对引号；不含空格、制表符、引号 → 原样', () => {
    expect(one('')).toBe('""');
    expect(one('plain')).toBe('plain');
    expect(one('C:\\dir\\file.exe')).toBe('C:\\dir\\file.exe');
    expect(one('back\\slash\\')).toBe('back\\slash\\');
    expect(one('中文')).toBe('中文');
    expect(one('--k=v')).toBe('--k=v');
  });

  it('含空格或制表符、不含引号与反斜杠 → 两头加引号', () => {
    expect(one('a b')).toBe('"a b"');
    expect(one('tab\there')).toBe('"tab\there"');
    expect(one('中 文')).toBe('"中 文"');
  });

  it('其余：引号前的反斜杠加倍并给引号加反斜杠，结尾的反斜杠加倍，两头加引号', () => {
    expect(one('q"uo"te')).toBe('"q\\"uo\\"te"');
    expect(one('x\\"y')).toBe('"x\\\\\\"y"');           // x\"y → "x\\\"y"
    expect(one('C:\\Program Files\\a.exe')).toBe('"C:\\Program Files\\a.exe"'); // 中间的反斜杠不动
    expect(one('dir with space\\')).toBe('"dir with space\\\\"');               // 结尾的反斜杠加倍（后面紧跟收尾的引号）
    expect(one('a b\\\\')).toBe('"a b\\\\\\\\"');
    expect(one('"C:\\already quoted\\x.exe"')).toBe('"\\"C:\\already quoted\\x.exe\\""');
    expect(one('"')).toBe('"\\""');
  });

  it('file 与各参数按同一规则，以单个空格相连', () => {
    expect(winCommandLine('C:\\Program Files\\node.exe', ['server.js', 'a b', '', 'x'])).toBe('"C:\\Program Files\\node.exe" server.js "a b" "" x');
    expect(winCommandLine('cmd.exe', [])).toBe('cmd.exe');
  });
});

describe('directCommand', () => {
  const env = { SystemRoot: 'D:\\WinNT' };

  it('win32 且裸名 → 经 <System32>\\cmd.exe /d /s /c 包裹（cmd.exe 的位置取自 sysEnv）', () => {
    expect(directCommand('npx', ['-y', 'pkg'], 'win32', env)).toEqual({ file: 'D:\\WinNT\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'npx', '-y', 'pkg'] });
  });

  it('带路径（反斜杠或正斜杠）或非 win32 → 原样；返回的 args 是副本', () => {
    const args = ['a'];
    const r = directCommand('C:\\tools\\srv.exe', args, 'win32', env);
    expect(r).toEqual({ file: 'C:\\tools\\srv.exe', args: ['a'] });
    expect(r.args).not.toBe(args);
    expect(directCommand('./bin/srv', ['a'], 'win32', env).file).toBe('./bin/srv');
    expect(directCommand('npx', ['a'], 'linux', env)).toEqual({ file: 'npx', args: ['a'] });
  });
});
