/** Office 产物的核验结果（F10A；F10B / F10C 共用，只许追加）。
 *
 *  要守住的一条：**没有在真实程序里打开过的，就是「未核验」**。ZIP / XML 回读只能给出内容结论，
 *  给不出版式或计算结论——这一点写在构造函数里，违反即抛，别处拼不出「版式核验：通过」。
 *
 *  三种状态的含义：
 *  - verified / failed：某个引擎**真的跑完了**，量到的每一项都有结论；
 *  - unverified：跑不起来、超时、被跳过，或有检查项没量到。「没量到」不等于「不合格」。
 *
 *  纯类型加纯函数：不引 node，渲染端可以 `import type`。 */

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';
/** calc 留给 F10B（公式结果）；本任务不产生 */
export type OfficeAspect = 'content' | 'layout' | 'calc';
export type OfficeEngineId = 'deskminis-readback' | 'ms-word' | 'ms-excel' | 'ms-powerpoint';
/** 内置回读写 version:'1'；Office 写 COM 报告的 Build，如 '16.0.15128' */
export interface OfficeEngine { id: OfficeEngineId; version: string; detail?: string }
/** unmeasured：这一项没有量到（读数取不出来），不是量到了不合格。带它的项 ok 必须是 false。 */
export interface OfficeCheckItem { id: string; ok: boolean; unmeasured?: true; expected?: string; actual?: string; where?: string }
/** 核验的就是这些字节：文件之后再被改，这条结论即失效。sha256 与文件检查点的版本哈希同一算法。 */
export interface OfficeSubject { sha256: string; size: number }

export type OfficeUnverifiedReason =
  | 'not-run'            // 这条路径不做该项核验（产品运行时的 layout 恒为它）
  | 'not-implemented'    // 这种格式还没有接入这项核验
  | 'engine-missing' | 'engine-busy' | 'session-locked' | 'runner-busy'
  | 'incomplete'         // 引擎跑完了，但有检查项没量到（或一项检查都没有）：证据不足，不是不合格
  | 'timeout' | 'blocked-dialog' | 'engine-error' | 'cancelled' | 'denied';

export type OfficeVerification =
  | { aspect: OfficeAspect; subject: OfficeSubject; status: 'verified'; engine: OfficeEngine; checks: readonly OfficeCheckItem[]; message: string }
  | { aspect: OfficeAspect; subject: OfficeSubject; status: 'failed'; engine: OfficeEngine; checks: readonly OfficeCheckItem[]; failed: readonly string[]; message: string }
  | { aspect: OfficeAspect; subject: OfficeSubject; status: 'unverified'; reason: OfficeUnverifiedReason; message: string; engine?: OfficeEngine;
      /** reason === 'incomplete' 时带上各项（量到的与没量到的），供记录用 */
      checks?: readonly OfficeCheckItem[] };

const ASPECTS: readonly OfficeAspect[] = ['content', 'layout', 'calc'];
const ENGINE_IDS: readonly OfficeEngineId[] = ['deskminis-readback', 'ms-word', 'ms-excel', 'ms-powerpoint'];
const REASONS: readonly OfficeUnverifiedReason[] = ['not-run', 'not-implemented', 'engine-missing', 'engine-busy', 'session-locked',
  'runner-busy', 'incomplete', 'timeout', 'blocked-dialog', 'engine-error', 'cancelled', 'denied'];
const ASPECT_LABEL: Record<OfficeAspect, string> = { content: '内容核验', layout: '版式核验', calc: '计算核验' };

/** 三个构造函数共用的不变量。只能经它们造值（守卫测试：别处不出现 status: 'verified' 的字面量）。 */
function assertChecks(checks: readonly OfficeCheckItem[]): void {
  for (const c of checks) {
    if (c.unmeasured && c.ok) throw new Error(`核验项 ${c.id}：没量到的项不能记成通过`);
  }
}
/** 内置的 ZIP / XML 回读给不出版式或计算结论：这种组合不允许构造。 */
function assertEngineFits(aspect: OfficeAspect, engine: OfficeEngine): void {
  if (aspect !== 'content' && engine.id === 'deskminis-readback') {
    throw new Error(`内置回读不能给出${ASPECT_LABEL[aspect]}的结论`);
  }
}

