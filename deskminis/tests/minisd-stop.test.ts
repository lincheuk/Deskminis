/**
 * W1b-5：主进程优雅停止 minisd 的纯逻辑（src/main/minisd-stop.ts），不起 Electron，用假子进程。
 *
 * 以前退出与「重启并安装」都是直接 kill：Windows 上就是 TerminateProcess，minisd 来不及关库、了结权限卡，
 * 它起的 MCP 与 PowerShell 子进程变成孤儿。现在先 postMessage({type:'shutdown'}) 让它有序 close，
 * 等它自己退；超时才 kill 兜底。停止幂等：托盘连点两次「退出」、更新流程与 before-quit 前后脚，都只发一次 shutdown。
 * 退出状态只由主进程唯一的 exit 监听写入（设计稿 §3 第 11 条），W2b-7 靠 stopRequested 区分「退出流程中的 exit」与崩溃。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MinisdExitWatch, QuitGate, MINISD_STOP_TIMEOUT_MS, MINISD_SHUTDOWN_MESSAGE } from '../src/main/minisd-stop';
import { CLOSE_GRACE_MS, REAP_WAIT_MS } from '../src/minisd/index';

function fakeChild(opts: { postThrows?: boolean } = {}) {
  const posted: unknown[] = [];
  let kills = 0;
  return {
    posted, kills: () => kills,
    postMessage(m: unknown) { if (opts.postThrows) throw new Error('通道已断'); posted.push(m); },
    kill() { kills++; return true; },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('MinisdExitWatch.stop：先请它自己退，超时再 kill', () => {
  it('发 {type:"shutdown"}；超时前退出 → exited，不 kill', async () => {
    vi.useFakeTimers();
    const w = new MinisdExitWatch();
    const child = fakeChild();
    const p = w.stop(child, 5000);
    expect(child.posted).toEqual([{ type: 'shutdown' }]);
    expect(MINISD_SHUTDOWN_MESSAGE).toEqual({ type: 'shutdown' });
    await vi.advanceTimersByTimeAsync(1000);
    w.markExited(0);
    await expect(p).resolves.toBe('exited');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kills()).toBe(0);
  });

  it('到点还没退 → kill 一次，结果 killed', async () => {
    vi.useFakeTimers();
    const w = new MinisdExitWatch();
    const child = fakeChild();
    const p = w.stop(child, 5000);
    await vi.advanceTimersByTimeAsync(4999);
    expect(child.kills()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('killed');
    expect(child.kills()).toBe(1);
  });

  it('幂等：重复调用拿到同一个 promise，shutdown 只发一次、kill 最多一次', async () => {
    vi.useFakeTimers();
    const w = new MinisdExitWatch();
    const child = fakeChild();
    const p1 = w.stop(child, 5000);
    const p2 = w.stop(child, 5000);
    expect(p2).toBe(p1);
    expect(child.posted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6000);
    await p1;
    expect(child.kills()).toBe(1);
    expect(w.stop(child, 5000)).toBe(p1);
  });

  it('已经退出（先崩了）→ 不发消息、不 kill、不等', async () => {
    const w = new MinisdExitWatch();
    const child = fakeChild();
    w.markExited(1);
    await expect(w.stop(child, 5000)).resolves.toBe('already-exited');
    expect(child.posted).toEqual([]);
    expect(child.kills()).toBe(0);
  });

  it('postMessage 抛错（通道已断）→ 不抛出，到点照样 kill', async () => {
    vi.useFakeTimers();
    const w = new MinisdExitWatch();
    const child = fakeChild({ postThrows: true });
    const p = w.stop(child, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBe('killed');
    expect(child.kills()).toBe(1);
  });
});

describe('MinisdExitWatch 的退出记录（唯一 exit 监听写入，W2b-7 复用）', () => {
  it('没请求停止时的退出：exited 且 stopRequested=false（这就是崩溃）；code 记下', () => {
    const w = new MinisdExitWatch();
    expect(w.exited).toBe(false);
    w.markExited(3);
    expect(w.exited).toBe(true);
    expect(w.code).toBe(3);
    expect(w.stopRequested).toBe(false);
  });

  it('请求停止之后的退出：stopRequested=true；重复 markExited 不改第一次的 code', () => {
    const w = new MinisdExitWatch();
    void w.stop(fakeChild(), 5000);
    expect(w.stopRequested).toBe(true);
    w.markExited(0);
    w.markExited(9);
    expect(w.code).toBe(0);
  });
});

describe('时限的相对关系', () => {
  // W1b-5d 有意重指：原断言只算 minisd 等 run 收尾的 graceMs（MINISD_STOP_TIMEOUT_MS - CLOSE_GRACE_MS >= 1000）。
  // 关停第 6 步现在还要等子进程树回收（taskkill 跑完），上限 REAP_WAIT_MS，两段等待是先后相加的；
  // 只算一段的话，把 REAP_WAIT_MS 调大到吃掉余量也照样绿，主进程会在 minisd 关库之前 kill 它。
  it('主进程兜底不超过 5 秒，且比 minisd 关停里两段等待（run 收尾 graceMs + 子进程树回收 REAP_WAIT_MS）之和至少多 1 秒（留给关桥、rpc、关库与 WAL checkpoint）', () => {
    expect(MINISD_STOP_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    expect(REAP_WAIT_MS, '回收要等，上限不能是 0').toBeGreaterThan(0);
    expect(MINISD_STOP_TIMEOUT_MS - (CLOSE_GRACE_MS + REAP_WAIT_MS)).toBeGreaterThanOrEqual(1000);
  });
});

/**
 * W1b-5 审查：before-quit 的「放行还是挡住 → 停 minisd → 停完再退 → 第二次放行」以前写在 index.ts 的处理体里，
 * 只能靠源码守卫认调用形态——「不等就退」「早退分支没了、第二次 before-quit 也被挡住、永远退不出」这两种回退守卫都认不出。
 * 现在判定搬进 QuitGate（纯逻辑），这里按行为钉住；index.ts 只负责把钩子接上（main-shutdown-wiring 守接线）。
 */
