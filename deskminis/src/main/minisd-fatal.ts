/** minisd 致命行通道的主进程一侧（设计稿 §3 第 8 条）：认行、带着信息结束启动等待、生成对话框参数。
 *  不 import electron（只有类型），便于在 ELECTRON_RUN_AS_NODE 下直接单测。 */
import type { MessageBoxSyncOptions } from 'electron';
import { toMinisdFatal, type MinisdFatal } from '../minisd/fatal';

export type { MinisdFatal } from '../minisd/fatal';

/** 一行 stdout 是不是 minisd 的致命行；不是就返回 undefined（调用方继续当握手行或普通日志处理）。 */
export function parseMinisdFatal(line: string): MinisdFatal | undefined {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return undefined; }
  if (typeof o !== 'object' || o === null) return undefined;
  return toMinisdFatal((o as { minisdFatal?: unknown }).minisdFatal);
}

/** 启动等待以它 reject，catch 分支据此选「只给退出」的专用对话框，而不是通用的错误框。 */
export class MinisdFatalError extends Error {
  constructor(readonly fatal: MinisdFatal) {
    super(`minisd 启动时报告了致命错误 ${fatal.code}（数据目录 ${fatal.dataRoot}）`);
    this.name = 'MinisdFatalError';
  }
}

/** 致命错误对话框。按钮只有「退出」：这几种情况下任何「清空 / 重置 / 覆盖」都会毁掉用户数据，
 *  而用户自己能处理（装新版 / 先退出另一个窗口），数据目录以文字给出，高级用户照着找得到。 */
export function fatalDialogOptions(fatal: MinisdFatal): MessageBoxSyncOptions {
  const base = { type: 'error' as const, buttons: ['退出'], defaultId: 0, cancelId: 0, noLink: true };
  switch (fatal.code) {
    case 'DB_NEWER_THAN_APP':
      return {
        ...base,
        title: 'DeskMinis 无法打开数据',
        message: '这份数据来自更新版本的 DeskMinis',
        detail: `数据库版本为 ${fatal.dbVersion}，当前应用只支持到 ${fatal.appVersion}。`
          + '为避免损坏你的会话和设置，本次没有打开它，也没有做任何改动。请安装最新版本后再启动。\n\n'
          + `数据目录：${fatal.dataRoot}`,
      };
    case 'DATA_ROOT_LOCKED':
      return {
        ...base,
        title: 'DeskMinis 已在运行',
        message: `另一个 DeskMinis（进程 ${fatal.pid}）正在使用数据目录 ${fatal.dataRoot}。请先从托盘退出它，再重新打开。`,
      };
  }
}

/** 通用启动失败框的正文：以前只有「minisd 退出 code=1」，真正的原因在 stderr 里；附上它的末尾。 */
export function withStderrTail(message: string, tail: string): string {
  return tail.trim() === '' ? message : `${message}\n\n引擎最后的输出：\n${tail.trimEnd()}`;
}
