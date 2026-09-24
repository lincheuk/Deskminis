/**
 * 技能导入器（设计 §5.1）：GitHub URL（Contents API 同级文件递归、部分成功报告）、
 * ZIP（容忍一层包装目录）、本地文件夹、agent 直写目录孤儿回收。
 * 导入是脱离 UI 生命周期的后台任务：startImport 立即返回 taskId，进度靠 status 轮询
 * + onProgress 推送。SKILL.md 一律原样落盘，永不改写。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as yauzl from 'yauzl';
import type { SkillStore } from './store';
import { nameFromUrl, parseSkillMd } from './parser';
import {
  createZipBudget, readZipEntry, ZipGuardError, ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL,
  type ZipGuardHit, type ZipLimits,
} from '../office/zip';

/** 手写递归拷贝替代 fs.cpSync：Electron/Windows 的 cpSync 原生实现对非 ASCII 路径会
 *  不可捕获地崩溃（0xE06D7363，进程直接死）；readdirSync/copyFileSync 是老牌 Unicode 安全 API。
 *  symlink 及其他非常规类型刻意跳过：技能目录不该有链接，跟随链接反而有逃逸风险。 */
function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name), d = join(dst, e.name);
    if (e.isDirectory()) copyDirRecursive(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

export type ImportKind = 'github-url' | 'zip' | 'folder';
export interface ImportFailure { name: string; error: string }
export interface ImportProgress {
  taskId: string; kind: ImportKind; source: string;
  state: 'running' | 'done' | 'failed';
  total: number; completed: number;
  succeeded: string[]; failures: ImportFailure[]; error?: string;
}

interface GhContentItem { name: string; path: string; type: string; download_url: string | null }

/** 支持 https://github.com/<owner>/<repo>[/tree/<ref>/<subpath...>]；ref 只取 tree/ 后第一段（带斜杠的分支名不消歧，按第一段处理）。 */
function parseGithubUrl(url: string): { owner: string; repo: string; ref?: string; subpath: string } {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`不是合法 URL: ${url}`); }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') throw new Error(`不是 GitHub URL: ${url}`);
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length < 2) throw new Error(`GitHub URL 缺少 owner/repo: ${url}`);
  const [owner, repoRaw] = segs;
  let ref: string | undefined; let subpath = '';
  if (segs[2] === 'tree' && segs.length >= 4) { ref = segs[3]; subpath = segs.slice(4).join('/'); }
  else if (segs.length > 2) subpath = segs.slice(2).join('/');
  return { owner, repo: repoRaw.replace(/\.git$/i, ''), ref, subpath };
}

function openZip(buf: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) => yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => err ? rej(err) : res(zf!)));
}

/** 技能包的解压上限（W1a-3，设计稿 §2）：条目数与总量取 office 的同名常量（2000 条 / 64MB）；
 *  单文件 32MB，与市场下载上限（market/install.ts 的 DOWNLOAD_MAX_BYTES）和 tools/office.ts 的 MAX_OFFICE 一致——
 *  技能包里放的是说明与脚本，单个文件到 32MB 已经远超正常用量。 */
export const SKILL_ZIP_LIMITS: ZipLimits = Object.freeze({
  maxEntries: ZIP_MAX_ENTRIES,
  maxTotal: ZIP_MAX_TOTAL,
  maxEntry: 32 * 1024 * 1024,
});

