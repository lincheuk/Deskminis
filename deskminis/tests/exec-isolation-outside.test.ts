/**
 * 沙箱之外的三处口子（成熟度重评 A1 / A2 / A3）。命令隔离只管得住 shell，下面三条路以前绕得过去：
 *
 *  A1 windows-open 桥：桥由引擎在沙箱外执行，沙箱里的命令写一个 .cmd 再让它打开，就以引擎的级别运行；完全访问档不问。
 *  A2 完全访问档下 file_read 不弹卡就读得到 secrets.vault，而解密的钥匙沙箱里的命令读得到。
 *  A3 完全访问档下文件工具不弹卡就能写工作区外任意位置（MCP 配置、启动文件夹）、读 .ssh 这类「沙箱不许读」的位置。
 *
 * 现在：A2 的三个凭据文件读取硬拒；A1、A3 走已有的「沙箱外每次询问」规则（PermissionRequest.outsideSandbox）——
 * 开着命令隔离时任何档位都弹卡，「本会话允许」也只放这一次；没开命令隔离时一切照旧。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeBridgeDispatcher, openOutsideNote, type BridgeRequest, type PsRunner } from '../src/minisd/bridge/handlers';
import { dataGate, DATA_GATE_NOTES, type DataGateScope } from '../src/minisd/tools/data-gate';
import { guardRead, guardWrite } from '../src/minisd/tools/files';
import { fileGlobTool, fileGrepTool } from '../src/minisd/tools/search';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { PermissionGatewayImpl, type PermissionPreset } from '../src/minisd/tools/permissions';
import { MinisPaths } from '../src/minisd/paths';
import type { PermissionDenied, PermissionRequest, ToolContext } from '../src/minisd/tools/types';

const SESSION = 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789';

/** 真网关 + 记下每张卡的询问函数；answer 是卡上点的那个按钮。 */
function gatewayOf(preset: PermissionPreset, answer: 'allow-once' | 'allow-session' | 'deny' = 'allow-session') {
  const asked: PermissionRequest[] = [];
  const blocked: PermissionDenied[] = [];
  const gateway = new PermissionGatewayImpl(async r => { asked.push(r); return answer; }, undefined, 90000, undefined, { onDenied: (_r, d) => { blocked.push(d); } });
  gateway.applyPreset(preset);
  return { gateway, asked, blocked };
}

/** 数据根与 agent 根分开的布局（开得了命令隔离的那种），外加一个两个根之外的目录。 */
function layout() {
  const base = mkdtempSync(join(tmpdir(), 'dm-outside-'));
  const root = join(base, 'data'); const agentRoot = join(base, 'agent'); const elsewhere = join(base, 'elsewhere');
  for (const d of [root, agentRoot, elsewhere]) mkdirSync(d, { recursive: true });
  const paths = new MinisPaths(root, agentRoot);
  paths.ensureSessionDirs(SESSION);
  return { base, root, agentRoot, elsewhere, paths };
}

