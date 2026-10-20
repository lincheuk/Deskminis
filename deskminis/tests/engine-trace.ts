/**
 * Q20：把「谁先谁后、调了几次、两步之间有没有让出执行权」做成运行时观察（辅助，不是测试）。
 *
 * 以前这类保证靠读 src/minisd/index.ts 的文本：比两段代码在文件里的位置、数某个调用出现了几次、查两点之间有没有 await 字样。
 * 文本上的先后不等于执行的先后；代码原样搬到别的模块，这些断言也会红。这里改成在真实引擎上观察真实发生的调用：
 *  - watch(对象, 方法)：只观察，原实现照常执行。对象是类的 prototype（引擎里这个类的所有实例都看得到），
 *    或模块命名空间（import * as ns；看得到别的模块对这个导出函数的调用）。
 *  - watchNew(命名空间, 类名)：观察一个导出的类被 new 了几次、实参是什么；造出来的仍是原来那个类的实例。
 *  - sequence({ 名字: spy, … })：把这些调用按发生的先后排成一条名字序列。
 *  - yieldProbe(a, b)：a 被调用之后、b 被调用之前，执行权有没有让出去过（await、.then、定时器）。
 * 用完由测试自己 vi.restoreAllMocks()。
 */
import { expect, vi, type MockInstance } from 'vitest';
import { promiseHooks } from 'node:v8';
import type { LifecycleEvent } from '../src/minisd/store/chat-store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
export type Watched = MockInstance<AnyFn>;
type Tap = (self: unknown, args: unknown[]) => void;

type After = (result: unknown, self: unknown, args: unknown[]) => void;

const taps = new WeakMap<Watched, Tap[]>();
const afters = new WeakMap<Watched, After[]>();

export function watch<T extends object>(target: T, method: keyof T & string): Watched {
  const original = target[method] as unknown as AnyFn;
  if (typeof original !== 'function') throw new Error(`watch：${method} 不是函数`);
  const spy = vi.spyOn(target as never, method as never) as unknown as Watched;
  const list: Tap[] = [];
  const done: After[] = [];
  taps.set(spy, list);
  afters.set(spy, done);
  spy.mockImplementation(function (this: unknown, ...args: unknown[]) {
    for (const tap of list) tap(this, args);
    const result = original.apply(this, args);
    for (const after of done) after(result, this, args);
    return result;
  });
  return spy;
}

/** 只记录、不包任何实现的观察点：测试（或别的观察点的回调）调它一次就记一笔，同样能挂 onCall、进 sequence。 */
export function recorder(): Watched & ((...args: any[]) => void) {
  const spy = vi.fn() as unknown as Watched & ((...args: any[]) => void);
  const list: Tap[] = [];
  taps.set(spy, list);
  spy.mockImplementation(function (this: unknown, ...args: unknown[]) { for (const tap of list) tap(this, args); });
  return spy;
}

/** 每次调用返回之后跑一段观察代码（拿得到返回值）。只对 watch 建的观察点有效。 */
export function onReturn(spy: Watched, after: After): void {
  const list = afters.get(spy);
  if (!list) throw new Error('onReturn：这个 spy 不是 watch 建的');
  list.push(after);
}

export function watchNew<T extends object>(ns: T, name: keyof T & string): Watched {
  const Original = ns[name] as unknown as new (...args: unknown[]) => object;
  if (typeof Original !== 'function') throw new Error(`watchNew：${name} 不是类`);
  const spy = vi.spyOn(ns as never, name as never) as unknown as Watched;
  const list: Tap[] = [];
  taps.set(spy, list);
  // 被 new 调用时返回一个对象，new 的结果就是它：原来的类照常构造，实例的原型链不变
  spy.mockImplementation(function (this: unknown, ...args: unknown[]) {
    for (const tap of list) tap(this, args);
    return new Original(...args);
  });
  // 换上去的 spy 仍要答得对 instanceof（产品代码与测试里都可能拿导出的类名来判）
  Object.defineProperty(spy, Symbol.hasInstance, { value: (x: unknown) => x instanceof Original, configurable: true });
  return spy;
}

