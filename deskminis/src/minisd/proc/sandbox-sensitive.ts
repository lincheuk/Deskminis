/**
 * 执行隔离第 5 步（方案文档「第 4 步评估」的选项 1）：用户目录下放凭据的位置打「沙箱不许读」的标签。
 *
 * 为什么：低完整性沙箱挡得住写，挡不住读——没打标签的用户文件，Low 进程照样读得到（真机测过）。.ssh 里的私钥、
 * .aws / .azure / .kube 里的云凭据，被模型一条 `type` 就能读出来。给这些位置打和数据目录一样的标签
 * （显式 Medium + NO_READ_UP | NO_WRITE_UP，目录带继承），沙箱里的命令就读不到了；用户自己的程序都在 Medium，不受影响。
 *
 * 列表在设置「权限」页：内置的几项（SENSITIVE_ITEMS，常见的默认勾上），另可加自己的路径。存在 settings 表 sandbox.sensitive。
 * 改了马上生效（不用重启）。不存在的位置跳过，下次启动再看。
 *
 * 不列浏览器配置目录：Chrome、Edge 的网络进程跑在低完整性的应用容器里，自己要直接读 Cookie 文件，打了标签浏览器会掉登录。
 * .npmrc 默认不勾：里面常有镜像源、代理设置，挡住了沙箱里的 npm 就用不上。
 *
 * 还原：自己打上的记在 settings 表 sandbox.protectedPaths（每项带 done：打标签之前先记 done=false，打完才改 true；
 * 打到一半被打断的，下次用 secret-force 整个重打一遍）。取消勾选、关掉命令隔离、沙箱开不了时，把记着的去掉标签。
 * 原本就是这个标签的（same）不记，也不去动。和工作区标签排在同一个队里（LabelQueue）。
 */
import { win32 } from 'node:path';
import type { LabelJob, LabelResult } from './sandbox';
import { LabelQueue, pathOps, workspaceLabelSkip, type WorkspaceScope } from './sandbox-workspace';

/** 设置：每项开没开（只存改过的）、自己加的路径。JSON。 */
export const SANDBOX_SENSITIVE_KEY = 'sandbox.sensitive';
/** 自己打过「不许读」标签、还没还原的位置。JSON 数组，每项 { path, done }。 */
export const SANDBOX_PROTECTED_KEY = 'sandbox.protectedPaths';
/** 自己加的路径最多几条。 */
export const SENSITIVE_EXTRA_MAX = 50;

export interface SensitiveBases {
  /** %USERPROFILE% */
  home?: string;
  /** %APPDATA%（Roaming） */
  appData?: string;
}

export interface SensitiveItem {
  id: string;
  label: string;
  defaultOn: boolean;
  /** 挡住之后会有什么影响（设置页上显示）。 */
  note?: string;
  paths: (b: SensitiveBases) => string[];
}

const inHome = (...p: string[]) => (b: SensitiveBases): string[] => b.home ? [win32.join(b.home, ...p)] : [];
const inAppData = (...p: string[]) => (b: SensitiveBases): string[] => b.appData ? [win32.join(b.appData, ...p)] : [];
const both = (...fs: Array<(b: SensitiveBases) => string[]>) => (b: SensitiveBases): string[] => fs.flatMap(f => f(b));

export const SENSITIVE_ITEMS: readonly SensitiveItem[] = [
  { id: 'ssh', label: 'SSH 密钥（.ssh）', defaultOn: true, paths: inHome('.ssh'), note: '沙箱里的 ssh 和走 ssh 的 git push / pull 会失败，改用 https 远程地址，或让它在沙箱外运行' },
  { id: 'git-credentials', label: 'Git 明文凭据（.git-credentials）', defaultOn: true, paths: inHome('.git-credentials'), note: '用 credential.helper=store 的话，沙箱里的 git 拿不到密码；Git Credential Manager 不受影响' },
  { id: 'netrc', label: '.netrc / _netrc', defaultOn: true, paths: both(inHome('.netrc'), inHome('_netrc')) },
  { id: 'aws', label: 'AWS（.aws）', defaultOn: true, paths: inHome('.aws') },
  { id: 'azure', label: 'Azure CLI（.azure）', defaultOn: true, paths: inHome('.azure') },
  { id: 'gcloud', label: 'Google Cloud（gcloud）', defaultOn: true, paths: both(inAppData('gcloud'), inHome('.config', 'gcloud')) },
  { id: 'kube', label: 'Kubernetes（.kube）', defaultOn: true, paths: inHome('.kube') },
  { id: 'docker', label: 'Docker（.docker）', defaultOn: true, paths: inHome('.docker') },
  { id: 'gh', label: 'GitHub CLI', defaultOn: true, paths: inAppData('GitHub CLI') },
  { id: 'gnupg', label: 'GnuPG 私钥', defaultOn: true, paths: both(inHome('.gnupg'), inAppData('gnupg')) },
  { id: 'cargo', label: 'Cargo 凭据', defaultOn: true, paths: both(inHome('.cargo', 'credentials.toml'), inHome('.cargo', 'credentials')) },
  { id: 'pypirc', label: 'PyPI 上传凭据（.pypirc）', defaultOn: true, paths: inHome('.pypirc') },
  { id: 'npmrc', label: 'npm 配置（.npmrc）', defaultOn: false, paths: inHome('.npmrc'), note: '里面可能有发布用的 token，但也常有镜像源、代理设置：勾上之后沙箱里的 npm 用不上这些设置' },
];

