/**
 * 数据根读写收窄（W1b-2；止血设计稿 §2「数据根写入收窄」「工具层」，侦察 tools.md「W1b-datagate」）。
 *
 * 为什么要有这道闸：数据根里除了 agent 自己的工作桶，还放着模型与密钥配置、会话数据库、配对与连接凭据、
 * MCP 配置（其中的启动命令会被 DeskMinis 执行）、技能与记忆（会进会话的提示）。旧的 guardWrite / guardRead
 * 只要路径在数据根内就一律免审，这些东西 agent 都能静默读写；工作区绑到数据根或它的祖先时更是全开。
 *
 * 这里只做判定，不弹卡。files.ts 的 guardWrite / guardRead 按结果处理：
 *   deny → 直接返回拒绝串，不进网关，'full' 档也照拒（核心数据与凭据）；
 *   free → 放行；
 *   ask  → 进网关，kind 不变（仍是 file-write / file-read，所以档位、会话授权键、卡片标题都不用动，
 *          'full' 档下跟随档位放行——设计稿 §2 落定），另带一句 note 给权限卡。
 *
 * 判定顺序：数据根规则优先于工作区规则——工作区绑到数据根或它的祖先时，数据根里的路径仍按数据根判；
 * 工作区绑到数据根里某处（例如别的会话的桶）时也一样，按那一处的数据根规则判。
 *
 * 数据根里「其余」一类（走卡，note 为「应用数据」）目前包括：数据根本身、sessions/ 本身、当前会话目录里桶以外的路径、
 * models-dev-cache.json、update-prefs.json、Chromium 的 profile 文件、开发态的 <DATA_DIR>/electron（W1a-9 的 userData）
 * 与 <DATA_DIR>/logs（W2b-7 的日志）。用白名单而不是黑名单：数据根里混着这么多东西，枚举黑名单一定会漏。
 */
import { realpathSync } from 'node:fs';
import * as nodePath from 'node:path';
import { DATA_ROOT_LOCK_NAME, DATA_ROOT_LOCK_RECOVERY_NAME, SESSION_BUCKETS, type GlobalDir } from '../paths';

export type DataGateOp = 'read' | 'write';
export type DataGateVerdict =
  | { verdict: 'free' }
  | { verdict: 'deny'; reason: string }
  | { verdict: 'ask'; note?: string };

/** root：数据根；workspace：该会话的实际工作目录（paths.workspaceOf 的结果，未绑定时就是数据根里的沙箱桶）。 */
export interface DataGateScope { root: string; sessionId: string; workspace: string }

export interface DataGateOptions {
  /** 按哪个平台的路径语义判定，默认本机。win32 下大小写不敏感，并剥掉 ADS 流名与尾部的点和空格。 */
  platform?: NodeJS.Platform;
  /** 取真实路径的函数，默认 fs.realpathSync.native。只在 platform 就是本机时才用默认值：
   *  在 Linux 上以 win32 测纯函数时，C:\… 在这台机器上不存在，真去 realpath 只会走错分支（cross.md corrections）。
   *  这时不注入就只做 path.win32 的词法规范化；要模拟 8.3 短名、junction 就注入一个假的。 */
  realpath?: (p: string) => string;
}

// ---------- 规则表 ----------

/** 核心数据与凭据：写入硬拒。label 进拒绝串，selfManaged 决定给模型的下一步建议。
 *  都在数据根根层；每个名字连同它的 .tmp（各 store 先写 .tmp 再 rename）以及它名下的整棵子树一起拒——
 *  接管闸 minisd.lock.recovery 在 W1b-3 的实现里是文件；按子树拒，将来改成目录也盖得住。 */
const CORE_ENTRIES: ReadonlyArray<readonly [name: string, label: string, selfManaged: boolean]> = [
  ['providers.json', '模型与密钥配置', false],
  ['search-provider.json', '搜索服务配置', false],
  ['minis.db', '会话数据库', false],
  ['minis.db-wal', '会话数据库', false],
  ['minis.db-shm', '会话数据库', false],
  ['minis.db-journal', '会话数据库', false],
  ['pairing-index.json', '设备配对记录', false],
  ['peer-addresses.json', '设备配对记录', false],
  ['minisd-port.json', '本机连接凭据', true],
  ['vault.json', '本机密钥库', true],
  [DATA_ROOT_LOCK_NAME, '数据目录锁', true],
  [DATA_ROOT_LOCK_RECOVERY_NAME, '数据目录锁', true],
];
const CORE = new Map<string, { label: string; selfManaged: boolean }>(
  CORE_ENTRIES.flatMap(([name, label, selfManaged]) => [
    [name, { label, selfManaged }] as const,
    [`${name}.tmp`, { label, selfManaged }] as const,
  ]),
);

