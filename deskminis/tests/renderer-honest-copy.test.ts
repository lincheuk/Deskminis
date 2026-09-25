/** W2b-11a：界面同类假话（侦察 release.md「W2b-readme」风险条、cross.md missing 第 5 条）。每处先按代码核实，再钉住改写后的说法。
 *
 *  - 终端：TerminalPane 说「与 agent 共用同一个长驻 shell（cd 与环境变量互通）」。实情是两套实例——
 *    minisd/index.ts 的 TerminalManager（终端面板）与 ShellManager（agent 的 shell_execute）各起各的 PowerShell，
 *    terminal.ts 自己的注释也写着「与工具 shell 独立实例」；终端只是同样起在本会话的工作区目录。
 *  - 设备：StageDevices 说「会话与设置在两边同步」「会话与记忆……自动同步」。实情按 sync/wire.ts 与 chat-store 的
 *    mergeRemoteSession：同步的是会话（消息、压缩摘要，以及标题、记忆开关、模型绑定、置顶这几项会话属性），
 *    设置（模型与密钥、MCP、技能、助手、定时、权限档位）一样都不同步，记忆文件与附件文件也不传；
 *    minisd 缺省只听 127.0.0.1（index.ts 的 listenHost），跨机器要先设 MINISD_HOST。
 *  定时任务那一处（「它不是后台服务」）钉在 renderer-cron.test.ts 的同一条运行边界断言里。
 *
 *  模板、脚本都先剥注释再匹配（sfcBlocks）：旧说法写进注释里当「订正记录」不算回退，但也不能喂饱新断言。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sfcBlocks } from './sfc-blocks';

const ui = (f: string) => sfcBlocks(readFileSync(join(__dirname, '../src/renderer/src/ui', f), 'utf8').replace(/\r\n/g, '\n'), f);

describe('终端面板：不说与 agent 共用 shell', () => {
  const t = ui('TerminalPane.vue');

  it('标题行与连接提示都不再说「共用」「互通」', () => {
    for (const code of [t.template, t.script]) {
      expect(code).not.toMatch(/共用/);
      expect(code).not.toMatch(/互通/);
    }
  });

  it('标题行说清：独立的 PowerShell，cd 与环境变量不与 agent 的 shell 相通', () => {
    const head = /<header class="thead">([\s\S]*?)<\/header>/.exec(t.template)?.[1] ?? '';
    expect(head, '找不到终端标题行').not.toBe('');
    expect(head).toMatch(/独立的 PowerShell/);
    expect(head).toMatch(/不与 agent/);
  });

  it('空滚动缓冲时的灰色提示行同样说清是独立的一个', () => {
    const hint = /term\.writeln\('\\x1b\[90m\[终端已连接[^']*'\)/.exec(t.script)?.[0] ?? '';
    expect(hint, '找不到连接提示行').not.toBe('');
    expect(hint).toMatch(/独立的 PowerShell/);
    expect(hint).toMatch(/不与 agent/);
  });
});

describe('设备页：同步什么、不同步什么、跨机器要什么，照实说', () => {
  const d = ui('StageDevices.vue');

  it('页头不再说「会话与设置在两边同步」', () => {
    expect(d.template).not.toMatch(/会话与设置/);
  });

  it('页头写明设置、记忆文件不同步，跨机器要设 MINISD_HOST', () => {
    const head = /<header class="head">([\s\S]*?)<\/header>/.exec(d.template)?.[1] ?? '';
    expect(head, '找不到设备页页头').not.toBe('');
    expect(head).toMatch(/设置、记忆文件[^。]*不同步/);
    expect(head).toMatch(/MINISD_HOST/);
  });

  it('同步开关的状态句不再说「会话与记忆」在同步（记忆文件不在线格式里，只带每个会话的记忆开关）', () => {
    expect(d.template).not.toMatch(/会话与记忆/);
    expect(d.template).toMatch(/已暂停：不再与其它设备收发会话/);
    expect(d.template).toMatch(/进行中：会话在已配对设备之间自动同步/);
  });
});
