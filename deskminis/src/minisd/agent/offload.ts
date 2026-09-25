import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { MinisPaths } from '../paths';
import type { ReadRange } from '../tools/types';

const THRESHOLD = 20_000;

/**
 * 读回卸载文件时落库的上限（W2a-5 · 设计稿 §2「卸载读回上限 50000 字符」）。
 * 约为卸载阈值的 2.5 倍：常见的 100KB 以内 shell 输出两次读完；再大就让模型分段读，
 * 不能不设上限——读回内容不再卸载，一个几十万字的文件原样进历史会直接顶满窗口。
 * 「字符」与卸载阈值、桩里的字符数同为 UTF-16 码元口径。
 */
export const READBACK_MAX = 50_000;

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

  /**
   * 这次工具调用是不是「用 file_read 读回本会话的卸载文件」（W2a-5）。是则给出宿主绝对路径，否则 undefined。
   * 为什么要认出来：读回的内容照样超过卸载阈值，旧实现会把它再卸载成一个新文件、落库一个新桩——
   * 模型照着桩去读，永远只拿到下一个桩，卸载掉的内容实际上取不回来。
   * 判定走 resolveGuestPath 而不是比字符串：guest 路径 /var/minis/offloads/<id>.txt 和（Windows 上的）
   * 宿主绝对路径两种写法都要认；解析抛错（未知命名空间、穿越、Linux 上的 POSIX 绝对路径）一律当「不是读回」，
   * 那种调用工具自己会报错，这里不该抢先抛。只认本会话的 offloads 桶：别的会话的卸载文件不归这里放行。
   */
  readBackOf(sessionId: string, toolName: string, inputJson: string): { absPath: string } | undefined {
    if (toolName !== 'file_read') return undefined;
    let path: unknown;
    try { path = (JSON.parse(inputJson) as { path?: unknown } | null)?.path; } catch { return undefined; }
    if (typeof path !== 'string') return undefined;
    let absPath: string;
    try { absPath = this.paths.resolveGuestPath(sessionId, path); } catch { return undefined; }
    const rel = relative(this.paths.sessionBucket(sessionId, 'offloads'), absPath);
    // rel 为空 = 桶目录本身；'..' 开头 = 在桶外；绝对路径 = Windows 上跨盘。
    // 不用 startsWith('..')：桶里名叫「..x.txt」的文件也会被误判成桶外
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return undefined;
    return { absPath };
  }

  /**
   * 读回内容落库前封顶（W2a-5）：不超过 READBACK_MAX 原样返回；超过则只留前面一段，并如实写明全长与剩下的读法。
   * 切点按码元算（与 compact.ts 同理：长文本不整串 Array.from），落在代理对中间就少取一位——
   * 孤立代理项进了请求体，严格的 JSON 端直接 400。注明的是实际返回的字数，不写死 50000。
   *
   * 剩下的部分指回 file_read 分段读取（W1b-2d）：path 不变，offset 从实际返回的终点起，limit 不超过 READBACK_MAX。
   * 以前叫模型用 shell_execute 分段读并附宿主位置；但卸载文件在数据根里，W1b-2 起 shell 只读命令点到数据根
   * 就回落询问，照提示读每段都弹卡，而当前会话的 offloads 对文件工具免审。旧尾注里「每段不超过 20000，
   * 否则会再次被卸载」也是假话：readBackOf 认出的读回（只看 path，带不带 offset/limit 都算）不再卸载。
   *
   * range 是 file_read 分段读取给的实际范围（ToolOutcome.readRange）。有它时 output 是「片段 + 换行 + 范围注记」：
   * 只拿片段比上限——注记不算正文，limit 取满 READBACK_MAX 时不该因为多出一行注记被截；
   * 超了就连注记一起换成截断尾注，全长与下一段 offset 按文件坐标写（起点 + 实际返回的字数），
   * 留着原注记的话，它给的下一段 offset 会让模型跳过被截掉的那一截。
   */
  clampReadBack(output: string, range?: ReadRange): string {
    const bodyLen = range ? range.end - range.start : output.length;
    if (bodyLen <= READBACK_MAX) return output;
    let cut = READBACK_MAX;
    const c = output.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
    const start = range?.start ?? 0;
    const total = range?.total ?? output.length;
    const next = start + cut;
    const got = range ? `这次请求的是第 ${range.start}–${range.end} 字符，读回上限 ${READBACK_MAX}，这里只返回第 ${start}–${next} 字符` : `这里只返回前 ${cut} 字符`;
    return `${output.slice(0, cut)}\n[已截断：该文件共 ${total} 字符，${got}。其余部分请接着用 file_read 分段读取：path 不变，offset=${next}，limit 不超过 ${READBACK_MAX}；每段末尾会注明实际范围与下一段的 offset。]`;
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
    // 指针行按长度二分（W2a-5）：读回有 READBACK_MAX 上限，超过的文件一次 file_read 取不回全文，
    // 桩再说「取回完整内容」就是空头支票；不超过的维持原文（offload.test.ts 的全等断言钉着）
    const pointer = output.length <= READBACK_MAX
      ? `使用 file_read 工具读取 /var/minis/offloads/${toolUseId}.txt 取回完整内容`
      : `使用 file_read 读取 /var/minis/offloads/${toolUseId}.txt 可取回前 ${READBACK_MAX} 字符（全文 ${output.length} 字符，其余需分段读取）`;
    const stub = `[CONTEXT OFFLOADED: ${relativePath} (${output.length} 字符)]\n开头: ${excerpt}\n${pointer}`;
    return { stub, relativePath };
  }
}
