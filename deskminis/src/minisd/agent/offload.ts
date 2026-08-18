import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MinisPaths } from '../paths';

const THRESHOLD = 20_000;

/**
 * 大工具结果卸载（设计 §4.2「大工具结果卸载」段）。
 * >20k 字符写 offloads/<toolUseId>.txt，落库的 tool_result.output 替换为桩。
 * 决策：落库时替换（设计原文"历史替换为桩"）；toolEnd 事件广播替换前完整 output（Task 7 在 loop.ts 处理）。
 */
export class OffloadEngine {
  constructor(private paths: MinisPaths) {}

  shouldOffload(output: string): boolean {
    return output.length > THRESHOLD;
  }

  offload(sessionId: string, toolUseId: string, output: string): { stub: string; relativePath: string } {
    const dir = this.paths.sessionBucket(sessionId, 'offloads');
    mkdirSync(dir, { recursive: true });
    const fileName = `${toolUseId}.txt`;
    const abs = join(dir, fileName);
    // 原子写
    const tmp = abs + '.tmp';
    writeFileSync(tmp, output, 'utf8');
    renameSync(tmp, abs);
    const relativePath = `offloads/${fileName}`;
    // 桩带首段摘录：只有路径+字符数时模型不 file_read 就完全不知道桩里是什么，
    // 常导致盲目取回全文（浪费上下文）或该取不取。摘录是纯字符串截取，零成本、确定性。
    // Array.from 按码点截：slice 按 UTF-16 码元截会把 emoji（surrogate pair）切成半个字符，
    // 落进提示词就是乱码；换行折叠成 ⏎ 保证摘录单行——否则桩的行结构被内容打乱，指针行难定位。
    const excerpt = Array.from(output).slice(0, 200).join('').replace(/\r?\n/g, '⏎') + '…';
    const stub = `[CONTEXT OFFLOADED: ${relativePath} (${output.length} 字符)]\n开头: ${excerpt}\n使用 file_read 工具读取 /var/minis/offloads/${toolUseId}.txt 取回完整内容`;
    return { stub, relativePath };
  }
}