export interface SensitivePrefs {
  /** 改过的项：id → 开没开。没改过的按 defaultOn。 */
  on: Record<string, boolean>;
  extra: string[];
}

export function parseSensitivePrefs(raw: string | undefined): SensitivePrefs {
  const out: SensitivePrefs = { on: {}, extra: [] };
  if (!raw) return out;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return out;
    const o = v as { on?: unknown; extra?: unknown };
    if (o.on && typeof o.on === 'object') {
      for (const [k, b] of Object.entries(o.on as Record<string, unknown>)) if (typeof b === 'boolean' && SENSITIVE_ITEMS.some(i => i.id === k)) out.on[k] = b;
    }
    if (Array.isArray(o.extra)) out.extra = o.extra.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, SENSITIVE_EXTRA_MAX);
  } catch { /* 读不出来当没设 */ }
  return out;
}

export function itemEnabled(item: SensitiveItem, prefs: SensitivePrefs): boolean {
  return prefs.on[item.id] ?? item.defaultOn;
}

const PROBLEM_TEXT: Record<string, string> = {
  'agent-root': '在 agent 目录里，挡住了 agent 自己的工作区也读不了',
  'data-root': '在 DeskMinis 的数据目录里，已经挡住了',
  ancestor: '是数据目录或 agent 目录的上级目录',
  'drive-root': '是整个盘的根目录',
  home: '是用户目录或它的上级',
  system: '在系统目录里',
};

/** 这个位置能不能设成「不许读」；不能时给原因（给人看的话）。内置项和自己加的都过一遍。 */
export function sensitivePathProblem(path: string, scope: WorkspaceScope): string | undefined {
  const absolute = scope.win ? /^([a-z]:[\\/]|\\\\[^\\])/i.test(path) : path.startsWith('/');
  if (!absolute) return '要写完整路径（如 D:\\secrets）';
  const skip = workspaceLabelSkip(path, { ...scope, sensitive: undefined });
  return skip === undefined ? undefined : PROBLEM_TEXT[skip];
}

export interface SensitivePathView { path: string; exists: boolean; problem?: string }
export interface SensitiveListing {
  items: Array<{ id: string; label: string; note?: string; defaultOn: boolean; enabled: boolean; paths: SensitivePathView[] }>;
  extra: SensitivePathView[];
}

/** 按设置列出所有位置：存不存在、能不能设。 */
export function listSensitive(prefs: SensitivePrefs, bases: SensitiveBases, scope: WorkspaceScope, exists: (p: string) => boolean): SensitiveListing {
  const view = (path: string): SensitivePathView => {
    const problem = sensitivePathProblem(path, scope);
    let ex = false;
    try { ex = exists(path); } catch { ex = false; }
    return problem ? { path, exists: ex, problem } : { path, exists: ex };
  };
  return {
    items: SENSITIVE_ITEMS.map(i => ({ id: i.id, label: i.label, ...(i.note ? { note: i.note } : {}), defaultOn: i.defaultOn, enabled: itemEnabled(i, prefs), paths: i.paths(bases).map(view) })),
    extra: prefs.extra.map(view),
  };
}

/** 要打标签的位置：勾上了、存在、能设的。按 Windows 规矩去重。 */
export function wantedSensitive(l: SensitiveListing, win: boolean): string[] {
  const { norm } = pathOps(win);
  const seen = new Set<string>();
  const out: string[] = [];
  const take = (v: SensitivePathView): void => {
    if (!v.exists || v.problem) return;
    const k = norm(v.path);
    if (seen.has(k)) return;
    seen.add(k); out.push(v.path);
  };
  for (const i of l.items) if (i.enabled) i.paths.forEach(take);
  l.extra.forEach(take);
  return out;
}

export interface ProtectedEntry { path: string; done: boolean }
export type SensitiveState = { state: 'protected' | 'unsupported' | 'missing' } | { state: 'failed'; code: number };