describe('A1 windows-open 打开本机文件', () => {
  const runPs: PsRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });
  const open = (target?: string): BridgeRequest => ({ tool: 'windows-open', action: 'open', args: target === undefined ? {} : { target }, sessionId: SESSION });

  it('开着命令隔离：完全访问档下本机文件每次都弹卡，卡上写明目标，「本会话允许」只放这一次；网址不问', async () => {
    const { paths, elsewhere } = layout();
    const file = join(elsewhere, 'run.cmd');
    writeFileSync(file, 'echo hi');
    const { gateway, asked } = gatewayOf('full');
    const dispatch = makeBridgeDispatcher({ permissions: gateway, paths, runPs, sandboxed: () => true });

    expect((await dispatch(open(file))).ok).toBe(true);
    expect((await dispatch(open(file))).ok).toBe(true);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ kind: 'bridge-open', detail: 'windows-open open', outsideSandbox: true, note: openOutsideNote(file) });
    expect(asked[0].note).toContain(file);

    expect((await dispatch(open('https://example.com'))).ok).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it('开着命令隔离：shell 卡带出的桥合并授权盖不住本机文件，网址照旧认', async () => {
    const { paths, elsewhere } = layout();
    const file = join(elsewhere, 'a.html');
    writeFileSync(file, '<p>');
    const { gateway, asked } = gatewayOf('ask', 'deny');
    gateway.grantBridgeSession(SESSION, 'bridge-open');
    const dispatch = makeBridgeDispatcher({ permissions: gateway, paths, runPs, sandboxed: () => true });

    expect((await dispatch(open('https://example.com'))).ok).toBe(true);
    expect(asked).toHaveLength(0);
    const env = await dispatch(open(file));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PERMISSION_DENIED');
    expect(asked).toHaveLength(1);
  });

  it('没开命令隔离：与以前一样，完全访问档不问、卡上不带沙箱外的标记', async () => {
    const { paths, elsewhere } = layout();
    const file = join(elsewhere, 'a.txt');
    writeFileSync(file, 'x');
    for (const sandboxed of [undefined, () => false]) {
      const full = gatewayOf('full');
      expect((await makeBridgeDispatcher({ permissions: full.gateway, paths, runPs, sandboxed })(open(file))).ok).toBe(true);
      expect(full.asked).toHaveLength(0);
      const ask = gatewayOf('ask', 'allow-once');
      await makeBridgeDispatcher({ permissions: ask.gateway, paths, runPs, sandboxed })(open(file));
      expect(ask.asked).toHaveLength(1);
      expect(ask.asked[0].outsideSandbox).toBeUndefined();
      expect(ask.asked[0].note).toBeUndefined();
    }
  });

  it('没带目标的请求照旧报参数错，不当成沙箱外的操作', async () => {
    const { paths } = layout();
    const { gateway, asked } = gatewayOf('ask', 'allow-once');
    const env = await makeBridgeDispatcher({ permissions: gateway, paths, runPs, sandboxed: () => true })(open());
    expect(env.error?.code).toBe('INVALID_ARGS');
    expect(asked[0].outsideSandbox).toBeUndefined();
  });
});

describe('A2 密钥库与连接凭据读不出来', () => {
  const CREDS = ['secrets.vault', 'secrets.vault.tmp', 'vault.json', 'vault.json.tmp', 'minisd-port.json', 'minisd-port.json.tmp'];

  it('dataGate：读取硬拒，换写法（大小写、尾点、ADS、子路径）也一样；别的核心数据读取照旧走卡', () => {
    const scope: DataGateScope = { root: 'C:\\X\\DeskMinis', sessionId: 'S1', workspace: 'D:\\proj' };
    const read = (p: string) => dataGate(p, scope, 'read', { platform: 'win32' });
    for (const p of [...CREDS, 'SECRETS.VAULT', 'secrets.vault.', 'secrets.vault::$DATA', 'vault.json\\x']) {
      const v = read(`C:\\X\\DeskMinis\\${p}`);
      expect(v.verdict, p).toBe('deny');
      if (v.verdict === 'deny') expect(v.reason, p).toMatch(/^读取被拒绝：.*agent 不能读取/);
    }
    expect(read('C:\\X\\DeskMinis\\providers.json')).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.appDataRead });
    expect(read('C:\\X\\DeskMinis\\minis.db')).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.dbRead });
  });

  it('完全访问档与每次确认档：file 工具的读取门直接拒，不弹卡，记一条规则拦截', async () => {
    const { root, paths } = layout();
    for (const preset of ['full', 'ask'] as const) {
      const { gateway, asked, blocked } = gatewayOf(preset);
      const ctx: ToolContext = { sessionId: SESSION, paths, permissions: gateway };
      for (const name of CREDS) {
        writeFileSync(join(root, name), '{"data":"CIPHERTEXT"}');
        expect(await guardRead(join(root, name), ctx, '读'), name).toContain('读取被拒绝');
      }
      expect(asked).toHaveLength(0);
      expect(blocked).toHaveLength(CREDS.length);
      expect(blocked[0]).toMatchObject({ reason: 'rule-blocked', cause: 'core-data' });
    }
  });

  it('在数据目录上搜索：结果里没有这几个文件，尾注说明跳过了', async () => {
    const { root, paths } = layout();
    for (const name of CREDS) writeFileSync(join(root, name), '{"data":"NEEDLE"}');
    writeFileSync(join(root, 'update-prefs.json'), '{"x":"NEEDLE"}');
    paths.setWorkspaceResolver(() => root);
    const { gateway } = gatewayOf('ask', 'allow-once');
    const ctx: ToolContext = { sessionId: SESSION, paths, permissions: gateway };
    const reg = new ToolRegistry();
    reg.register(fileGrepTool); reg.register(fileGlobTool);
    const grep = await reg.execute('file_grep', JSON.stringify({ pattern: 'NEEDLE', tool_title: '搜' }), ctx);
    expect(grep.success).toBe(true);
    expect(grep.output).toContain('update-prefs.json:1:');
    for (const name of CREDS) expect(grep.output, name).not.toContain(`${name}:1:`);
    expect(grep.output).toMatch(/已跳过[^\n]*secrets\.vault/);
    const glob = await reg.execute('file_glob', JSON.stringify({ pattern: '*', tool_title: '找' }), ctx);
    expect(glob.output.split('\n')).not.toContain('secrets.vault');
    expect(glob.output.split('\n')).toContain('update-prefs.json');
  });
});