export function officeVerified(aspect: OfficeAspect, subject: OfficeSubject, engine: OfficeEngine,
  checks: readonly OfficeCheckItem[], message: string): OfficeVerification {
  assertEngineFits(aspect, engine);
  assertChecks(checks);
  if (checks.length === 0) throw new Error('没有任何检查项，不能记成已核验');
  const bad = checks.find(c => !c.ok);
  if (bad) throw new Error(`核验项 ${bad.id} 没有通过，不能记成已核验`);
  return { aspect, subject, status: 'verified', engine, checks, message };
}

export function officeFailed(aspect: OfficeAspect, subject: OfficeSubject, engine: OfficeEngine,
  checks: readonly OfficeCheckItem[], message?: string): OfficeVerification {
  assertEngineFits(aspect, engine);
  assertChecks(checks);
  // 「量到了且不过」才算不合格；没量到的项不进 failed
  const bad = checks.filter(c => !c.ok && !c.unmeasured);
  if (bad.length === 0) throw new Error('没有量到了且不过的项，不能记成未通过');
  return { aspect, subject, status: 'failed', engine, checks, failed: bad.map(c => c.id), message: message ?? describeCheck(bad[0]) };
}

export function officeUnverified(aspect: OfficeAspect, subject: OfficeSubject, reason: OfficeUnverifiedReason, message: string,
  engine?: OfficeEngine, checks?: readonly OfficeCheckItem[]): OfficeVerification {
  if (checks) assertChecks(checks);
  return { aspect, subject, status: 'unverified', reason, message, ...(engine ? { engine } : {}), ...(checks ? { checks } : {}) };
}

function describeCheck(c: OfficeCheckItem): string {
  const parts = [c.id];
  if (c.where) parts.push(`（${c.where}）`);
  if (c.expected !== undefined || c.actual !== undefined) parts.push(`：应为 ${c.expected ?? '—'}，实际 ${c.actual ?? '—'}`);
  return parts.join('');
}

function isSubject(x: unknown): x is OfficeSubject {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  return typeof s.sha256 === 'string' && /^[0-9a-f]{64}$/.test(s.sha256) && typeof s.size === 'number' && Number.isFinite(s.size) && s.size >= 0;
}
function isEngine(x: unknown): x is OfficeEngine {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return typeof e.id === 'string' && (ENGINE_IDS as readonly string[]).includes(e.id) && typeof e.version === 'string' && e.version.length > 0;
}
function isCheck(x: unknown): x is OfficeCheckItem {
  if (!x || typeof x !== 'object') return false;
  const c = x as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.ok !== 'boolean') return false;
  if (c.unmeasured !== undefined && c.unmeasured !== true) return false;
  return !(c.unmeasured === true && c.ok);
}

/** 读外来的记录（取证的 record.json）时校验：形状不对、或违反构造不变量的一律不认。 */
export function isOfficeVerification(x: unknown): x is OfficeVerification {
  if (!x || typeof x !== 'object') return false;
  const v = x as Record<string, unknown>;
  if (typeof v.aspect !== 'string' || !(ASPECTS as readonly string[]).includes(v.aspect)) return false;
  if (!isSubject(v.subject) || typeof v.message !== 'string') return false;
  const checksOk = (c: unknown): c is OfficeCheckItem[] => Array.isArray(c) && c.every(isCheck);
  if (v.status === 'verified' || v.status === 'failed') {
    if (!isEngine(v.engine) || !checksOk(v.checks)) return false;
    if (v.aspect !== 'content' && v.engine.id === 'deskminis-readback') return false;
    if (v.status === 'verified') return v.checks.length > 0 && v.checks.every(c => c.ok);
    const bad = v.checks.filter(c => !c.ok && !c.unmeasured).map(c => c.id);
    return bad.length > 0 && Array.isArray(v.failed) && v.failed.length === bad.length && v.failed.every((id, i) => id === bad[i]);
  }
  if (v.status === 'unverified') {
    if (typeof v.reason !== 'string' || !(REASONS as readonly string[]).includes(v.reason)) return false;
    if (v.engine !== undefined && !isEngine(v.engine)) return false;
    return v.checks === undefined || checksOk(v.checks);
  }
  return false;
}