/** 64MB / 512KB 这种整数单位的说法；不整的退回字节数，文案里不出现小数。 */
function fmtBytes(n: number): string {
  if (n > 0 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}MB`;
  if (n > 0 && n % 1024 === 0) return `${n / 1024}KB`;
  return `${n} 字节`;
}

/** 预算闸判定 → 导入任务的 error（技能页原样展示给用户）。 */
function skillGuardText(hit: ZipGuardHit): string {
  switch (hit.kind) {
    case 'entries': return `技能包条目过多（超过 ${hit.limit} 个），已拒绝导入`;
    case 'total': return `技能包解压后总大小超过 ${fmtBytes(hit.limit)}，已拒绝导入`;
    case 'entry': return `技能包内文件 ${hit.name} 解压后超过 ${fmtBytes(hit.limit)}，已拒绝导入`;
    case 'declared': return `技能包内文件 ${hit.name} 解压出的字节多于它声明的 ${hit.declared} 字节，已拒绝导入`;
    case 'short': return `技能包内文件 ${hit.name} 解压出的字节少于它声明的 ${hit.declared} 字节，包可能已损坏，已拒绝导入`;
  }
}

/** 解压到内存（统一正斜杠相对路径）→ 剥一层公共包装目录 → 丢弃穿越/绝对路径项。
 *  已知局限：yauzl 遇穿越项即硬停（emittedError 置位后不再发任何事件），穿越项之后的合法条目会丢失
 *  ——含穿越项的 zip 本就是恶意或损坏的，部分导入可接受；条目序在穿越项之前的（如测试用例）不受影响。
 *  G2 起导出：市场安装链路（installPlan）复用同一解压/防穿越纪律来预告将落盘的文件清单。
 *
 *  W1a-3 起按 limits 三处把关（zip bomb）：① 打开后先看 EOCD 的 entryCount；② 每条在 openReadStream
 *  （inflate）之前按声明尺寸预扣；③ 读流时逐块数实际字节。任何一处越界都整包拒绝，不做部分导入——
 *  超限的包多半是恶意的，留下半截技能反而让人以为导入成功了。 */
export async function unzipToMemory(buf: Buffer, limits: ZipLimits = SKILL_ZIP_LIMITS): Promise<Map<string, Buffer>> {
  const zf = await openZip(buf);
  const budget = createZipBudget(limits);
  const early = budget.checkEntryCount(zf.entryCount);
  if (early) {
    try { zf.close(); } catch { /* 刚打开还没读，关闭失败也无妨 */ }
    throw new Error(skillGuardText(early));
  }
  let out = new Map<string, Buffer>();
  await new Promise<void>((done, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return; settled = true;
      try { zf.close(); } catch { /* 已关闭或读取中，忽略 */ }
      fn();
    };
    zf.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          const isDir = entry.fileName.endsWith('/');
          // 目录项也占计数（大量空目录同样是拖垮解析的手段），但不读字节，按 0 计入总量
          const hit = budget.admit(entry.fileName, isDir ? 0 : entry.uncompressedSize);
          if (hit) throw new ZipGuardError(hit);
          if (isDir) { zf.readEntry(); return; }
          const norm = entry.fileName.replace(/\\/g, '/');
          const data = await readZipEntry(zf, entry, budget.meter(entry.fileName, entry.uncompressedSize));
          out.set(norm, data);
          zf.readEntry();
        } catch (e) {
          settle(() => reject(e instanceof ZipGuardError ? new Error(skillGuardText(e.hit)) : e as Error));
        }
      })();
    });
    zf.on('end', () => settle(done));
    // yauzl 在 _readEntry 阶段对穿越/绝对路径项会 emit 'error'（"invalid relative path"），
    // 且 emittedError 置位后不会再 emit 'entry'/'end' —— 吞掉该错误，用已读到的 entries 收尾。
    // 这些项本就该被丢弃（zip-slip 防护，与下方 cleaned 过滤互为双保险）；其余错误（zip 结构损坏等）仍按失败处理。
    zf.on('error', (err: Error) => {
      if (/^invalid relative path/.test(err.message)) { settle(done); return; }
      settle(() => reject(err));
    });
    zf.readEntry();
  });
  // 一层包装目录：所有路径共享同一首段且都有二级路径 → 剥掉该首段
  const keys = [...out.keys()];
  const firstSegs = new Set(keys.map(k => k.split('/')[0]));
  if (firstSegs.size === 1 && keys.every(k => k.includes('/'))) {
    const seg = [...firstSegs][0];
    const stripped = new Map<string, Buffer>();
    for (const [k, v] of out) stripped.set(k.slice(seg.length + 1), v);
    out = stripped;
  }
  // 归一化 + 穿越/绝对路径项直接丢弃（zip-slip 防护）
  const cleaned = new Map<string, Buffer>();
  for (const [k, v] of out) {
    const parts = k.split('/').filter(p => p !== '' && p !== '.');
    if (parts.some(p => p === '..') || /^[A-Za-z]:/.test(k) || parts.length === 0) continue;
    cleaned.set(parts.join('/'), v);
  }
  return cleaned;
}

export class SkillImporter {
  private tasks = new Map<string, ImportProgress>();

  constructor(
    private skillsRoot: string,
    private store: SkillStore,
    private fetchImpl: typeof fetch = fetch,
    private onProgress?: (t: ImportProgress) => void,
  ) {
    mkdirSync(this.skillsRoot, { recursive: true });
  }

  /** 立即登记任务并返回 taskId；导入在后台跑（脱离 UI 生命周期）。
   *  opts.overwriteId（G4 市场更新流）：zip 导入指定同 id 覆盖重装——技能目录原位覆盖、
   *  SkillStore 保留 installed_at/use_count/is_enabled（更新不重置使用痕迹）。缺省 uniqueId
   *  全新安装（既有调用方行为不变）。 */
  startImport(kind: ImportKind, source: string, opts?: { overwriteId?: string }): { taskId: string } {
    const taskId = randomUUID().toUpperCase();
    const t: ImportProgress = { taskId, kind, source, state: 'running', total: 0, completed: 0, succeeded: [], failures: [] };
    this.tasks.set(taskId, t);
    void (async () => {
      try {
        if (kind === 'github-url') await this.importGithub(t, source);
        else if (kind === 'zip') await this.importZip(t, source, opts?.overwriteId);
        else await this.importFolder(t, source);
        t.state = 'done';
      } catch (e) {
        t.state = 'failed';
        t.error = e instanceof Error ? e.message : String(e);
      }
      this.emit(t);
    })();
    return { taskId };
  }

  status(taskId: string): ImportProgress | undefined { return this.tasks.get(taskId); }
  listTasks(): ImportProgress[] { return [...this.tasks.values()]; }

  /** 孤儿回收：skillsRoot 下存在但不在表里的含 SKILL.md 目录入库（agent 直写）。返回新入库的 id。 */
  adoptOrphans(): string[] {
    const known = new Set(this.store.list().map(s => s.id));
    const adopted: string[] = [];
    for (const ent of readdirSync(this.skillsRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || known.has(ent.name)) continue;
      const dir = join(this.skillsRoot, ent.name);
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      const meta = parseSkillMd(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
      this.store.upsert({ id: ent.name, meta, fallbackName: ent.name, importSource: 'orphan' });
      adopted.push(ent.name);
    }
    return adopted;
  }

  private emit(t: ImportProgress): void {
    this.onProgress?.({ ...t, succeeded: [...t.succeeded], failures: [...t.failures] });
  }

  /** 把 dir 的技能（含 SKILL.md）解析元数据、复制到 skillsRoot/<id>/、入库。返回技能 id。 */
  private installDir(dir: string, importSource: string, fallbackName: string): string {
    const meta = parseSkillMd(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
    const id = this.store.uniqueId(meta.name ?? fallbackName);
    copyDirRecursive(dir, join(this.skillsRoot, id));
    this.store.upsert({ id, meta, fallbackName, importSource });
    return id;
  }

  /** 把内存文件集（相对路径 → 字节）落成 skillsRoot/<id>/ 并入库。SKILL.md 原样写字节，不改写。
   *  overwriteId（G4）：指定 id 覆盖重装（rmSync 原位清目录后重写；store.upsert 保留
   *  installed_at/use_count/is_enabled）；缺省 uniqueId 全新安装。 */
  private installFiles(files: Map<string, Buffer>, importSource: string, fallbackName: string, overwriteId?: string): string {
    const mdKey = [...files.keys()].find(k => k.toLowerCase() === 'skill.md');
    if (!mdKey) throw new Error('根层没有 SKILL.md');
    const meta = parseSkillMd(files.get(mdKey)!.toString('utf8'));
    const id = overwriteId ?? this.store.uniqueId(meta.name ?? fallbackName);
    const destRoot = join(this.skillsRoot, id);
    rmSync(destRoot, { recursive: true, force: true });
    for (const [rel, data] of files) {
      const dest = join(destRoot, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    }
    this.store.upsert({ id, meta, fallbackName, importSource });
    return id;
  }

  private async importFolder(t: ImportProgress, source: string): Promise<void> {
    const dir = resolve(source);
    if (!existsSync(join(dir, 'SKILL.md'))) throw new Error(`文件夹中没有 SKILL.md: ${dir}`);
    t.total = 1;
    const rel = relative(resolve(this.skillsRoot), dir);
    const insideRoot = rel !== '' && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel);
    if (insideRoot) {
      // 已在 skillsRoot 内（agent 直写目录）：原地入库，不复制（目录名即 id）
      const meta = parseSkillMd(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
      this.store.upsert({ id: basename(dir), meta, fallbackName: basename(dir), importSource: 'folder' });
      t.succeeded.push(basename(dir));
    } else {
      t.succeeded.push(this.installDir(dir, `folder:${dir}`, basename(dir)));
    }
    t.completed = 1;
    this.emit(t);
  }

  private async importZip(t: ImportProgress, source: string, overwriteId?: string): Promise<void> {
    const files = await unzipToMemory(readFileSync(resolve(source)));
    t.total = 1;
    t.succeeded.push(this.installFiles(files, `zip:${basename(source)}`, basename(source).replace(/\.zip$/i, ''), overwriteId));
    t.completed = 1;
    this.emit(t);
  }

  private async ghApi(path: string): Promise<unknown> {
    const r = await this.fetchImpl(`https://api.github.com${path}`, {
      headers: { 'User-Agent': 'deskminis', Accept: 'application/vnd.github+json' },
    });
    // GitHub 对不存在的路径/repo 及未授权的私有库均回 404，三者对导入者同义于「此处无技能」；
    // 401/403/429/5xx 保持抛 HTTP 错误，不掩盖鉴权与限流。
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`GitHub API ${path} → HTTP ${r.status}`);
    return r.json();
  }

  /** 递归下载 Contents API 目录下所有文件（同级文件递归），rel 是相对技能根的路径。 */
  private async ghDownloadDir(owner: string, repo: string, ref: string | undefined, path: string, base: string, out: Map<string, Buffer>): Promise<void> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const items = await this.ghApi(`/repos/${owner}/${repo}/contents/${path}${q}`) as GhContentItem[];
    for (const it of items) {
      const rel = base ? `${base}/${it.name}` : it.name;
      if (it.type === 'dir') await this.ghDownloadDir(owner, repo, ref, it.path, rel, out);
      else if (it.type === 'file' && it.download_url) {
        const r = await this.fetchImpl(it.download_url, { headers: { 'User-Agent': 'deskminis' } });
        if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}: ${rel}`);
        out.set(rel, Buffer.from(await r.arrayBuffer()));
      }
    }
  }

  private async importGithub(t: ImportProgress, source: string): Promise<void> {
    const { owner, repo, ref, subpath } = parseGithubUrl(source);
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const top = await this.ghApi(`/repos/${owner}/${repo}/contents/${subpath}${q}`);
    if (!Array.isArray(top)) throw new Error('该 URL 指向的不是目录');
    const isSkillDir = (items: GhContentItem[]) => items.some(i => i.type === 'file' && i.name.toLowerCase() === 'skill.md');
    // 情况 A：subpath 本身就是技能目录 → 单技能；情况 B：集合目录 → 每个含 SKILL.md 的一级子目录一个技能
    const targets: { path: string; name: string }[] = [];
    if (isSkillDir(top)) {
      targets.push({ path: subpath, name: nameFromUrl(source) });
    } else {
      for (const it of top) {
        if (it.type !== 'dir') continue;
        const items = await this.ghApi(`/repos/${owner}/${repo}/contents/${it.path}${q}`) as GhContentItem[];
        if (isSkillDir(items)) targets.push({ path: it.path, name: it.name });
      }
    }
    if (targets.length === 0) throw new Error('未找到包含 SKILL.md 的目录');
    t.total = targets.length;
    this.emit(t);
    for (const tgt of targets) {
      try {
        const files = new Map<string, Buffer>();
        await this.ghDownloadDir(owner, repo, ref, tgt.path, '', files);
        const id = this.installFiles(files, `github:${owner}/${repo}`, tgt.name);
        t.succeeded.push(id);
      } catch (e) {
        // 部分成功报告：单个技能失败不拖死整批
        t.failures.push({ name: tgt.name, error: e instanceof Error ? e.message : String(e) });
      }
      t.completed++;
      this.emit(t);
    }
  }
}