describe('A3 dataGate：开着命令隔离时哪些位置算沙箱之外', () => {
  const HOME = 'C:\\Users\\me';
  const NO_READ = [`${HOME}\\.ssh`, `${HOME}\\.git-credentials`];
  const scope = (over: Partial<DataGateScope> = {}): DataGateScope => ({
    root: `${HOME}\\AppData\\Roaming\\DeskMinis`, agentRoot: `${HOME}\\AppData\\LocalLow\\DeskMinis`, sessionId: 'S1', workspace: 'D:\\proj',
    sandboxNoRead: () => NO_READ, ...over,
  });
  const g = (p: string, op: 'read' | 'write', s: DataGateScope = scope()) => dataGate(p, s, op, { platform: 'win32' });

  it('写：工作区和 agent 根以内照旧，以外算沙箱之外；读：别处照旧走卡，不算沙箱之外', () => {
    expect(g('D:\\proj\\src\\a.ts', 'write')).toEqual({ verdict: 'free' });
    expect(g(`${HOME}\\AppData\\LocalLow\\DeskMinis\\sessions\\S1\\workspace\\a.txt`, 'write')).toEqual({ verdict: 'free' });
    expect(g(`${HOME}\\AppData\\LocalLow\\DeskMinis\\sessions\\S2\\workspace\\a.txt`, 'write')).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.otherSessionWrite('S2') });
    expect(g('D:\\other\\a.txt', 'write')).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.outsideWrite, outside: true });
    expect(g(`${HOME}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd`, 'write')).toMatchObject({ verdict: 'ask', outside: true });
    expect(g('D:\\other\\a.txt', 'read')).toEqual({ verdict: 'ask' });
  });

  it('「沙箱不许读」的位置读写都算沙箱之外，换写法、工作区把它包在里面也一样', () => {
    const want = { verdict: 'ask', note: DATA_GATE_NOTES.noReadPlace, outside: true };
    for (const p of [`${HOME}\\.ssh\\id_rsa`, `${HOME}\\.SSH\\id_rsa`, `${HOME}\\.ssh`, `${HOME}\\.ssh.\\id_rsa::$DATA`, `${HOME}\\.git-credentials`]) {
      expect(g(p, 'read'), p).toEqual(want);
      expect(g(p, 'write'), p).toEqual(want);
    }
    const homeBound = scope({ workspace: HOME });
    expect(g(`${HOME}\\.ssh\\id_rsa`, 'read', homeBound)).toEqual(want);
    expect(g(`${HOME}\\.ssh\\authorized_keys`, 'write', homeBound)).toEqual(want);
    expect(g(`${HOME}\\notes.txt`, 'write', homeBound)).toEqual({ verdict: 'free' });
    expect(g(`${HOME}\\.sshx\\id_rsa`, 'read')).toEqual({ verdict: 'ask' });
  });

  it('数据根里：走卡的都算沙箱之外，免审的照旧免审，硬拒的照旧硬拒', () => {
    const root = `${HOME}\\AppData\\Roaming\\DeskMinis`;
    expect(g(`${root}\\mcp-servers\\servers.json`, 'write')).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.mcpWrite, outside: true });
    expect(g(`${root}\\minis.db`, 'read')).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.dbRead, outside: true });
    expect(g(`${root}\\skills\\x\\SKILL.md`, 'read')).toEqual({ verdict: 'free' });
    expect(g(`${root}\\skills\\x\\SKILL.md`, 'write')).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.skillsWrite, outside: true });
    expect(g(`${root}\\providers.json`, 'write').verdict).toBe('deny');
  });

  it('没开命令隔离（没给清单，或清单返回 undefined）：没有任何位置算沙箱之外', () => {
    for (const off of [scope({ sandboxNoRead: undefined }), scope({ sandboxNoRead: () => undefined })]) {
      expect(g('D:\\other\\a.txt', 'write', off)).toEqual({ verdict: 'ask' });
      expect(g(`${HOME}\\.ssh\\id_rsa`, 'read', off)).toEqual({ verdict: 'ask' });
      expect(g(`${HOME}\\AppData\\Roaming\\DeskMinis\\minis.db`, 'read', off)).toEqual({ verdict: 'ask', note: DATA_GATE_NOTES.dbRead });
    }
  });

  it('开着命令隔离、清单是空的：写工作区外仍算沙箱之外', () => {
    const empty = scope({ sandboxNoRead: () => [] });
    expect(g('D:\\other\\a.txt', 'write', empty)).toMatchObject({ verdict: 'ask', outside: true });
    expect(g(`${HOME}\\.ssh\\id_rsa`, 'read', empty)).toEqual({ verdict: 'ask' });
  });
});

