/**
 * F09：Windows 命令行的拼接。
 *
 * MCP 的 launcher（proc/own-script.ts）用 CreateProcessW 自己起目标，命令行要由引擎先拼好交给它；
 * 拼出来的必须与 Node 对同一组参数（非 verbatim）生成的逐字相同，目标看到的 argv 才与直起时一样。
 * 规则按微软文档里 C 运行时解析 argv 的约定独立实现，正确性由真实进程的差分用例钉住（tests/proc-own-windows.test.ts）。
 */
import { system32 } from './win-exec';

/**
 * win32 且裸名（无路径分隔符）→ 经 <System32>\cmd.exe /d /s /c 包裹；否则原样。
 * 从 mcp/stdio.ts 的 spawnMcpProcess 里搬出的那一句判断（为什么包裹见那边的注释），spawnMcpProcess 改为调它，行为不变。
 */
export function directCommand(command: string, args: readonly string[], platform: string, sysEnv: NodeJS.ProcessEnv): { file: string; args: string[] } {
  const bare = !command.includes('\\') && !command.includes('/');
  return platform === 'win32' && bare
    ? { file: system32('cmd.exe', sysEnv), args: ['/d', '/s', '/c', command, ...args] }
    : { file: command, args: [...args] };
}

/** 一个参数的引号规则：
 *  - 空串 → ""；
 *  - 不含空格、制表符、引号 → 原样；
 *  - 含空格或制表符，但不含引号与反斜杠 → 两头加引号；
 *  - 其余 → 引号前的反斜杠加倍并给引号加反斜杠，结尾的反斜杠加倍（后面紧跟收尾的引号），两头加引号。 */
function quoteArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { slashes++; continue; }
    if (ch === '"') out += '\\'.repeat(slashes * 2 + 1) + '"';
    else out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

/** 按 Windows 的 argv 规则把 file + args 拼成一条命令行，与 Node 对同一组参数（非 verbatim）生成的命令行逐字相同。 */
export function winCommandLine(file: string, args: readonly string[]): string {
  return [file, ...args].map(quoteArg).join(' ');
}