export interface SensitiveLabelDeps {
  /** 打标签（生产是 applyLabels，带较长的超时）。从不拒绝。 */
  apply: (jobs: LabelJob[]) => Promise<LabelResult[]>;
  tracked: { load(): ProtectedEntry[]; save(list: ProtectedEntry[]): void };
  win: boolean;
  queue?: LabelQueue;
  log?: (m: string) => void;
}

export class SensitiveLabels {
  private readonly q: LabelQueue;
  private readonly norm: (p: string) => string;

  constructor(private readonly d: SensitiveLabelDeps) { this.q = d.queue ?? new LabelQueue(); this.norm = pathOps(d.win).norm; }

  private load(): ProtectedEntry[] {
    try {
      const l = this.d.tracked.load();
      return Array.isArray(l) ? l.filter(x => x && typeof x.path === 'string' && x.path !== '').map(x => ({ path: x.path, done: x.done === true })) : [];
    } catch { return []; }
  }

  private save(list: ProtectedEntry[]): void {
    try { this.d.tracked.save(list); } catch (e) { this.d.log?.(`命令隔离：记不下打过「不许读」标签的位置：${e instanceof Error ? e.message : String(e)}`); }
  }

  /**
   * 让打了「不许读」标签的位置正好是 wanted：没打的打上，记着的、不在 wanted 里的去掉标签。
   * wanted 为空就是全部还原（关掉命令隔离、沙箱开不了时）。返回 wanted 里每一项的结果（键是规范化后的路径）与还原了的位置。从不拒绝。
   */
  sync(wanted: readonly string[]): Promise<{ results: Map<string, SensitiveState>; cleared: string[] }> {
    return this.q.run(async () => {
      const results = new Map<string, SensitiveState>();
      const want: string[] = [];
      for (const p of wanted) { const k = this.norm(p); if (!results.has(k)) { results.set(k, { state: 'missing' }); want.push(p); } }
      const before = new Map(this.load().map(e => [this.norm(e.path), e] as const));
      const stale = [...before.values()].filter(e => !results.has(this.norm(e.path)));
      if (want.length === 0 && stale.length === 0) return { results, cleared: [] };
      // 先把要打的记下（done=false）：打到一半引擎被关掉，下次知道要整个重打，关掉命令隔离时也知道要还原
      const now = new Map(before);
      for (const p of want) { const k = this.norm(p); if (!now.has(k)) now.set(k, { path: p, done: false }); }
      this.save([...now.values()]);
      const jobs: LabelJob[] = [
        ...stale.map(e => ({ mode: 'clear' as const, path: e.path })),
        ...want.map(p => { const e = before.get(this.norm(p)); return { mode: e && !e.done ? 'secret-force' as const : 'secret' as const, path: p }; }),
      ];
      const out = await this.d.apply(jobs);
      const cleared: string[] = [];
      jobs.forEach((job, i) => {
        const r = out[i];
        const k = this.norm(job.path);
        const gone = r?.outcome === 'err' && (r.code === 2 || r.code === 3);
        if (job.mode === 'clear') {
          if (r?.outcome === 'ok' || r?.outcome === 'same' || gone) { now.delete(k); cleared.push(job.path); }
          else this.d.log?.(`命令隔离：还原 ${job.path} 的标签失败（${r?.outcome === 'err' ? `错误码 ${r.code}` : r?.outcome ?? '没有结果'}），下次再试`);
          return;
        }
        if (r?.outcome === 'ok') { now.set(k, { path: job.path, done: true }); results.set(k, { state: 'protected' }); }
        else if (r?.outcome === 'same') {
          // 原本就是这个标签：以前是自己打的照旧记着，不是的不记（以后也不去还原）
          if (before.has(k)) now.set(k, { path: job.path, done: true }); else now.delete(k);
          results.set(k, { state: 'protected' });
        } else if (r?.outcome === 'unsupported') { now.delete(k); results.set(k, { state: 'unsupported' }); }
        else if (gone) { now.delete(k); results.set(k, { state: 'missing' }); }
        else {
          // 失败的留着 done=false：下次整个重打，关掉时也会去还原
          const code = r?.outcome === 'err' ? r.code : -1;
          now.set(k, { path: job.path, done: false });
          results.set(k, { state: 'failed', code });
          this.d.log?.(`命令隔离：给 ${job.path} 打「不许读」标签失败（错误码 ${code}），沙箱里的命令可能读得到它`);
        }
      });
      this.save([...now.values()]);
      return { results, cleared };
    }).catch(() => ({ results: new Map<string, SensitiveState>(), cleared: [] }));
  }
}