describe('A3 文件工具经真网关', () => {
  function setup(preset: PermissionPreset, sandboxed: boolean) {
    const l = layout();
    const ssh = join(l.elsewhere, '.ssh');
    mkdirSync(ssh);
    writeFileSync(join(ssh, 'id_rsa'), 'PRIVATE NEEDLE');
    writeFileSync(join(l.elsewhere, 'notes.txt'), 'plain NEEDLE');
    const gw = gatewayOf(preset);
    const ctx: ToolContext = { sessionId: SESSION, paths: l.paths, permissions: gw.gateway, ...(sandboxed ? { sandboxNoRead: () => [ssh] } : {}) };
    return { ...l, ...gw, ctx, ssh };
  }

  it('完全访问档 + 命令隔离：写工作区外、写 MCP 配置、读「不许读」的位置每次都弹卡，「本会话允许」只放这一次', async () => {
    const { ctx, asked, root, elsewhere, ssh } = setup('full', true);
    const targets: Array<[string, 'write' | 'read']> = [
      [join(elsewhere, 'out.txt'), 'write'], [join(root, 'mcp-servers', 'servers.json'), 'write'], [join(ssh, 'id_rsa'), 'read'], [join(root, 'minis.db'), 'read'],
    ];
    for (const [p, op] of targets) {
      const guard = op === 'write' ? guardWrite : guardRead;
      expect(await guard(p, ctx, '测')).toBeUndefined();
      expect(await guard(p, ctx, '测')).toBeUndefined();
    }
    expect(asked).toHaveLength(targets.length * 2);
    expect(asked.every(r => r.outsideSandbox === true && typeof r.note === 'string')).toBe(true);
    expect(asked.map(r => r.kind)).toEqual(['file-write', 'file-write', 'file-write', 'file-write', 'file-read', 'file-read', 'file-read', 'file-read']);
  });

  it('完全访问档 + 命令隔离：沙箱里的命令同样到得了的位置照旧不问', async () => {
    const { ctx, asked, paths, agentRoot, elsewhere } = setup('full', true);
    expect(await guardWrite(join(paths.workspaceOf(SESSION), 'a.txt'), ctx, '写')).toBeUndefined();
    expect(await guardWrite(join(agentRoot, 'sessions', 'OTHER', 'workspace', 'a.txt'), ctx, '写')).toBeUndefined();
    expect(await guardRead(join(elsewhere, 'notes.txt'), ctx, '读')).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  it('完全访问档、没开命令隔离：与以前一样都不问', async () => {
    const { ctx, asked, root, elsewhere, ssh } = setup('full', false);
    expect(await guardWrite(join(elsewhere, 'out.txt'), ctx, '写')).toBeUndefined();
    expect(await guardWrite(join(root, 'mcp-servers', 'servers.json'), ctx, '写')).toBeUndefined();
    expect(await guardRead(join(ssh, 'id_rsa'), ctx, '读')).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  it('只读 / 计划档 + 命令隔离：读「不许读」的位置照旧弹卡（不是直接拒），写照旧由规则拒', async () => {
    const { ctx, asked, elsewhere, ssh } = setup('plan', true);
    expect(await guardRead(join(ssh, 'id_rsa'), ctx, '读')).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(await guardWrite(join(elsewhere, 'out.txt'), ctx, '写')).toContain('只读 / 计划');
    expect(asked).toHaveLength(1);
  });

  it('搜索：基准之下「不许读」的目录和文件都跳过，尾注说明', async () => {
    const { ctx, asked, elsewhere, paths } = setup('full', true);
    const cred = join(elsewhere, '.git-credentials');
    writeFileSync(cred, 'https://u:NEEDLE@example.com');
    ctx.sandboxNoRead = () => [join(elsewhere, '.ssh'), cred];
    paths.setWorkspaceResolver(() => elsewhere);
    const reg = new ToolRegistry();
    reg.register(fileGrepTool); reg.register(fileGlobTool);
    const grep = await reg.execute('file_grep', JSON.stringify({ pattern: 'NEEDLE', tool_title: '搜' }), ctx);
    expect(grep.success).toBe(true);
    expect(grep.output).toContain('notes.txt:1:');
    expect(grep.output).not.toContain('PRIVATE');
    expect(grep.output).not.toContain('example.com');
    expect(grep.output).toMatch(/已跳过[^\n]*\.ssh/);
    const glob = await reg.execute('file_glob', JSON.stringify({ pattern: '**', tool_title: '找' }), ctx);
    expect(glob.output).toContain('notes.txt');
    expect(glob.output).not.toContain('id_rsa');
    expect(glob.output.split('\n')).not.toContain('.git-credentials');
    expect(asked).toHaveLength(0);
  });
});

describe('网关：沙箱外的标记对三类请求一视同仁', () => {
  const req = (kind: PermissionRequest['kind'], detail: string): PermissionRequest => ({ kind, detail, sessionId: 'S1', toolTitle: 't', outsideSandbox: true });

  it('完全访问档：文件读写与 windows-open 都弹卡，「本会话允许」不留授权', async () => {
    const { gateway, asked } = gatewayOf('full');
    for (const r of [req('file-write', 'D:\\a.txt'), req('file-read', 'C:\\Users\\me\\.ssh\\id_rsa'), req('bridge-open', 'windows-open open')]) {
      expect((await gateway.decide(r)).decision).toBe('allow');
      expect((await gateway.decide(r)).decision).toBe('allow');
    }
    expect(asked).toHaveLength(6);
  });

  it('只读 / 计划档：沙箱外的命令直接拒；沙箱外的读取照旧询问；写入与打开照旧由档位拒', async () => {
    const { gateway, asked } = gatewayOf('plan', 'allow-once');
    expect(await gateway.decide(req('shell', 'winget install x'))).toMatchObject({ decision: 'deny', reason: 'rule-blocked', cause: 'plan-mode' });
    expect((await gateway.decide(req('file-read', 'C:\\Users\\me\\.ssh\\id_rsa'))).decision).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(await gateway.decide(req('file-write', 'D:\\a.txt'))).toMatchObject({ decision: 'deny', reason: 'rule-blocked' });
    expect(await gateway.decide(req('bridge-open', 'windows-open open'))).toMatchObject({ decision: 'deny', reason: 'rule-blocked' });
    expect(asked).toHaveLength(1);
  });

  it('shell 卡为这次打开发的一次性桥授权：沙箱外的打开照样弹卡，授权算用掉，不留给后面的网址', async () => {
    const { gateway, asked } = gatewayOf('ask', 'allow-once');
    gateway.grantBridgeOnce('S1', 'bridge-open');
    expect((await gateway.decide(req('bridge-open', 'windows-open open'))).decision).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(gateway.hasBridgeGrant('S1')).toBe(false);
  });
});

describe('接线（源码守卫）', () => {
  it('引擎把命令隔离的实际状态交给桥分发器和文件工具（不交就等于没开）', () => {
    const idx = readFileSync(resolve(__dirname, '..', 'src', 'minisd', 'index.ts'), 'utf8');
    expect(idx).toContain('sandboxed: () => shells.sandboxed');
    expect(idx).toContain('sandboxNoRead: () => shells.sandboxed ? wantedSensitive(sensitiveListing(), true) : undefined');
  });
});