describe('QuitGate：挡住第一次 before-quit，停完再退，第二次放行', () => {
  /** 模拟 Electron：app.quit() 会再触发一次 before-quit，那一次没被挡住就算真的退出了。 */
  function harness(opts: { alive?: boolean; hideThrows?: boolean } = {}) {
    const gate = new QuitGate();
    const log: string[] = [];
    const events: { prevented: boolean }[] = [];
    let exited = false;
    let quitDepth = 0;
    let stopCalls = 0;
    let settle!: { resolve: () => void; reject: (e: unknown) => void };
    const stopping = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    const hooks = {
      minisdAlive: opts.alive ?? true,
      hideUi: () => { log.push('hide'); if (opts.hideThrows) throw new Error('窗口已销毁'); },
      stop: () => { stopCalls++; log.push('stop'); return stopping; },
      quit: () => {
        log.push('quit');
        // 第二次 before-quit 没放行的话，这里会一路递归下去
        if (++quitDepth > 5) throw new Error('app.quit 递归：停完之后的 before-quit 仍被挡住');
        fire();
      },
    };
    function fire(): 'pass' | 'held' {
      const e = { prevented: false, preventDefault() { this.prevented = true; } };
      events.push(e);
      const r = gate.onBeforeQuit(e, hooks);
      if (!e.prevented) exited = true;
      return r;
    }
    return { gate, log, events, fire, settle, stopCalls: () => stopCalls, exited: () => exited };
  }
  /** 让已排队的 then 回调都跑完 */
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('第一次：挡住、先收界面再请 minisd 停；停完之前绝不 quit', async () => {
    const h = harness();
    expect(h.gate.minisdStopped).toBe(false);
    expect(h.fire()).toBe('held');
    expect(h.events[0].prevented).toBe(true);
    expect(h.log).toEqual(['hide', 'stop']);
    await flush();
    expect(h.log, '停止还没完成就 quit = 不等 minisd 关库就退出').not.toContain('quit');
    expect(h.exited()).toBe(false);
  });

  it('停完：置 minisdStopped 再 quit；quit 触发的第二次 before-quit 放行，应用真的退出', async () => {
    const h = harness();
    h.fire();
    h.settle.resolve();
    await flush();
    expect(h.log).toEqual(['hide', 'stop', 'quit']);
    expect(h.gate.minisdStopped).toBe(true);
    expect(h.events).toHaveLength(2);
    expect(h.events[1].prevented, '第二次 before-quit 必须放行，否则应用永远退不出').toBe(false);
    expect(h.exited()).toBe(true);
    expect(h.stopCalls()).toBe(1);
  });

  it('停的过程中又来 before-quit（托盘连点、更新流程前后脚）：照样挡住，不再收一遍界面、不再发第二遍停；停完只 quit 一次', async () => {
    const h = harness();
    expect(h.fire()).toBe('held');
    expect(h.fire()).toBe('held');
    expect(h.events.map(e => e.prevented)).toEqual([true, true]);
    expect(h.stopCalls()).toBe(1);
    expect(h.log).toEqual(['hide', 'stop']);
    h.settle.resolve();
    await flush();
    expect(h.log.filter(x => x === 'quit')).toHaveLength(1);
    expect(h.exited()).toBe(true);
  });

  it('minisd 没 fork 或已先退（崩了）：直接放行，不挡、不停', () => {
    const h = harness({ alive: false });
    expect(h.fire()).toBe('pass');
    expect(h.events[0].prevented).toBe(false);
    expect(h.log).toEqual([]);
    expect(h.exited()).toBe(true);
  });

  it('markStopped 之后（「重启并安装」已停完、启动失败时已硬杀）：直接放行', () => {
    const h = harness();
    h.gate.markStopped();
    expect(h.gate.minisdStopped).toBe(true);
    expect(h.fire()).toBe('pass');
    expect(h.events[0].prevented).toBe(false);
    expect(h.stopCalls()).toBe(0);
  });

  it('停止失败（reject）也照样退出：不能把应用卡在「窗口没了、进程还在」', async () => {
    const h = harness();
    h.fire();
    h.settle.reject(new Error('停止器出错'));
    await flush();
    expect(h.gate.minisdStopped).toBe(true);
    expect(h.exited()).toBe(true);
  });

  it('收界面抛错（窗口已销毁）不影响停与退', async () => {
    const h = harness({ hideThrows: true });
    expect(h.fire()).toBe('held');
    expect(h.stopCalls()).toBe(1);
    h.settle.resolve();
    await flush();
    expect(h.exited()).toBe(true);
  });
});