/** 读取时单独点名的两类：会话数据库（含全部会话内容），本机连接凭据（minisd-port.json 明文带 authToken）。 */
const DB_FILES = new Set(['minis.db', 'minis.db-wal', 'minis.db-shm', 'minis.db-journal'].flatMap(n => [n, `${n}.tmp`]));
const CREDENTIAL_FILES = new Set(['minisd-port.json', 'vault.json'].flatMap(n => [n, `${n}.tmp`]));

const BUCKETS = new Set<string>(SESSION_BUCKETS);

/** 权限卡上的说明。必须属实：写 MCP 配置不承诺「下次连接时执行」——引擎不在每次运行前重读 servers.json，
 *  只说命令会被执行，不说什么时候；记忆只注入开启了记忆的会话（memory-injector.ts），不说「所有会话」。 */
export const DATA_GATE_NOTES = {
  mcpWrite: '将修改应用配置：MCP 服务配置，其中的启动命令会被 DeskMinis 执行',
  skillsWrite: '将修改应用配置：技能。启用的技能会列进会话的提示，agent 会按 SKILL.md 的正文做事',
  memoryWrite: '将修改应用配置：记忆。SOUL.md、GLOBAL.md 与日志会注入开启了记忆的会话，其中 SOUL.md 按指令对待',
  appDataWrite: '将修改 DeskMinis 的应用数据',
  otherSessionWrite: (id: string) => `将修改其它会话（${id}）的文件`,
  dbRead: '将读取 DeskMinis 会话数据库（含全部会话内容）',
  mcpRead: '将读取 MCP 服务配置（可能含密钥）',
  credentialRead: '将读取 DeskMinis 的本机连接凭据',
  appDataRead: '将读取 DeskMinis 的应用数据',
  otherSessionRead: (id: string) => `将读取其它会话（${id}）的文件`,
} as const;

const FREE: DataGateVerdict = Object.freeze({ verdict: 'free' });
const ask = (note: string): DataGateVerdict => ({ verdict: 'ask', note });

/** 全局目录的读写规则。以 GlobalDir 为键：paths.ts 新增全局目录而这里不补，typecheck 就过不去，
 *  不会悄悄落进「其余」。读 skills 必须免审——技能块让模型 file_read SKILL.md，use_count 也靠它计数
 *  （tests/skills-rpc.test.ts）；memory 的读取本来就会注入提示，读它不外泄新东西。 */
const GLOBAL_RULES: Record<GlobalDir, Record<DataGateOp, () => DataGateVerdict>> = {
  shared: { read: () => FREE, write: () => FREE },
  skills: { read: () => FREE, write: () => ask(DATA_GATE_NOTES.skillsWrite) },
  memory: { read: () => FREE, write: () => ask(DATA_GATE_NOTES.memoryWrite) },
  'mcp-servers': { read: () => ask(DATA_GATE_NOTES.mcpRead), write: () => ask(DATA_GATE_NOTES.mcpWrite) },
};

function denyReason(abs: string, core: { label: string; selfManaged: boolean }): string {
  const next = core.selfManaged ? '它由 DeskMinis 自己维护。' : '如需调整，请让用户在 DeskMinis 界面里操作。';
  return `写入被拒绝：${abs} 是 DeskMinis 的核心数据（${core.label}），agent 不能修改。${next}`;
}

// ---------- 规范化 ----------

type PathApi = typeof nodePath.posix;

/** 规范化后的路径：root 是盘符或 '/'；cmp 用于比较（win32 下已小写），disp 保留原样大小写用于文案。 */
interface NormPath { root: string; cmp: string[]; disp: string[] }

/** abs 不存在时，对最近一个存在的祖先取 realpath，再把不存在的尾段拼回去：
 *  新建文件是常态，只 realpath 整条路径的话，新文件永远取不到真实路径，符号链接 / junction 就能绕过去。 */
function canonical(p: string, P: PathApi, realpath: ((p: string) => string) | undefined): string {
  const abs = P.resolve(p);
  if (!realpath) return abs;
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpath(cur);
      return tail.length === 0 ? real : P.join(real, ...tail.reverse());
    } catch {
      const parent = P.dirname(cur);
      if (parent === cur) return abs; // 一路到盘根都取不到：退回词法结果
      tail.push(P.basename(cur));
      cur = parent;
    }
  }
}

/** win32 的一段：剥掉 ':' 起的流名（providers.json::$DATA 就是 providers.json 本体），
 *  再剥尾部的点和空格（Win32 API 打开 providers.json. 与 providers.json 是同一个文件）。 */
function stripWin32Segment(seg: string): string {
  return seg.replace(/:[\s\S]*$/, '').replace(/[. ]+$/, '');
}

