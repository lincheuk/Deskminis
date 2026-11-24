/**
 * 执行隔离第 3 步（三）：沙箱里用到的、agent 根以外的工作区，打上 Low 标签；不再用了还原。
 *
 * 为什么：Low 进程写不了没有标签的目录（默认就是隐式的 Medium + NO_WRITE_UP）。会话绑定到用户自己的项目目录时，
 * 沙箱里的 git、npm 都写不进去。于是在这个目录里第一次跑命令之前（ShellSandbox.workspace），给它打和 agent 根一样的
 * Low 标签（带继承，系统会推给已有的子项：大目录要一会儿，命令等着）。
 *
 * 不打的：数据目录里面、数据目录或 agent 根的上级、整个盘的根、用户目录本身、系统目录。这些打了 Low 等于让沙箱写满一大片，
 * 不打就照原样写不了，第一次在那里跑命令时在输出前面说清楚，要写就用 sandbox: false。
 *
 * 还原：自己打上的（结论是 ok 的）记在 settings 表里（tracked）。reconcile(正在用的) 把记着的、已经没有会话在用的去掉标签
 * 再从记录里删掉。启动时跑一次（沙箱没开就按「都不用了」全部还原），改工作区之后也跑。原本就是这个标签的（same）不记，也不去动。
 * 打标签与还原排成一队，不会对同一个目录一边打一边去。敏感目录的标签（proc/sandbox-sensitive.ts）排在同一队里（LabelQueue）。
 */
import { posix, win32 } from 'node:path';
import type { LabelJob, LabelResult } from './sandbox';

/** 自己打过标签、还没还原的工作区，存在 settings 表的这个键下（JSON 字符串数组）。 */
export const SANDBOX_LABELED_KEY = 'sandbox.labeledWorkspaces';

/** 不打标签的原因。agent-root 是本来就在 agent 根里（已经可写），不用说明。 */
export type WorkspaceSkip = 'agent-root' | 'data-root' | 'ancestor' | 'drive-root' | 'home' | 'system' | 'sensitive';

export interface WorkspaceScope {
  root: string;
  agentRoot: string;
  /** 用户目录（%USERPROFILE%）。 */
  home?: string;
  /** 系统目录：%SystemRoot%、Program Files（两个）、ProgramData。 */
  systemDirs?: readonly string[];
  /** 按 Windows 的规矩比较路径（不分大小写、反斜杠）。 */
  win: boolean;
  /** 设成「沙箱不许读」的目录（proc/sandbox-sensitive.ts）：在它们里面的工作区不打 Low 标签。随设置变，所以是函数。 */
  sensitive?: () => readonly string[];
}

/** 打标签的进程排成一队：同一时刻只有一个打标签的 PowerShell，先排的先做完。工作区与敏感目录共用一个。 */
export class LabelQueue {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export function pathOps(win: boolean): { norm: (p: string) => string; inside: (child: string, parent: string) => boolean; isDriveRoot: (p: string) => boolean } {
  const P = win ? win32 : posix;
  const norm = (p: string): string => { const r = P.resolve(p); return win ? r.toLowerCase() : r; };
  const inside = (child: string, parent: string): boolean => {
    const r = P.relative(norm(parent), norm(child));
    return r === '' || (!r.startsWith('..') && !P.isAbsolute(r));
  };
  const isDriveRoot = (p: string): boolean => { const r = P.resolve(p); return P.dirname(r) === r; };
  return { norm, inside, isDriveRoot };
}

/** 这个工作区打不打标签；不打时给原因。 */
export function workspaceLabelSkip(dir: string, s: WorkspaceScope): WorkspaceSkip | undefined {
  const { inside, isDriveRoot } = pathOps(s.win);
  if (inside(dir, s.agentRoot)) return 'agent-root';
  if (inside(dir, s.root)) return 'data-root';
  if (inside(s.root, dir) || inside(s.agentRoot, dir)) return 'ancestor';
  if (isDriveRoot(dir)) return 'drive-root';
  if (s.home !== undefined && s.home !== '' && inside(s.home, dir)) return 'home';
  if ((s.systemDirs ?? []).some(d => d !== '' && inside(dir, d))) return 'system';
  if ((s.sensitive?.() ?? []).some(d => d !== '' && inside(dir, d))) return 'sensitive';
  return undefined;
}

const SKIP_TEXT: Record<Exclude<WorkspaceSkip, 'agent-root'>, string> = {
  'data-root': '在 DeskMinis 的数据目录里',
  ancestor: '是 DeskMinis 数据目录的上级目录',
  'drive-root': '是整个盘的根目录',
  home: '是用户目录或它的上级',
  system: '在系统目录里',
  sensitive: '在设为「沙箱不许读」的目录里',
};
const OUTSIDE_HINT = '确实要在这里写，用 sandbox: false 在沙箱外运行（每次都要用户确认）';

/** 第一次在这个工作区跑命令时附在输出前面的话。 */
export function workspaceNote(dir: string, why: Exclude<WorkspaceSkip, 'agent-root'> | 'unsupported' | { code: number }): string {
  if (why === 'unsupported') return `[命令隔离：工作区 ${dir} 所在的盘不支持完整性标签（FAT、exFAT 或网络盘），沙箱里的命令可能写不了它。${OUTSIDE_HINT}]`;
  if (typeof why === 'object') return `[命令隔离：给工作区 ${dir} 打沙箱可写的标签失败（错误码 ${why.code}），沙箱里的命令可能写不了它，下一条命令会再试。${OUTSIDE_HINT}]`;
  return `[命令隔离：工作区 ${dir} ${SKIP_TEXT[why]}，不给它打沙箱可写的标签，沙箱里的命令写不了它。${OUTSIDE_HINT}]`;
}

export interface WorkspaceLabelDeps extends WorkspaceScope {
  /** 打标签（生产是 applyLabels，带较长的超时）。从不拒绝。 */
  apply: (jobs: LabelJob[]) => Promise<LabelResult[]>;
  /** 自己打过标签、还没还原的目录（生产存在 settings 表里）。 */
  tracked: { load(): string[]; save(list: string[]): void };
  log?: (m: string) => void;
  /** 和敏感目录共用的队列；不给就自己建一个。 */
  queue?: LabelQueue;
}

export class WorkspaceLabels {
  private readonly q: LabelQueue;
  /** 已经处理过（或正在处理）的目录：键是规范化后的路径，值是要附的说明。 */
  private done = new Map<string, Promise<string | undefined>>();
  private readonly ops: ReturnType<typeof pathOps>;

