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
    const stub = `[CONTEXT OFFLOADED: ${relativePath} (${output.length} 字符)]\n使用 file_read 工具读取 /var/minis/offloads/${toolUseId}.txt 取回完整内容`;
    return { stub, relativePath };
  }
}
