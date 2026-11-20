/** 执行隔离方案第 2 步（上半）：agent 能看到的目录挪出数据根。
 *
 *  1. 会话的四个桶与 shared 在 agent 根里，memory / skills / mcp-servers 与核心数据留在数据根里。
 *  2. agent 根的位置：主进程下发 DESKMINIS_AGENT_DIR；显式给了数据根却没给 agent 根时就是数据根（旧布局）。
 *  3. 启动时把老数据根里的这些目录搬过去：同卷 rename，跨卷复制再删，搬不动的留在原处继续用、下次再搬；检查点记录跟着改。
 *  4. 文件闸认 agent 根：当前会话的桶与 shared 免审，别的会话的桶走卡并点名；搜索跳过落在基准下的 agent 根。 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentRootFromEnv, AGENT_GLOBAL_DIRS, defaultAgentRoot, MinisPaths, sessionBucketDir } from '../src/minisd/paths';
import { migrateAgentDirs, rewriteCheckpointPaths, type MigrateIo } from '../src/minisd/store/agent-dirs-migrate';
import { openDb } from '../src/minisd/store/db';
import { dataGate, dataRootSkipRule, DATA_GATE_NOTES, matchesSkipRule, pathKeyOf, stripWin32Segment } from '../src/minisd/tools/data-gate';
import { resolveAppDirs } from '../src/main/app-dirs';
import { sessionAttachmentPath } from '../src/main/attachments';
import { startMinisd } from '../src/minisd/index';
import { restoreEngineBuiltins } from './engine-wiring';

const dirs: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SID = '11111111-2222-3333-4444-555555555555';
const SID2 = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

function put(path: string, text = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

describe('agent 根的位置', () => {
  it('缺省在 LocalLow 下；非 Windows 回退 HOME/.local/share', () => {
    const local = join('/home/u', 'AppData', 'Local');
    expect(defaultAgentRoot({ LOCALAPPDATA: local }, 'prod')).toBe(join('/home/u', 'AppData', 'LocalLow', 'DeskMinis'));
    expect(defaultAgentRoot({ LOCALAPPDATA: local }, 'dev')).toBe(join('/home/u', 'AppData', 'LocalLow', 'DeskMinis-dev'));
    expect(defaultAgentRoot({ HOME: '/home/u' }, 'prod')).toBe(join('/home/u', '.local', 'share', 'DeskMinis-agent'));
  });

  it('DESKMINIS_AGENT_DIR 优先；显式给了数据根就用数据根；都没给用缺省', () => {
    expect(agentRootFromEnv({ DESKMINIS_AGENT_DIR: '/a', DESKMINIS_DATA_DIR: '/d' }, '/d')).toBe('/a');
    expect(agentRootFromEnv({ DESKMINIS_DATA_DIR: '/d' }, '/d')).toBe('/d');
    expect(agentRootFromEnv({}, '/d', true)).toBe('/d');
    expect(agentRootFromEnv({ DESKMINIS_AGENT_DIR: '', LOCALAPPDATA: '/home/u/AppData/Local' }, '/d')).toBe(join('/home/u/AppData/LocalLow', 'DeskMinis'));
  });

  it('主进程：打包态在 LocalLow，设了 DATA_DIR 就跟着它', () => {
    const env = { APPDATA: '/home/u/AppData/Roaming', LOCALAPPDATA: '/home/u/AppData/Local' };
    expect(resolveAppDirs({ isPackaged: true, env }).agentRoot).toBe(resolve('/home/u/AppData/LocalLow', 'DeskMinis'));
    expect(resolveAppDirs({ isPackaged: false, env }).agentRoot).toBe(resolve('/home/u/AppData/LocalLow', 'DeskMinis-dev'));
    const override = resolveAppDirs({ isPackaged: true, env: { ...env, DESKMINIS_DATA_DIR: '/tmp/x' } });
    expect(override.agentRoot).toBe(override.dataRoot);
  });
});

describe('MinisPaths', () => {
  it('会话桶与 shared 在 agent 根；控制面目录留在数据根', () => {
    const p = new MinisPaths('/data', '/agent');
    expect(p.agentSeparate).toBe(true);
    expect(p.sessionBucket(SID, 'workspace')).toBe(join('/agent', 'sessions', SID, 'workspace'));
    expect(p.workspaceOf(SID)).toBe(join('/agent', 'sessions', SID, 'workspace'));
    expect(p.globalDir('shared')).toBe(join('/agent', 'shared'));
    for (const g of ['memory', 'skills', 'mcp-servers'] as const) expect(p.globalDir(g)).toBe(join('/data', g));
    expect(AGENT_GLOBAL_DIRS).toEqual(['shared']);
  });

  it('只给一个根时布局与以前相同', () => {
    const p = new MinisPaths('/data');
    expect(p.agentSeparate).toBe(false);
    expect(p.sessionBucket(SID, 'attachments')).toBe(join('/data', 'sessions', SID, 'attachments'));
    expect(p.globalDir('shared')).toBe(join('/data', 'shared'));
  });

  it('agent 根里还没有、数据根里的旧桶还在：先用旧桶，定下后不再变', () => {
    const data = tmp('dm-s2-data-');
    const agent = tmp('dm-s2-agent-');
    mkdirSync(join(data, 'sessions', SID, 'workspace'), { recursive: true });
    const p = new MinisPaths(data, agent);
    expect(p.sessionBucket(SID, 'workspace')).toBe(join(data, 'sessions', SID, 'workspace'));
    expect(p.sessionBucket(SID, 'attachments')).toBe(join(agent, 'sessions', SID, 'attachments'));
    // 之后 agent 根里出现了同名桶，本进程照旧用定下的那个
    mkdirSync(join(agent, 'sessions', SID, 'workspace'), { recursive: true });
    expect(p.sessionBucket(SID, 'workspace')).toBe(join(data, 'sessions', SID, 'workspace'));
    // 两处都有时 agent 根优先
    expect(sessionBucketDir(data, agent, SID, 'workspace')).toBe(join(agent, 'sessions', SID, 'workspace'));
  });

  it('主进程存附件用同一条规则', () => {
    const data = tmp('dm-s2-data-');
    const agent = tmp('dm-s2-agent-');
    expect(sessionAttachmentPath({ dataRoot: data, agentRoot: agent }, SID, 1, 'png', 'abcdef01'))
      .toBe(join(agent, 'sessions', SID, 'attachments', 'paste-1-abcdef01.png'));
    mkdirSync(join(data, 'sessions', SID, 'attachments'), { recursive: true });
    expect(sessionAttachmentPath({ dataRoot: data, agentRoot: agent }, SID, 1, 'png'))
      .toBe(join(data, 'sessions', SID, 'attachments', 'paste-1.png'));
    expect(() => sessionAttachmentPath({ dataRoot: data, agentRoot: agent }, '../x', 1)).toThrow();
  });
});

describe('启动时搬目录', () => {
  function seed(data: string): void {
    put(join(data, 'sessions', SID, 'workspace', 'src', 'a.txt'), 'A');
    put(join(data, 'sessions', SID, 'attachments', 'paste-1.png'), 'P');
    put(join(data, 'sessions', SID, 'offloads', 'o.txt'), 'O');
    put(join(data, 'sessions', SID, 'note.txt'), 'N'); // 桶以外的东西不搬
    put(join(data, 'sessions', SID2, 'workspace', 'b.txt'), 'B');
    put(join(data, 'shared', 's.txt'), 'S');
    put(join(data, 'memory', 'GLOBAL.md'), 'M');
    put(join(data, 'providers.json'), '{}');
  }

  it('四个桶与 shared 搬到 agent 根，其余留在数据根', () => {
    const data = tmp('dm-s2-data-');
    const agent = tmp('dm-s2-agent-');
    seed(data);
    const r = migrateAgentDirs(data, agent);
    expect(r.failed).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(readFileSync(join(agent, 'sessions', SID, 'workspace', 'src', 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(agent, 'sessions', SID, 'attachments', 'paste-1.png'), 'utf8')).toBe('P');
    expect(readFileSync(join(agent, 'sessions', SID, 'offloads', 'o.txt'), 'utf8')).toBe('O');
    expect(readFileSync(join(agent, 'sessions', SID2, 'workspace', 'b.txt'), 'utf8')).toBe('B');
    expect(readFileSync(join(agent, 'shared', 's.txt'), 'utf8')).toBe('S');
    expect(existsSync(join(data, 'sessions', SID, 'workspace'))).toBe(false);
    expect(existsSync(join(data, 'sessions', SID2))).toBe(false); // 搬空的会话目录删掉
    expect(existsSync(join(data, 'shared'))).toBe(false);
    expect(readFileSync(join(data, 'sessions', SID, 'note.txt'), 'utf8')).toBe('N');
    expect(existsSync(join(data, 'memory', 'GLOBAL.md'))).toBe(true);
    expect(existsSync(join(data, 'providers.json'))).toBe(true);
    expect(existsSync(join(agent, 'memory'))).toBe(false);
    expect(r.moved).toHaveLength(5);
    // 再跑一次什么都不做
    expect(migrateAgentDirs(data, agent)).toEqual({ moved: [], conflicts: [], failed: [] });
  });

  it('数据根与 agent 根相同：什么都不做', () => {
    const data = tmp('dm-s2-data-');
    seed(data);
    expect(migrateAgentDirs(data, data)).toEqual({ moved: [], conflicts: [], failed: [] });
    expect(existsSync(join(data, 'sessions', SID, 'workspace', 'src', 'a.txt'))).toBe(true);
  });

  it('目标已在：逐项并入，同名的留在原处', () => {
    const data = tmp('dm-s2-data-');
    const agent = tmp('dm-s2-agent-');
    put(join(data, 'sessions', SID, 'workspace', 'a.txt'), 'old');
    put(join(data, 'sessions', SID, 'workspace', 'b.txt'), 'B');
    put(join(agent, 'sessions', SID, 'workspace', 'a.txt'), 'new');
    const r = migrateAgentDirs(data, agent);
    expect(r.conflicts).toEqual([join(data, 'sessions', SID, 'workspace', 'a.txt')]);
    expect(readFileSync(join(agent, 'sessions', SID, 'workspace', 'a.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(agent, 'sessions', SID, 'workspace', 'b.txt'), 'utf8')).toBe('B');
    expect(readFileSync(join(data, 'sessions', SID, 'workspace', 'a.txt'), 'utf8')).toBe('old');
  });

  const realRename = (from: string, to: string): void => { renameSync(from, to); };
  const realCopy = (from: string, to: string): void => { cpSync(from, to, { recursive: true }); };

  it('跨卷：复制再删', () => {
    const data = tmp('dm-s2-data-');
    const agent = tmp('dm-s2-agent-');
    seed(data);
    const exdev = (): never => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };
    const io: MigrateIo = { rename: exdev, copyDir: realCopy };
    const r = migrateAgentDirs(data, agent, io);
    expect(r.failed).toEqual([]);
    expect(readFileSync(join(agent, 'sessions', SID, 'workspace', 'src', 'a.txt'), 'utf8')).toBe('A');
    expect(existsSync(join(data, 'sessions', SID, 'workspace'))).toBe(false);
  });

  it('跨卷复制失败：不留半截，旧桶原样留着并继续用', () => {
    const data = tmp('dm-s2-data-');
    const agent = tmp('dm-s2-agent-');
    seed(data);
    const io: MigrateIo = {
      rename: () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); },
      copyDir: (_f, to) => { mkdirSync(to, { recursive: true }); writeFileSync(join(to, 'half'), ''); throw new Error('disk full'); },
    };
    const r = migrateAgentDirs(data, agent, io);
    expect(r.failed.length).toBe(5);
    expect(existsSync(join(agent, 'sessions', SID, 'workspace'))).toBe(false);
    expect(readFileSync(join(data, 'sessions', SID, 'workspace', 'src', 'a.txt'), 'utf8')).toBe('A');
    expect(new MinisPaths(data, agent).workspaceOf(SID)).toBe(join(data, 'sessions', SID, 'workspace'));
  });

  it('被占用搬不动（EBUSY）：留在原处，其余照搬', () => {
    const data = tmp('dm-s2-data-');
    const agent = tmp('dm-s2-agent-');
    seed(data);
    const io: MigrateIo = {
      rename: (from, to) => { if (from.endsWith('workspace') && from.includes(SID)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); realRename(from, to); },
      copyDir: realCopy,
    };
    const r = migrateAgentDirs(data, agent, io);
    expect(r.failed.map(f => f.path)).toEqual([join(data, 'sessions', SID, 'workspace')]);
    expect(existsSync(join(agent, 'sessions', SID, 'attachments', 'paste-1.png'))).toBe(true);
    const p = new MinisPaths(data, agent);
    expect(p.workspaceOf(SID)).toBe(join(data, 'sessions', SID, 'workspace'));
    expect(p.sessionBucket(SID, 'attachments')).toBe(join(agent, 'sessions', SID, 'attachments'));
    // 下次启动不再占用：补搬
    expect(migrateAgentDirs(data, agent).moved).toEqual([{ from: join(data, 'sessions', SID, 'workspace'), to: join(agent, 'sessions', SID, 'workspace') }]);
  });

  it('检查点记录改到新位置；还在原处的不动', () => {
    const data = tmp('dm-s2-data-');
    const agent = tmp('dm-s2-agent-');
    put(join(data, 'sessions', SID, 'workspace', 'a.txt'), 'A');
    put(join(data, 'sessions', SID, 'workspace', 'keep.txt'), 'K');
    put(join(agent, 'sessions', SID, 'workspace', 'keep.txt'), 'other'); // 同名冲突：keep.txt 留在原处
    const db = openDb(join(data, 'minis.db'));
    try {
      const ins = db.prepare(`INSERT INTO file_checkpoints (id, session_id, requested_path, path, path_key, state, before_exists, after_hash, after_size, tmp_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'applied', 1, 'h', 1, ?, 0, 0)`);
      const oldA = join(data, 'sessions', SID, 'workspace', 'a.txt');
      const oldKeep = join(data, 'sessions', SID, 'workspace', 'keep.txt');
      const elsewhere = join(data, 'elsewhere.txt');
      ins.run('c1', SID, 'a.txt', oldA, pathKeyOf(oldA), join(data, 'sessions', SID, 'workspace', '.a.tmp'));
      ins.run('c2', SID, 'keep.txt', oldKeep, pathKeyOf(oldKeep), null);
      ins.run('c3', SID, 'e.txt', elsewhere, pathKeyOf(elsewhere), null);
      const r = migrateAgentDirs(data, agent);
      expect(rewriteCheckpointPaths(db, r.moved)).toBe(1);
      const rows = db.prepare('SELECT id, path, path_key, tmp_path FROM file_checkpoints ORDER BY id').all() as Array<{ id: string; path: string; path_key: string; tmp_path: string | null }>;
      const newA = join(agent, 'sessions', SID, 'workspace', 'a.txt');
      expect(rows[0]).toEqual({ id: 'c1', path: newA, path_key: pathKeyOf(newA), tmp_path: join(agent, 'sessions', SID, 'workspace', '.a.tmp') });
      expect(rows[1].path).toBe(oldKeep);
      expect(rows[2].path).toBe(elsewhere);
    } finally {
      db.close();
    }
  });
});

describe('文件闸认 agent 根', () => {
  const scope = { root: 'C:\\Users\\u\\AppData\\Roaming\\DeskMinis', agentRoot: 'C:\\Users\\u\\AppData\\LocalLow\\DeskMinis', sessionId: SID, workspace: `C:\\Users\\u\\AppData\\LocalLow\\DeskMinis\\sessions\\${SID}\\workspace` };
  const W = { platform: 'win32' as const };
  const A = scope.agentRoot;

  it.each([
    [`${A}\\sessions\\${SID}\\workspace\\a.txt`, 'write'],
    [`${A}\\sessions\\${SID.toLowerCase()}\\attachments\\p.png`, 'read'],
    [`${A}\\sessions\\${SID}\\offloads\\o.txt`, 'read'],
    [`${A}\\shared\\x.txt`, 'write'],
  ] as const)('%s（%s）免审', (p, op) => {
    expect(dataGate(p, scope, op, W)).toEqual({ verdict: 'free' });
  });

  it('别的会话的桶：走卡并点名', () => {
    expect(dataGate(`${A}\\sessions\\${SID2}\\workspace\\b.txt`, scope, 'read', W)).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.otherSessionRead(SID2) });
    expect(dataGate(`${A}\\sessions\\${SID2}\\workspace\\b.txt`, scope, 'write', W)).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.otherSessionWrite(SID2) });
  });

  it('agent 根里其余的路径按应用数据走卡', () => {
    expect(dataGate(`${A}\\stray.txt`, scope, 'write', W)).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.appDataWrite });
    expect(dataGate(`${A}\\sessions\\${SID}\\note.txt`, scope, 'read', W)).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.appDataRead });
  });

  it('数据根的规则照旧（核心数据硬拒）', () => {
    expect(dataGate(`${scope.root}\\providers.json`, scope, 'write', W).verdict).toBe('deny');
    expect(dataGate(`${scope.root}\\skills\\x\\SKILL.md`, scope, 'write', W)).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.skillsWrite });
  });

  it('工作区外的普通路径照旧走卡、不带说明', () => {
    expect(dataGate('C:\\Users\\u\\Documents\\x.txt', scope, 'read', W)).toEqual({ verdict: 'ask' });
  });

  it('搜索：数据根与 agent 根都落在基准下时都跳过', () => {
    const rule = dataRootSkipRule('C:\\Users\\u', [scope.root, scope.agentRoot], W);
    expect(rule).toEqual({ target: 'appdata/roaming/deskminis', win: true, more: ['appdata/locallow/deskminis'] });
    expect(matchesSkipRule(rule!, 'AppData/LocalLow/DeskMinis', stripWin32Segment)).toBe(true);
    expect(matchesSkipRule(rule!, 'AppData/Roaming/DeskMinis', stripWin32Segment)).toBe(true);
    expect(matchesSkipRule(rule!, 'AppData/LocalLow', stripWin32Segment)).toBe(false);
    // 只有一个根落在基准下：与以前同形
    expect(dataRootSkipRule('C:\\Users\\u\\AppData\\LocalLow', [scope.root, scope.agentRoot], W)).toEqual({ target: 'deskminis', win: true });
  });
});

describe('引擎启动时搬目录', () => {
  beforeAll(() => {
    process.env.DESKMINIS_TEST = '1';
    process.env.DESKMINIS_FAKE_PROVIDER = '1';
  });
  afterEach(() => restoreEngineBuiltins());

  it('给了 agentDir：老数据根里的会话桶搬过去', async () => {
    const data = tmp('dm-s2-eng-data-');
    const agent = tmp('dm-s2-eng-agent-');
    put(join(data, 'sessions', SID, 'workspace', 'a.txt'), 'A');
    const srv = await startMinisd({ dataDir: data, agentDir: agent, host: '127.0.0.1', port: 0 });
    try {
      expect(readFileSync(join(agent, 'sessions', SID, 'workspace', 'a.txt'), 'utf8')).toBe('A');
      expect(existsSync(join(data, 'sessions', SID, 'workspace'))).toBe(false);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it('只给 dataDir：布局不变', async () => {
    const data = tmp('dm-s2-eng-data-');
    put(join(data, 'sessions', SID, 'workspace', 'a.txt'), 'A');
    const srv = await startMinisd({ dataDir: data, host: '127.0.0.1', port: 0 });
    try {
      expect(existsSync(join(data, 'sessions', SID, 'workspace', 'a.txt'))).toBe(true);
    } finally {
      await srv.close();
    }
  }, 30_000);
});