/** 每次调用之前先跑一段观察代码（self 是调用时的 this）。 */
export function onCall(spy: Watched, tap: Tap): void {
  const list = taps.get(spy);
  if (!list) throw new Error('onCall：这个 spy 不是 watch / watchNew 建的');
  list.push(tap);
}

/** 此刻的全局调用序号：之后发生的 spy 调用，序号都比它大（传给 sequence 的 after）。 */
export function callMark(): number {
  const f = vi.fn();
  f();
  return f.mock.invocationCallOrder[0];
}

/** 把几个被观察的调用按发生的先后排成一条名字序列（vitest 给每次 spy 调用编了全局序号）。 */
export function sequence(named: Record<string, Watched>, after = 0): string[] {
  const all: { name: string; at: number }[] = [];
  for (const [name, spy] of Object.entries(named)) {
    for (const at of spy.mock.invocationCallOrder) if (at > after) all.push({ name, at });
  }
  return all.sort((x, y) => x.at - y.at).map(e => e.name);
}

/**
 * a 被调用之后、b 下一次被调用之前，执行权有没有让出去过。每遇到一对（a 之后的第一个 b）往返回的数组里记一个值：true = 让出过。
 * 判法：a 被调用时排一个微任务，b 被调用时看它跑了没有。两次调用之间只要有一个 await（哪怕等的是已经兑现的 promise）、
 * 一个 .then 或一次定时器，排着的微任务就会先跑。a 再次被调用会重新起算。
 */
export function yieldProbe(a: Watched, b: Watched): boolean[] {
  const gaps: boolean[] = [];
  let open: { ran: boolean } | undefined;
  onCall(a, () => {
    const mark = { ran: false };
    open = mark;
    queueMicrotask(() => { mark.ran = true; });
  });
  onCall(b, () => {
    if (!open) return;
    gaps.push(open.ran);
    open = undefined;
  });
  return gaps;
}

/** 同步观察这个实际 Promise 被兑现/拒绝的时刻；不等待 then 微任务，不改变 Promise。返回摘除函数。 */
export function onPromiseSettled(promise: Promise<unknown>, observe: () => void): () => void {
  const stop = promiseHooks.createHook({ settled(p) { if (p === promise) observe(); } });
  return () => { stop(); };
}

/** 完整生命周期输入；映射类型要求每个 kind 都有且字段齐全。产品新增 kind 时 tsc 会强制补齐。 */
export function allLifecycleEvents(sessionId: string, lifecycle: LifecycleEvent['lifecycle']): LifecycleEvent[] {
  const cases = {
    deleted: { kind: 'deleted', sessionId, lifecycle, messageCount: 1 },
    'tombstone-applied': { kind: 'tombstone-applied', sessionId, lifecycle, hadLocalCopy: true, retained: false, unseenCount: null, annotationCount: 0 },
    'retained-released': { kind: 'retained-released', sessionId, lifecycle },
    restored: { kind: 'restored', sessionId, lifecycle },
    'restore-applied': { kind: 'restore-applied', sessionId, lifecycle },
    purged: { kind: 'purged', sessionId, lifecycle },
    'stale-content-rejected': { kind: 'stale-content-rejected', sessionId, lifecycle },
  } satisfies { [K in LifecycleEvent['kind']]: Extract<LifecycleEvent, { kind: K }> };
  return Object.values(cases);
}

/** 先用布尔身份断言避免 Vitest 展开 SQLite 等复杂实例；随后仍保留直接身份断言。 */
export function expectSame(actual: unknown, expected: unknown, label?: string): void {
  expect(Object.is(actual, expected), label).toBe(true);
  expect(actual, label).toBe(expected);
}