/** 只认 aspect === 'layout' && status === 'verified'（而它只能由真实引擎构造出来）。 */
export function isLayoutVerified(vs: readonly OfficeVerification[]): boolean {
  return vs.some(v => v.aspect === 'layout' && v.status === 'verified');
}

/** 工具输出里的一行，措辞固定。unverified 的行一律带「未核验」，不带「通过」。 */
export function officeVerificationLine(v: OfficeVerification): string {
  const label = ASPECT_LABEL[v.aspect];
  if (v.status === 'unverified') return `${label}：未核验——${v.message}`;
  // 内容核验的引擎就是内置回读，版本号对读的人没有意义；真实程序的版本要写出来
  const who = v.aspect === 'content' ? v.engine.id : `${v.engine.id} ${v.engine.version}`;
  if (v.status === 'verified') return `${label}：通过（${who}；${v.message}）`;
  return `${label}：未通过（${who}）——${v.message}`;
}

// ---------------- 运行器记录 ----------------

export type OfficeRunnerOutcome = 'measured' | 'open-failed' | 'engine-missing' | 'engine-busy' | 'session-locked'
  | 'runner-busy' | 'timeout' | 'blocked-dialog' | 'error';
export type OfficeRunnerStage = 'precheck' | 'launch' | 'create-app' | 'open' | 'measure' | 'export' | 'close' | 'done';

/** 运行器（脚本）交回的记录：只量不判。任何结局都要写出这份记录。 */
export interface OfficeRunnerEnvelope<M> {
  schema: 1;
  app: 'word' | 'excel' | 'powerpoint';
  /** 被打开的那份字节（临时副本与原文件同哈希） */
  input: OfficeSubject;
  outcome: OfficeRunnerOutcome;
  /** 停在哪一步 */
  stage: OfficeRunnerStage;
  detail: string;
  /** 接上应用之后才有 */
  engine?: OfficeEngine;
  env: {
    launch: 'safe-exe' | 'com' | null; seconds: number; locked: boolean; licence?: string;
    preexistingPids: number[]; killedPids: number[];
    /** 自己启动、但复核归属后没有结束的进程 */
    leftRunning: number[];
    visibleWindows: string[];
  };
  /** 仅 outcome === 'measured' */
  measured?: M;
  /** Open 报错时必填：错误码与对照文档的结果。只有 control === 'opened' 才允许 outcome === 'open-failed'。 */
  openError?: { hresult: string; message: string; control: 'opened' | 'failed' | 'not-run'; controlHresult?: string };
}

const OUTCOMES: readonly OfficeRunnerOutcome[] = ['measured', 'open-failed', 'engine-missing', 'engine-busy', 'session-locked',
  'runner-busy', 'timeout', 'blocked-dialog', 'error'];
const STAGES: readonly OfficeRunnerStage[] = ['precheck', 'launch', 'create-app', 'open', 'measure', 'export', 'close', 'done'];

/** 形状校验。量测本身（measured）的形状由各格式的判定函数负责，这里只管信封。
 *  缺引擎的 measured、没有对照结果的 open-failed 仍算合法的信封——它们映射成「未核验」（见下），不是在这里拒收。 */
export function isOfficeRunnerEnvelope(x: unknown): x is OfficeRunnerEnvelope<unknown> {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  if (e.schema !== 1) return false;
  if (e.app !== 'word' && e.app !== 'excel' && e.app !== 'powerpoint') return false;
  if (!isSubject(e.input)) return false;
  if (typeof e.outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(e.outcome)) return false;
  if (typeof e.stage !== 'string' || !(STAGES as readonly string[]).includes(e.stage)) return false;
  if (typeof e.detail !== 'string') return false;
  if (e.engine !== undefined && !isEngine(e.engine)) return false;
  const env = e.env as Record<string, unknown> | undefined;
  if (!env || typeof env !== 'object') return false;
  if (env.launch !== 'safe-exe' && env.launch !== 'com' && env.launch !== null) return false;
  if (typeof env.seconds !== 'number' || typeof env.locked !== 'boolean') return false;
  for (const k of ['preexistingPids', 'killedPids', 'leftRunning', 'visibleWindows']) if (!Array.isArray(env[k])) return false;
  if (e.openError !== undefined) {
    const o = e.openError as Record<string, unknown>;
    if (!o || typeof o !== 'object' || typeof o.hresult !== 'string' || typeof o.message !== 'string') return false;
    if (o.control !== 'opened' && o.control !== 'failed' && o.control !== 'not-run') return false;
  }
  return true;
}

