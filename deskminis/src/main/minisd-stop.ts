/** 主进程优雅停止 minisd（W1b-5 · 设计稿 §3 第 11 条）。纯逻辑，不 import electron：单测用假子进程替身。
 *
 *  为什么不直接 kill：Windows 上 kill 就是 TerminateProcess，minisd 来不及了结权限卡、等 run 收尾、关库，
 *  它起的 MCP 与 PowerShell 子进程还会变成孤儿。先 postMessage 请它自己有序 close，超时才硬杀兜底。 */

/** 主进程等 minisd 自己退出的上限。必须比 minisd 等 run 收尾的 CLOSE_GRACE_MS（3 秒）多出至少 1 秒，
 *  留给销毁子进程、关库与 WAL checkpoint；超过它就 kill——退出与「重启并安装」都不能被一个卡住的 run 拖住。 */
export const MINISD_STOP_TIMEOUT_MS = 5_000;

/** 发给 minisd 的停止消息；minisd 的 standalone 分支在 parentPort 上认 type === 'shutdown'。 */
export const MINISD_SHUTDOWN_MESSAGE = { type: 'shutdown' } as const;

/** 用到的 UtilityProcess 子集。 */
export interface MinisdChild {
  postMessage(message: unknown): void;
  kill(): boolean;
}

export type StopOutcome = 'already-exited' | 'exited' | 'killed';

/** 一次 fork 对应一个：记下引擎进程的退出，并负责停止它。
 *  退出只由主进程唯一的 exit 监听写入（markExited）——两处各挂一个监听的话，谁先谁后、谁算崩溃就说不清了。
 *  W2b-7 的崩溃记录读 stopRequested：请求过停止之后的退出是正常退出，没请求过的才是崩溃。 */
export class MinisdExitWatch {
  private done = false;
  private exitCode: number | undefined;
  private resolveExit!: () => void;
  private readonly whenExited = new Promise<void>(r => { this.resolveExit = r; });
  private stopping: Promise<StopOutcome> | undefined;

  get exited(): boolean { return this.done; }
  get code(): number | undefined { return this.exitCode; }
  /** 退出流程是否已经开始（stop 调过）。 */
  get stopRequested(): boolean { return this.stopping !== undefined; }

  /** 只记第一次：进程只会退一次，重复调用不改已记下的退出码。 */
  markExited(code: number): void {
    if (this.done) return;
    this.done = true;
    this.exitCode = code;
    this.resolveExit();
  }

  /** 请 minisd 有序关停，timeoutMs 内没退就 kill。幂等：托盘连点「退出」、更新流程与 before-quit 前后脚，
   *  都拿到同一个 promise，shutdown 只发一次。已经先退了（崩溃）就不等。永不 reject。 */
  stop(child: MinisdChild, timeoutMs: number): Promise<StopOutcome> {
    if (this.stopping) return this.stopping;
    if (this.done) {
      this.stopping = Promise.resolve('already-exited');
      return this.stopping;
    }
    this.stopping = new Promise<StopOutcome>(resolve => {
      const timer = setTimeout(() => {
        // 到点还没退：硬杀。半截回复可能丢，但退出与安装不能卡住
        try { child.kill(); } catch { /* 已经没了 */ }
        resolve('killed');
      }, timeoutMs);
      void this.whenExited.then(() => { clearTimeout(timer); resolve('exited'); });
      // 通道已断时 postMessage 会抛：不往外抛，等超时 kill
      try { child.postMessage(MINISD_SHUTDOWN_MESSAGE); } catch { /* 见上 */ }
    });
    return this.stopping;
  }
}

/** before-quit 事件里用到的部分。 */
export interface QuitEvent { preventDefault(): void }

/** 退出闸在一次 before-quit 里要用的几样东西，都由主进程接好传进来。 */
export interface QuitHooks {
  /** minisd 还需要停：fork 过、且还没退（先崩了的不等）。 */
  minisdAlive: boolean;
  /** 收掉窗口与托盘：用户点了退出就该马上看到退出了，别对着一个没反应的窗口等几秒。 */
  hideUi(): void;
  /** 请 minisd 有序关停（stopMinisdGracefully）。 */
  stop(): Promise<unknown>;
  /** 真正退出（app.quit）。它会再触发一次 before-quit，那一次必须放行。 */
  quit(): void;
}

/** 退出闸（W1b-5）：before-quit 的「放行还是挡住 → 停 minisd → 停完再退 → 下一次放行」都在这里。
 *
 *  为什么单独成类：这段判定以前写在 index.ts 的处理体里，只能靠源码守卫认调用形态；审查实测
 *  「不等停完就 quit」（关库前退出）与「早退分支丢了」（每次 before-quit 都被挡、应用永远退不出）都骗得过守卫。
 *  搬到这里用假钩子按行为测（tests/minisd-stop.test.ts），index.ts 只负责接线。 */
export class QuitGate {
  private stopped = false;
  private stopping = false;

  /** minisd 已经停过：停完了、「重启并安装」前停过、或启动失败时硬杀过。之后的 before-quit 一律放行。 */
  get minisdStopped(): boolean { return this.stopped; }

  /** 别处已经把 minisd 停掉了（更新流程 await 停完、启动失败 kill 过）：之后的 before-quit 放行，不再等第二遍。 */
  markStopped(): void { this.stopped = true; }

  /** 处理一次 before-quit。'pass' = 放行这次退出；'held' = 挡住了，停完会自己再调 quit。 */
  onBeforeQuit(e: QuitEvent, hooks: QuitHooks): 'pass' | 'held' {
    if (this.stopped || !hooks.minisdAlive) return 'pass';
    e.preventDefault();
    // 已经在停（托盘连点、更新流程与退出前后脚）：照样挡住，停完那一次 quit 会带着一起退，不再发第二遍
    if (this.stopping) return 'held';
    this.stopping = true;
    try { hooks.hideUi(); } catch { /* 窗口已销毁之类：收界面失败不能耽误停与退 */ }
    // 停成功还是失败都要退：窗口已经收了，卡在这里就成了「看不见、退不掉」的进程
    const done = (): void => { this.stopped = true; hooks.quit(); };
    let stopping: Promise<unknown>;
    try { stopping = hooks.stop(); } catch (err) { stopping = Promise.reject(err); }
    void stopping.then(done, done);
    return 'held';
  }
}
