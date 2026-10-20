import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalSession } from '../src/minisd/terminal';
import { ProcSupervisor } from '../src/minisd/proc/owned';

async function until(what: string, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待超时：' + what);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
// 命令回显不含错误明文，避免把「敲入的字」误当成真正执行产生的错误输出。
const decode = (text: string): string =>
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text).toString('base64')}'))`;

describe.skipIf(process.platform !== 'win32')('N16a 真实管道终端的进度与错误流', () => {

  for (const owned of [false, true]) {
    it((owned ? 'F09 托管' : '普通') + '终端：不吐 CLIXML，原生 stderr 与 PowerShell 错误仍显示', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'dm-n16a-'));
      let output = '', stdout = '', stderr = '';
      let rootClosed: Promise<void> | undefined;
      const observedSpawn = ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        if (child.stdout && child.stderr) {
          rootClosed = new Promise(resolve => { child.once('close', () => resolve()); });
        }
        child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
        return child;
      }) as typeof spawn;
      const supervisor = new ProcSupervisor();
      const terminal = new TerminalSession(cwd, data => { output += data; }, {}, {
        spawnImpl: observedSpawn,
        ...(owned ? { supervisor } : {})
      }, { kind: 'terminal', sessionId: 'N16A-SYNTHETIC' });
      try {
        // 真正惰性启动驱动，随后执行进度、原生错误和 PowerShell 错误。
        terminal.attach();
        await until('初始提示符', () => output.endsWith('> '));
        terminal.input([
          "Write-Progress -Activity 'N16A_PROGRESS' -Status 'working' -PercentComplete 25",
          `[Console]::Error.WriteLine(${decode('N16A_NATIVE_ERROR')})`,
          `Write-Error (${decode('N16A_PS_ERROR')})`,
          `[Console]::Out.WriteLine(${decode('N16A_COMMAND_OK')})`
        ].join('; ') + '\n');
        await until('命令输出与错误均到齐', () =>
          /^N16A_COMMAND_OK\r?$/m.test(stdout)
          && stderr.includes('N16A_NATIVE_ERROR')
          && output.includes('N16A_PS_ERROR')
          && output.endsWith('> '));

        // 两个原始流与真正显示的流都没有序列化噪声，错误内容没有被过滤。
        expect(stderr).not.toContain('#< CLIXML');
        expect(stdout).not.toContain('#< CLIXML');
        expect(output).not.toContain('#< CLIXML');
        expect(stderr).toContain('N16A_NATIVE_ERROR');
        expect(stdout).toContain('N16A_PS_ERROR');
        expect(output).toContain('N16A_NATIVE_ERROR');
        expect(output).toContain('N16A_PS_ERROR');
        expect(output).not.toContain('__MINIS_PROC__');
        expect(terminal.attach()).toBe(output);
        if (owned) expect(supervisor.status).toEqual({ state: 'active' });
      } finally {
        await terminal.dispose('probe-done');
        // taskkill 退出不等于根的管道已关闭；先等握着的子进程真正关闭，再清理它的工作目录。
        await rootClosed;
        expect(cwd.startsWith(join(tmpdir(), 'dm-n16a-'))).toBe(true);
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 30000);
  }
});