function normalize(p: string, P: PathApi, win: boolean, realpath: ((p: string) => string) | undefined): NormPath {
  const canon = canonical(p, P, realpath);
  const root = P.parse(canon).root;
  const raw = canon.slice(root.length).split(win ? /[\\/]/ : '/').filter(s => s !== '');
  if (!win) return { root, cmp: raw, disp: raw };
  // 剥完为空的段（全是点或空格）直接丢掉：宁可把路径往上归，也不要让它变成「根外」
  const disp = raw.map(stripWin32Segment).filter(s => s !== '');
  // NTFS 不区分大小写：打包后 userData 是 %APPDATA%\deskminis 而数据根写作 DeskMinis，两者是同一个目录（cross.md corrections）
  return { root: root.toLowerCase(), cmp: disp.map(s => s.toLowerCase()), disp };
}

/** t 在 base 之内（含相等）时返回 t 相对 base 的各段；按段比较，/r-evil 不会被当成 /r 之内。 */
function under(base: NormPath, t: NormPath): { cmp: string[]; disp: string[] } | undefined {
  if (base.root !== t.root || base.cmp.length > t.cmp.length) return undefined;
  for (let i = 0; i < base.cmp.length; i++) if (base.cmp[i] !== t.cmp[i]) return undefined;
  return { cmp: t.cmp.slice(base.cmp.length), disp: t.disp.slice(base.cmp.length) };
}

function gateEnv(opts: DataGateOptions): { win: boolean; norm: (p: string) => NormPath } {
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const P: PathApi = win ? nodePath.win32 : nodePath.posix;
  const realpath = opts.realpath ?? (platform === process.platform ? (p: string) => realpathSync.native(p) : undefined);
  return { win, norm: (p: string) => normalize(p, P, win, realpath) };
}

// ---------- 判定 ----------

function judgeInRoot(abs: string, rel: { cmp: string[]; disp: string[] }, sessionId: string, op: DataGateOp): DataGateVerdict {
  const [top, second, third] = rel.cmp;
  if (op === 'write' && top !== undefined) {
    const core = CORE.get(top);
    if (core) return { verdict: 'deny', reason: denyReason(abs, core) };
  }
  if (top === 'sessions' && second !== undefined) {
    if (second !== sessionId) {
      const id = rel.disp[1];
      return ask(op === 'write' ? DATA_GATE_NOTES.otherSessionWrite(id) : DATA_GATE_NOTES.otherSessionRead(id));
    }
    // 当前会话：只有四个桶免审（卸载读回依赖 offloads 免审，tests/offload-roundtrip.test.ts 钉着）；
    // sessions/<当前会话> 本身和桶以外的路径落到下面「其余」
    if (third !== undefined && BUCKETS.has(third)) return FREE;
  } else if (top !== undefined && Object.prototype.hasOwnProperty.call(GLOBAL_RULES, top)) {
    return GLOBAL_RULES[top as GlobalDir][op]();
  } else if (op === 'read' && top !== undefined) {
    if (DB_FILES.has(top)) return ask(DATA_GATE_NOTES.dbRead);
    if (CREDENTIAL_FILES.has(top)) return ask(DATA_GATE_NOTES.credentialRead);
  }
  return ask(op === 'write' ? DATA_GATE_NOTES.appDataWrite : DATA_GATE_NOTES.appDataRead);
}

/** 判定一次文件读写。abs 是工具解析出的宿主绝对路径；拒绝串里原样引用它，给模型看的是它自己给的路径。 */
export function dataGate(abs: string, scope: DataGateScope, op: DataGateOp, opts: DataGateOptions = {}): DataGateVerdict {
  const env = gateEnv(opts);
  const target = env.norm(abs);
  const inRoot = under(env.norm(scope.root), target);
  if (inRoot) return judgeInRoot(abs, inRoot, env.win ? scope.sessionId.toLowerCase() : scope.sessionId, op);
  // 数据根之外：绑定的工作区里免审（绑定动作本身就是授权），其余照旧走卡、不带 note
  if (under(env.norm(scope.workspace), target)) return FREE;
  return { verdict: 'ask' };
}

/** 搜索三件套用：数据根落在基准目录之内、且基准本身不在数据根内时，返回一个判定器，
 *  告诉 walkDir 哪个「相对基准的正斜杠路径」就是数据根，整棵子树不进。
 *  为什么不弹卡：工作区绑到用户主目录的人每次搜索都会被打断；为什么要跳：不跳的话 grep 会顺带读到
 *  servers.json 与其它会话的文件，绕过上面「读取走卡」的规则。
 *  walkDir 不跟随符号链接，所以相对基准的词法路径与规范化后的相对路径一致，按段比较即可。 */
export function dataRootSkipper(base: string, root: string, opts: DataGateOptions = {}): ((rel: string) => boolean) | undefined {
  const env = gateEnv(opts);
  const below = under(env.norm(base), env.norm(root));
  if (!below || below.cmp.length === 0) return undefined; // 数据根不在基准之下，或基准就是数据根（那时按 dataGate 判）
  const target = below.cmp.join('/');
  const fold = env.win
    ? (rel: string) => rel.split('/').map(stripWin32Segment).filter(s => s !== '').map(s => s.toLowerCase()).join('/')
    : (rel: string) => rel;
  return (rel: string) => fold(rel) === target;
}
