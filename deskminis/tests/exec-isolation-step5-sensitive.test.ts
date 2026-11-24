/** 执行隔离第 5 步：用户目录下放凭据的位置打「沙箱不许读」的标签（src/minisd/proc/sandbox-sensitive.ts）。
 *  ① 列表与设置：内置项、默认勾选、自己加的路径哪些不能设、要打标签的是哪些。
 *  ② 打标签与还原：先记后打、打完才算数、打到一半的下次整个重打、原本就有的不记、取消的还原、和工作区标签排同一个队。
 *  ③ 打标签脚本：secret / secret-force 两种模式。
 *  ④ 引擎装配与设置页（源码守卫）。
 *  ⑤ Windows 上真跑：打了标签之后沙箱里读不到 .ssh 里的文件和 .npmrc，还原之后又读得到。 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PersistentShell } from '../src/minisd/tools/shell';
import { SANDBOX_LABEL_PS, applyLabels, parseLabelOutput, sandboxEnv, type LabelJob, type LabelResult } from '../src/minisd/proc/sandbox';
import { LabelQueue, WorkspaceLabels, workspaceLabelSkip, workspaceNote } from '../src/minisd/proc/sandbox-workspace';
import {
  SANDBOX_PROTECTED_KEY, SANDBOX_SENSITIVE_KEY, SENSITIVE_ITEMS, SensitiveLabels, itemEnabled, listSensitive, parseSensitivePrefs,
  sensitivePathProblem, wantedSensitive, type ProtectedEntry,
} from '../src/minisd/proc/sandbox-sensitive';

const WIN = process.platform === 'win32';
const ROOT = 'C:\\Users\\me\\AppData\\Roaming\\DeskMinis';
const AGENT = 'C:\\Users\\me\\AppData\\LocalLow\\DeskMinis';
const HOME = 'C:\\Users\\me';
const APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
const SYSDIRS = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
const scope = { root: ROOT, agentRoot: AGENT, home: HOME, systemDirs: SYSDIRS, win: true };
const bases = { home: HOME, appData: APPDATA };

describe('① 列表与设置', () => {
  it('内置项：常见凭据位置默认勾上，.npmrc 默认不勾；不列浏览器目录', () => {
    expect(SANDBOX_SENSITIVE_KEY).toBe('sandbox.sensitive');
    expect(SANDBOX_PROTECTED_KEY).toBe('sandbox.protectedPaths');
    const on = SENSITIVE_ITEMS.filter(i => i.defaultOn).map(i => i.id);
    for (const id of ['ssh', 'git-credentials', 'aws', 'azure', 'kube', 'gh', 'gnupg']) expect(on).toContain(id);
    expect(SENSITIVE_ITEMS.find(i => i.id === 'npmrc')?.defaultOn).toBe(false);
    const all = SENSITIVE_ITEMS.flatMap(i => i.paths(bases)).map(p => p.toLowerCase());
    expect(all).toContain('c:\\users\\me\\.ssh');
    expect(all).toContain('c:\\users\\me\\appdata\\roaming\\github cli');
    expect(all.some(p => /chrome|edge|firefox|mozilla/.test(p))).toBe(false);
    // 每项都有路径，id 不重复
    expect(new Set(SENSITIVE_ITEMS.map(i => i.id)).size).toBe(SENSITIVE_ITEMS.length);
    for (const i of SENSITIVE_ITEMS) expect(i.paths(bases).length).toBeGreaterThan(0);
    // 没有用户目录时不编路径
    expect(SENSITIVE_ITEMS.flatMap(i => i.paths({}))).toEqual([]);
  });

  it('设置读不出来当没设；只认识内置项的 id；extra 只要字符串', () => {
    expect(parseSensitivePrefs(undefined)).toEqual({ on: {}, extra: [] });
    expect(parseSensitivePrefs('not json')).toEqual({ on: {}, extra: [] });
    expect(parseSensitivePrefs(JSON.stringify({ on: { ssh: false, bogus: true, aws: 'no' }, extra: ['D:\\k', 3, ''] }))).toEqual({ on: { ssh: false }, extra: ['D:\\k'] });
    const ssh = SENSITIVE_ITEMS.find(i => i.id === 'ssh')!;
    const npmrc = SENSITIVE_ITEMS.find(i => i.id === 'npmrc')!;
    expect(itemEnabled(ssh, { on: {}, extra: [] })).toBe(true);
    expect(itemEnabled(ssh, { on: { ssh: false }, extra: [] })).toBe(false);
    expect(itemEnabled(npmrc, { on: { npmrc: true }, extra: [] })).toBe(true);
  });

  it('哪些位置不能设：相对路径、agent 目录里、数据目录里、它们的上级、盘根、用户目录、系统目录', () => {
    expect(sensitivePathProblem('D:\\keys', scope)).toBeUndefined();
    expect(sensitivePathProblem('C:\\Users\\me\\.ssh', scope)).toBeUndefined();
    expect(sensitivePathProblem('\\\\server\\share\\k', scope)).toBeUndefined();
    expect(sensitivePathProblem('keys', scope)).toMatch(/完整路径/);
    expect(sensitivePathProblem('D:', scope)).toMatch(/完整路径/);
    expect(sensitivePathProblem(`${AGENT}\\x`, scope)).toMatch(/agent 目录/);
    expect(sensitivePathProblem(`${ROOT}\\x`, scope)).toMatch(/已经挡住/);
    expect(sensitivePathProblem(APPDATA, scope)).toMatch(/上级/);
    expect(sensitivePathProblem('D:\\', scope)).toMatch(/盘的根/);
    expect(sensitivePathProblem('C:\\Users', scope)).toMatch(/上级/);
    expect(sensitivePathProblem('C:\\Program Files\\x', scope)).toMatch(/系统目录/);
  });

  it('要打标签的：勾上了、存在、能设的；去重不分大小写', () => {
    const exists = (p: string) => /\\\.ssh$|\\\.aws$|\\\.npmrc$|^D:\\keys$|^c:\\users\\me\\\.SSH$/i.test(p);
    const prefs = { on: { aws: false }, extra: ['D:\\keys', 'D:\\nope', `${ROOT}\\x`, 'c:\\users\\me\\.SSH'] };
    const l = listSensitive(prefs, bases, scope, exists);
    expect(l.items.find(i => i.id === 'aws')?.enabled).toBe(false);
    expect(l.items.find(i => i.id === 'ssh')?.paths).toEqual([{ path: 'C:\\Users\\me\\.ssh', exists: true }]);
    expect(l.extra.find(v => v.path === `${ROOT}\\x`)?.problem).toMatch(/已经挡住/);
    expect(wantedSensitive(l, true)).toEqual(['C:\\Users\\me\\.ssh', 'D:\\keys']);
    // exists 抛错当不存在
    expect(wantedSensitive(listSensitive({ on: {}, extra: [] }, bases, scope, () => { throw new Error('x'); }), true)).toEqual([]);
  });

  it('工作区在「不许读」的位置里面：不打 Low 标签，说明里讲清楚', () => {
    const s = { ...scope, sensitive: () => ['D:\\keys'] };
    expect(workspaceLabelSkip('d:\\KEYS\\proj', s)).toBe('sensitive');
    expect(workspaceLabelSkip('D:\\other', s)).toBeUndefined();
    expect(workspaceNote('D:\\keys\\proj', 'sensitive')).toContain('沙箱不许读');
  });
});

type Call = LabelJob[];
function fake(outcomes: (job: LabelJob, i: number) => LabelResult) {
  const calls: Call[] = [];
  const apply = async (jobs: LabelJob[]) => { calls.push(jobs.map(j => ({ ...j }))); return jobs.map((j, i) => outcomes(j, i)); };
  return { calls, apply };
}
function store(init: ProtectedEntry[] = []) {
  let v = init;
  const saves: ProtectedEntry[][] = [];
  return { saves, get: () => v, tracked: { load: () => v, save: (l: ProtectedEntry[]) => { v = l; saves.push(l.map(e => ({ ...e }))); } } };
}

describe('② 打标签与还原', () => {
  it('打之前先记 done=false，打完改成 true；结果按路径给', async () => {
    const st = store();
    const f = fake(j => ({ path: j.path, outcome: 'ok' }));
    const sl = new SensitiveLabels({ apply: f.apply, tracked: st.tracked, win: true });
    const r = await sl.sync(['C:\\Users\\me\\.ssh', 'c:\\users\\ME\\.ssh', 'C:\\Users\\me\\.aws']);
    expect(f.calls).toEqual([[{ mode: 'secret', path: 'C:\\Users\\me\\.ssh' }, { mode: 'secret', path: 'C:\\Users\\me\\.aws' }]]);
    expect(st.saves[0]).toEqual([{ path: 'C:\\Users\\me\\.ssh', done: false }, { path: 'C:\\Users\\me\\.aws', done: false }]);
    expect(st.get()).toEqual([{ path: 'C:\\Users\\me\\.ssh', done: true }, { path: 'C:\\Users\\me\\.aws', done: true }]);
    expect(r.results.get('c:\\users\\me\\.ssh')).toEqual({ state: 'protected' });
    expect(r.cleared).toEqual([]);
  });

  it('原本就是这个标签：不记；以前自己打的照旧记着', async () => {
    const st = store([{ path: 'C:\\a', done: true }]);
    const f = fake(j => ({ path: j.path, outcome: 'same' }));
    const r = await new SensitiveLabels({ apply: f.apply, tracked: st.tracked, win: true }).sync(['C:\\a', 'C:\\b']);
    expect(st.get()).toEqual([{ path: 'C:\\a', done: true }]);
    expect(r.results.get('c:\\b')).toEqual({ state: 'protected' });
  });

  it('失败的留着 done=false，下次用 secret-force 整个重打；不支持的、已经没了的不记', async () => {
    const st = store();
    const f = fake(j => j.path === 'C:\\a' ? { path: j.path, outcome: 'err', code: 5 } : j.path === 'E:\\b' ? { path: j.path, outcome: 'unsupported' } : { path: j.path, outcome: 'err', code: 2 });
    const sl = new SensitiveLabels({ apply: f.apply, tracked: st.tracked, win: true });
    const r = await sl.sync(['C:\\a', 'E:\\b', 'C:\\gone']);
    expect(st.get()).toEqual([{ path: 'C:\\a', done: false }]);
    expect(r.results.get('c:\\a')).toEqual({ state: 'failed', code: 5 });
    expect(r.results.get('e:\\b')).toEqual({ state: 'unsupported' });
    expect(r.results.get('c:\\gone')).toEqual({ state: 'missing' });
    const g = fake(j => ({ path: j.path, outcome: 'ok' }));
    await new SensitiveLabels({ apply: g.apply, tracked: st.tracked, win: true }).sync(['C:\\a']);
    expect(g.calls).toEqual([[{ mode: 'secret-force', path: 'C:\\a' }]]);
    expect(st.get()).toEqual([{ path: 'C:\\a', done: true }]);
  });

  it('打完的下次照常用 secret（已经是这个标签就跳过，不再推给子项）', async () => {
    const st = store([{ path: 'C:\\a', done: true }]);
    const f = fake(j => ({ path: j.path, outcome: 'same' }));
    await new SensitiveLabels({ apply: f.apply, tracked: st.tracked, win: true }).sync(['C:\\a']);
    expect(f.calls).toEqual([[{ mode: 'secret', path: 'C:\\a' }]]);
  });

  it('取消勾选的还原；目录没了也算还原；还原失败的留着下次再试；空列表就是全部还原', async () => {
    const st = store([{ path: 'C:\\a', done: true }, { path: 'C:\\b', done: true }, { path: 'C:\\c', done: false }, { path: 'C:\\keep', done: true }]);
    const f = fake(j => j.path === 'C:\\b' ? { path: j.path, outcome: 'err', code: 3 } : j.path === 'C:\\c' ? { path: j.path, outcome: 'err', code: 5 } : { path: j.path, outcome: j.mode === 'clear' ? 'ok' : 'same' });
    const r = await new SensitiveLabels({ apply: f.apply, tracked: st.tracked, win: true }).sync(['C:\\keep']);
    expect(f.calls[0]).toEqual([
      { mode: 'clear', path: 'C:\\a' }, { mode: 'clear', path: 'C:\\b' }, { mode: 'clear', path: 'C:\\c' }, { mode: 'secret', path: 'C:\\keep' },
    ]);
    expect(r.cleared).toEqual(['C:\\a', 'C:\\b']);
    expect(st.get()).toEqual([{ path: 'C:\\c', done: false }, { path: 'C:\\keep', done: true }]);
    const g = fake(j => ({ path: j.path, outcome: 'ok' }));
    const all = await new SensitiveLabels({ apply: g.apply, tracked: st.tracked, win: true }).sync([]);
    expect(g.calls).toEqual([[{ mode: 'clear', path: 'C:\\c' }, { mode: 'clear', path: 'C:\\keep' }]]);
    expect(all.cleared).toEqual(['C:\\c', 'C:\\keep']);
    expect(st.get()).toEqual([]);
  });

  it('没有要做的不起 PowerShell；记录读不出来当空的；apply 抛错也不拒绝', async () => {
    const f = fake(j => ({ path: j.path, outcome: 'ok' }));
    expect((await new SensitiveLabels({ apply: f.apply, tracked: { load: () => { throw new Error('bad'); }, save: () => {} }, win: true }).sync([])).cleared).toEqual([]);
    expect(f.calls).toEqual([]);
    const r = await new SensitiveLabels({ apply: () => Promise.reject(new Error('x')), tracked: store().tracked, win: true }).sync(['C:\\a']);
    expect(r.results.size).toBe(0);
  });

  it('和工作区标签排同一个队：先排的先做完', async () => {
    const q = new LabelQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const wl = new WorkspaceLabels({ ...scope, queue: q, tracked: { load: () => [], save: () => {} },
      apply: async jobs => { order.push('ws-start'); await gate; order.push('ws-end'); return jobs.map(j => ({ path: j.path, outcome: 'ok' as const })); } });
    const sl = new SensitiveLabels({ queue: q, win: true, tracked: store().tracked,
      apply: async jobs => { order.push('secret'); return jobs.map(j => ({ path: j.path, outcome: 'ok' as const })); } });
    const a = wl.prepare('D:\\proj');
    const b = sl.sync(['C:\\Users\\me\\.ssh']);
    await new Promise(r => setImmediate(r));
    expect(order).toEqual(['ws-start']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['ws-start', 'ws-end', 'secret']);
  });
});

describe('③ 打标签脚本', () => {
  it('secret 与 protect 同一个标签；是文件时不带继承旗标；secret-force 不比较现有标签', () => {
    expect(SANDBOX_LABEL_PS).toContain("secret = '(ML;OICI;NRNW;;;ME)'; 'secret-force' = '(ML;OICI;NRNW;;;ME)'");
    expect(SANDBOX_LABEL_PS).toContain("if ($mode.StartsWith('secret') -and -not [IO.Directory]::Exists($path)) { $ace = '(ML;;NRNW;;;ME)' }");
    expect(SANDBOX_LABEL_PS).toContain("$same = $mode -ne 'secret-force' -and (");
    const jobs: LabelJob[] = [{ mode: 'secret', path: 'C:\\a' }, { mode: 'secret-force', path: 'C:\\b' }];
    expect(parseLabelOutput(jobs, '__MINIS_LABEL__ 0 same\n__MINIS_LABEL__ 1 err 5\n')).toEqual([
      { path: 'C:\\a', outcome: 'same' }, { path: 'C:\\b', outcome: 'err', code: 5 },
    ]);
  });
});

describe('④ 引擎装配与设置页（源码守卫）', () => {
  const idx = readFileSync(resolve(__dirname, '..', 'src', 'minisd', 'index.ts'), 'utf8');
  it('敏感位置的标签打完才算开启（ready 才落定）；沙箱没开或开不了时全部还原', () => {
    expect(idx).toMatch(/await syncSensitive\(true\);\s*sandboxState = \{ state: 'on' \};/);
    expect(idx.match(/void syncSensitive\(false\);/g)?.length).toBe(2);
    expect(idx).toContain("save: list => settings.set(SANDBOX_PROTECTED_KEY, JSON.stringify(list))");
    expect(idx).toContain('queue: labelQueue');
  });
  it('sandbox.setSensitive / setSensitiveExtra：校验输入、记审计、沙箱开着时马上照新设置打标签', () => {
    expect(idx).toContain("'sandbox.setSensitive': (p: { id: string; enabled: boolean }) => {");
    expect(idx).toContain("if (prev !== p.enabled) audit.append('sandbox.sensitive', { id: item.id, enabled: p.enabled, prev });");
    expect(idx).toContain("for (const x of list) { const why = sensitivePathProblem(x, labelScope); if (why) throw new Error(`${x}：${why}`); }");
    expect(idx).toContain("if (sandboxState.state === 'on' || sandboxState.state === 'starting') void syncSensitive(true);");
  });
  it('设置「权限」页列出不许读的位置，能勾选、能加自己的路径', () => {
    const vue = readFileSync(resolve(__dirname, '..', 'src', 'renderer', 'src', 'ui', 'settings', 'SecPermission.vue'), 'utf8');
    expect(vue).toContain('沙箱不许读的位置');
    expect(vue).toContain('@change="toggleSensitive(it.id, $event)"');
    expect(vue).toContain('chat.setSandboxSensitiveExtra(');
    const st = readFileSync(resolve(__dirname, '..', 'src', 'renderer', 'src', 'stores', 'chat.ts'), 'utf8');
    expect(st).toContain("rpc.call<UiSandboxStatus>('sandbox.setSensitive', { id, enabled })");
    expect(st).toContain("rpc.call<UiSandboxStatus>('sandbox.setSensitiveExtra', { paths })");
  });
});

describe.runIf(WIN)('⑤ Windows 真跑：不许读的位置', () => {
  const made: string[] = [];
  afterAll(async () => {
    await applyLabels(made.map(path => ({ mode: 'clear' as const, path })));
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('.ssh 目录（含已有的子目录）和 .npmrc 文件：打了标签沙箱里读不到、列不出，还原之后又读得到', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sbx-sens-'));
    made.push(base);
    const agentRoot = join(base, 'agent'); const home = join(base, 'home');
    const ssh = join(home, '.ssh'); const npmrc = join(home, '.npmrc');
    for (const d of [join(agentRoot, 'ws'), join(ssh, 'sub')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(ssh, 'id_test'), 'SSH-PRIVATE-KEY');
    writeFileSync(join(ssh, 'sub', 'deep'), 'SSH-DEEP');
    writeFileSync(npmrc, 'NPM-TOKEN');
    expect((await applyLabels([{ mode: 'low', path: agentRoot }]))[0].outcome).toBe('ok');
    let tracked: ProtectedEntry[] = [];
    const sl = new SensitiveLabels({ apply: jobs => applyLabels(jobs), tracked: { load: () => tracked, save: l => { tracked = l; } }, win: true });
    const sh = new PersistentShell(join(agentRoot, 'ws'), undefined, {}, undefined, { env: sandboxEnv(agentRoot), ready: Promise.resolve(true) });
    const read = async (p: string) => (await sh.run(`Get-Content -LiteralPath '${p}'`, 60_000)).output;
    try {
      expect(await read(join(ssh, 'id_test'))).toContain('SSH-PRIVATE-KEY');

      const r = await sl.sync([ssh, npmrc]);
      expect([...r.results.values()]).toEqual([{ state: 'protected' }, { state: 'protected' }]);
      expect(tracked).toEqual([{ path: ssh, done: true }, { path: npmrc, done: true }]);
      expect(await read(join(ssh, 'id_test'))).not.toContain('SSH-PRIVATE-KEY');
      expect(await read(join(ssh, 'sub', 'deep'))).not.toContain('SSH-DEEP');
      expect(await read(npmrc)).not.toContain('NPM-TOKEN');
      expect((await sh.run(`(Get-ChildItem -LiteralPath '${ssh}' -ErrorAction Stop | Measure-Object).Count`, 60_000)).output).not.toMatch(/^\s*2\s*$/m);
      // 自己（Medium）照常读得到
      expect(readFileSync(join(ssh, 'id_test'), 'utf8')).toBe('SSH-PRIVATE-KEY');
      // 第二次是同一个标签：跳过
      expect((await applyLabels([{ mode: 'secret', path: ssh }, { mode: 'secret', path: npmrc }])).map(x => x.outcome)).toEqual(['same', 'same']);

      expect((await sl.sync([])).cleared).toEqual([ssh, npmrc]);
      expect(tracked).toEqual([]);
      expect(await read(join(ssh, 'sub', 'deep'))).toContain('SSH-DEEP');
      expect(await read(npmrc)).toContain('NPM-TOKEN');
    } finally {
      await sh.dispose('shutdown');
    }
  }, 180_000);
});