  constructor(private readonly d: WorkspaceLabelDeps) { this.ops = pathOps(d.win); this.q = d.queue ?? new LabelQueue(); }

  private queue<T>(fn: () => Promise<T>): Promise<T> { return this.q.run(fn); }

  private loadTracked(): string[] {
    try { const l = this.d.tracked.load(); return Array.isArray(l) ? l.filter(x => typeof x === 'string' && x !== '') : []; } catch { return []; }
  }

  private saveTracked(list: string[]): void {
    try { this.d.tracked.save(list); } catch (e) { this.d.log?.(`命令隔离：记不下打过标签的工作区：${e instanceof Error ? e.message : String(e)}`); }
  }

  /** 命令要在 dir 里跑之前调用。返回要附在输出前面的说明，没有就是 undefined。从不拒绝。 */
  prepare(dir: string): Promise<string | undefined> {
    const key = this.ops.norm(dir);
    const hit = this.done.get(key);
    if (hit) return hit;
    const skip = workspaceLabelSkip(dir, this.d);
    if (skip !== undefined) {
      const note = Promise.resolve(skip === 'agent-root' ? undefined : workspaceNote(dir, skip));
      this.done.set(key, note);
      return note;
    }
    const p = this.queue(async () => {
      const [r] = await this.d.apply([{ mode: 'low', path: dir }]);
      if (r?.outcome === 'ok') {
        const list = this.loadTracked();
        if (!list.some(x => this.ops.norm(x) === key)) this.saveTracked([...list, dir]);
        return undefined;
      }
      if (r?.outcome === 'same') return undefined;
      if (r?.outcome === 'unsupported') return workspaceNote(dir, 'unsupported');
      this.done.delete(key); // 失败的下次再试
      const code = r?.outcome === 'err' ? r.code : -1;
      this.d.log?.(`命令隔离：给工作区 ${dir} 打标签失败（错误码 ${code}）`);
      return workspaceNote(dir, { code });
    }).catch(() => { this.done.delete(key); return undefined; });
    this.done.set(key, p);
    return p;
  }

  /** 把记着的、不在 inUse 里的目录去掉标签。返回还原了的目录。从不拒绝。 */
  reconcile(inUse: Iterable<string>): Promise<string[]> {
    const keep = new Set([...inUse].map(x => this.ops.norm(x)));
    return this.queue(async () => {
      const list = this.loadTracked();
      const stale = list.filter(x => !keep.has(this.ops.norm(x)));
      if (stale.length === 0) return [];
      const results = await this.d.apply(stale.map(path => ({ mode: 'clear' as const, path })));
      const cleared = new Set<string>();
      stale.forEach((path, i) => {
        const r = results[i];
        // 目录已经没了（2 / 3：找不到文件 / 路径）也算还原了，不然记录里永远删不掉
        if (r?.outcome === 'ok' || r?.outcome === 'same' || (r?.outcome === 'err' && (r.code === 2 || r.code === 3))) cleared.add(this.ops.norm(path));
        else this.d.log?.(`命令隔离：还原工作区 ${path} 的标签失败（${r?.outcome === 'err' ? `错误码 ${r.code}` : r?.outcome ?? '没有结果'}），下次启动再试`);
      });
      for (const k of cleared) this.done.delete(k);
      this.saveTracked(this.loadTracked().filter(x => !cleared.has(this.ops.norm(x))));
      return stale.filter(x => cleared.has(this.ops.norm(x)));
    }).catch(() => []);
  }
}