const SKIP_REASONS: Partial<Record<OfficeRunnerOutcome, OfficeUnverifiedReason>> = {
  'engine-missing': 'engine-missing', 'engine-busy': 'engine-busy', 'session-locked': 'session-locked',
  'runner-busy': 'runner-busy', timeout: 'timeout', 'blocked-dialog': 'blocked-dialog',
};

/** 唯一把量测变成核验结论的地方。
 *
 *  - measured：跑判定。有「量到了且不过」的项 → failed；否则有没量到的项（或一项都没有）→ unverified / incomplete；
 *    全量到全过 → verified。判定函数抛错 → unverified / engine-error。
 *  - open-failed：只有同一个实例打得开对照文档（openError.control === 'opened'）才算文件的问题 → failed。
 *    许可受限、对话框、Word 崩溃都会让好文件的 Open 报错，不能记到文件头上。
 *  - 没装、被占、锁屏、互斥、超时、被对话框挡住 → unverified，原因同名。
 *  - 其余（含各种缺字段）→ unverified / engine-error。 */
export function officeVerificationFromRun<M>(env: OfficeRunnerEnvelope<M>, aspect: OfficeAspect,
  judge: (m: M) => OfficeCheckItem[], okMessage: (m: M) => string): OfficeVerification {
  const subject = env.input;
  const engine = env.engine;
  const skip = SKIP_REASONS[env.outcome];
  if (skip) return officeUnverified(aspect, subject, skip, env.detail || env.outcome, engine);

  if (env.outcome === 'measured' && engine && env.measured !== undefined) {
    let checks: OfficeCheckItem[];
    let ok: string;
    try {
      checks = judge(env.measured);
      ok = okMessage(env.measured);
    } catch (e) {
      return officeUnverified(aspect, subject, 'engine-error', `判定过程出错：${e instanceof Error ? e.message : String(e)}`, engine);
    }
    // 判定函数交回的项里若有「没量到却记成通过」的，按没量到处理，不让它混成通过
    const items = checks.map(c => (c.unmeasured && c.ok ? { ...c, ok: false } : c));
    const bad = items.filter(c => !c.ok && !c.unmeasured);
    const missing = items.filter(c => c.unmeasured);
    if (bad.length > 0) {
      const tail = missing.length > 0 ? `；另有没量到的项：${missing.map(c => c.id).join('、')}` : '';
      const head = bad.length === 1 ? describeCheck(bad[0]) : `${describeCheck(bad[0])}；共 ${bad.length} 项不过（${bad.map(c => c.id).join('、')}）`;
      return officeFailed(aspect, subject, engine, items, head + tail);
    }
    if (missing.length > 0) {
      return officeUnverified(aspect, subject, 'incomplete', `有检查项没有量到：${missing.map(c => c.id).join('、')}`, engine, items);
    }
    if (items.length === 0) return officeUnverified(aspect, subject, 'incomplete', '没有任何检查项', engine, items);
    return officeVerified(aspect, subject, engine, items, ok);
  }

  if (env.outcome === 'open-failed' && engine && env.openError?.control === 'opened') {
    return officeFailed(aspect, subject, engine, [{ id: 'open', ok: false, actual: env.detail }],
      `真实程序打不开这份文件（${env.openError.hresult}）；同一个实例打得开对照文档`);
  }

  const oe = env.openError;
  const extra = oe ? `（${oe.hresult}；对照文档：${oe.control === 'opened' ? '打得开' : oe.control === 'failed' ? '也打不开' : '没有试'}）` : '';
  return officeUnverified(aspect, subject, 'engine-error', `${env.detail || env.outcome}${extra}`, engine);
}
