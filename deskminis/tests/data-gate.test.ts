/**
 * W1b-2 · dataGate 纯函数（止血设计稿 §2「工具层」：dataGate 做规范化，realpath 可注入）。
 *
 * 在 Linux 上以 platform='win32' 测 Windows 路径：C:\… 在这台机器上不存在，不能真去 realpath
 * （cross.md corrections 第 48 行）。所以：不注入 realpath 且 platform 与本机不同时只做 path.win32 的词法规范化；
 * 需要模拟 8.3 短名、junction 时注入一个查表的假 realpath。
 */
import { describe, it, expect } from 'vitest';
import { dataGate, dataRootSkipper, type DataGateScope } from '../src/minisd/tools/data-gate';

const W: DataGateScope = { root: 'C:\\X\\DeskMinis', sessionId: 'AAAA-1', workspace: 'C:\\X\\DeskMinis\\sessions\\AAAA-1\\workspace' };
const win = (abs: string, op: 'read' | 'write' = 'write', scope: DataGateScope = W, realpath?: (p: string) => string) =>
  dataGate(abs, scope, op, { platform: 'win32', realpath });

describe('⑧ win32 规范化：大小写、尾点尾空格、ADS 都绕不过硬拒', () => {
  it.each([
    'C:\\X\\DeskMinis\\providers.json',
    'C:\\X\\DeskMinis\\Providers.JSON',
    'c:\\x\\deskminis\\PROVIDERS.JSON',
    'C:\\X\\DESKMINIS\\providers.json',
    'C:\\X\\DeskMinis\\providers.json.',
    'C:\\X\\DeskMinis\\providers.json ',
    'C:\\X\\DeskMinis\\providers.json . .',
    'C:\\X\\DeskMinis\\providers.json::$DATA',
    'C:\\X\\DeskMinis\\providers.json:evil',
    'C:/X/DeskMinis/providers.json',
    'C:\\X\\DeskMinis\\sub\\..\\providers.json',
    'C:\\X\\DeskMinis\\MINIS.DB-WAL',
    'C:\\X\\DeskMinis\\minisd.lock',
    'C:\\X\\DeskMinis\\MinisD.Lock.Recovery',
  ])('%s → deny', (p) => {
    const v = win(p);
    expect(v.verdict).toBe('deny');
    if (v.verdict === 'deny') expect(v.reason).toContain('核心数据');
  });

  it('目录段同样规范化：尾点的 mcp-servers. 与大写 SKILLS 仍按应用配置走卡', () => {
    const a = win('C:\\X\\DeskMinis\\mcp-servers.\\servers.json');
    expect(a).toEqual({ verdict: 'ask', note: expect.stringContaining('MCP') });
    const b = win('C:\\X\\DeskMinis\\SKILLS\\x\\SKILL.md');
    expect(b).toEqual({ verdict: 'ask', note: expect.stringContaining('技能') });
  });

  it('会话 id 比较不区分大小写：小写写法仍是当前会话的桶', () => {
    expect(win('C:\\X\\DeskMinis\\sessions\\aaaa-1\\workspace\\a.txt')).toEqual({ verdict: 'free' });
    expect(win('C:\\X\\DeskMinis\\Sessions\\AAAA-1\\Offloads\\T1.txt', 'read')).toEqual({ verdict: 'free' });
    const other = win('C:\\X\\DeskMinis\\sessions\\BBBB-2\\workspace\\a.txt');
    expect(other.verdict).toBe('ask');
    if (other.verdict === 'ask') expect(other.note).toContain('BBBB-2');
  });

  it('注入的 realpath：8.3 短名 DESKMI~1 解析回数据根后照拒；只对最近存在的祖先取 realpath', () => {
    const exists: Record<string, string> = {
      'C:\\': 'C:\\', 'C:\\X': 'C:\\X', 'C:\\X\\DeskMinis': 'C:\\X\\DeskMinis', 'C:\\X\\DESKMI~1': 'C:\\X\\DeskMinis',
    };
    const seen: string[] = [];
    const rp = (p: string): string => {
      seen.push(p);
      const hit = exists[p];
      if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return hit;
    };
    const v = win('C:\\X\\DESKMI~1\\providers.json', 'write', W, rp);
    expect(v.verdict).toBe('deny');
    // 先试整条路径（不存在），再退到父目录（存在）——不再往上取
    expect(seen).toContain('C:\\X\\DESKMI~1\\providers.json');
    expect(seen).toContain('C:\\X\\DESKMI~1');
    expect(seen).not.toContain('C:\\X');
  });

  it('注入的 realpath：junction 把别处目录接到数据根，经它写核心文件照拒', () => {
    const rp = (p: string): string => {
      if (p === 'D:\\j') return 'C:\\X\\DeskMinis';
      if (p === 'C:\\X\\DeskMinis') return p;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(win('D:\\j\\minisd-port.json', 'write', W, rp).verdict).toBe('deny');
  });

  // 比较的两头都要取 realpath：数据根自己就可能以短名或重定向形式给出（例如 CI 账户的 RUNNER~1），
  // 只规范化目标的话，长名写法的核心文件会被判成根外——硬拒落空，full 档下就是静默写入。
  it('注入的 realpath：数据根本身写成 8.3 短名，同样取 realpath，长名写法的核心文件照拒', () => {
    const SHORT = 'C:\\Users\\RUNNER~1\\AppData\\Roaming\\DeskMinis';
    const LONG = 'C:\\Users\\runneradmin\\AppData\\Roaming\\DeskMinis';
    const rp = (p: string): string => {
      if (p === SHORT) return LONG;
      if (p === LONG) return p;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const scope: DataGateScope = { root: SHORT, sessionId: 'AAAA-1', workspace: `${SHORT}\\sessions\\AAAA-1\\workspace` };
    const v = win(`${LONG}\\providers.json`, 'write', scope, rp);
    expect(v.verdict).toBe('deny');
    if (v.verdict === 'deny') expect(v.reason).toContain('核心数据');
    // 长名写法的当前会话 offloads：仍是免审的桶，不被当成根外去弹卡
    expect(win(`${LONG}\\sessions\\AAAA-1\\offloads\\T1.txt`, 'read', scope, rp)).toEqual({ verdict: 'free' });
  });

  it('注入的 realpath：绑定的工作区写成短名，长名写法的文件仍在工作区内免审', () => {
    const rp = (p: string): string => {
      if (p === 'D:\\PROJEC~1') return 'D:\\Projects Long';
      if (p === 'D:\\Projects Long') return p;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const scope: DataGateScope = { root: 'C:\\X\\DeskMinis', sessionId: 'AAAA-1', workspace: 'D:\\PROJEC~1' };
    expect(win('D:\\Projects Long\\src\\a.ts', 'write', scope, rp)).toEqual({ verdict: 'free' });
    expect(win('D:\\Projects Long\\src\\a.ts', 'read', scope, rp)).toEqual({ verdict: 'free' });
  });
});

describe('判定表（posix，词法）', () => {
  const P: DataGateScope = { root: '/r', sessionId: 'S1', workspace: '/r/sessions/S1/workspace' };
  const g = (abs: string, op: 'read' | 'write', scope: DataGateScope = P) =>
    dataGate(abs, scope, op, { platform: 'linux', realpath: (p) => p });

  it('写：核心硬拒 / 当前会话桶与 shared 免审 / 应用配置、其它会话、其余走卡', () => {
    expect(g('/r/providers.json', 'write').verdict).toBe('deny');
    expect(g('/r/minis.db-journal', 'write').verdict).toBe('deny');
    expect(g('/r/sessions/S1/workspace/a', 'write')).toEqual({ verdict: 'free' });
    expect(g('/r/sessions/S1/browser/a', 'write')).toEqual({ verdict: 'free' });
    expect(g('/r/shared/a', 'write')).toEqual({ verdict: 'free' });
    expect(g('/r/mcp-servers/servers.json', 'write')).toEqual({ verdict: 'ask', note: expect.stringContaining('将修改应用配置') });
    expect(g('/r/skills/x/SKILL.md', 'write')).toEqual({ verdict: 'ask', note: expect.stringContaining('将修改应用配置') });
    expect(g('/r/memory/SOUL.md', 'write')).toEqual({ verdict: 'ask', note: expect.stringContaining('SOUL.md') });
    expect(g('/r/sessions/S2/workspace/a', 'write')).toEqual({ verdict: 'ask', note: '将修改其它会话（S2）的文件' });
    expect(g('/r/sessions/S1/notes.txt', 'write')).toEqual({ verdict: 'ask', note: '将修改 DeskMinis 的应用数据' });
    expect(g('/r/logs/x.log', 'write')).toEqual({ verdict: 'ask', note: '将修改 DeskMinis 的应用数据' });
    expect(g('/r', 'write')).toEqual({ verdict: 'ask', note: '将修改 DeskMinis 的应用数据' });
  });

  it('读：当前会话桶、shared、skills、memory 免审；其余走卡（minis.db / 其它会话 / MCP / 凭据 / 其余）', () => {
    for (const p of ['/r/sessions/S1/offloads/T1.txt', '/r/sessions/S1/attachments/a.png', '/r/shared/a', '/r/skills/x/SKILL.md', '/r/memory/GLOBAL.md']) {
      expect(g(p, 'read'), p).toEqual({ verdict: 'free' });
    }
    expect(g('/r/minis.db', 'read')).toEqual({ verdict: 'ask', note: '将读取 DeskMinis 会话数据库（含全部会话内容）' });
    expect(g('/r/minis.db-shm', 'read')).toEqual({ verdict: 'ask', note: '将读取 DeskMinis 会话数据库（含全部会话内容）' });
    expect(g('/r/sessions/S2/workspace/a', 'read')).toEqual({ verdict: 'ask', note: '将读取其它会话（S2）的文件' });
    expect(g('/r/mcp-servers/servers.json', 'read')).toEqual({ verdict: 'ask', note: '将读取 MCP 服务配置（可能含密钥）' });
    expect(g('/r/minisd-port.json', 'read')).toEqual({ verdict: 'ask', note: expect.stringContaining('凭据') });
    expect(g('/r/providers.json', 'read')).toEqual({ verdict: 'ask', note: '将读取 DeskMinis 的应用数据' });
    expect(g('/r/models-dev-cache.json', 'read')).toEqual({ verdict: 'ask', note: '将读取 DeskMinis 的应用数据' });
  });

  it('数据根之外：在工作区内免审，两者都不在就走卡且不带 note', () => {
    const bound: DataGateScope = { root: '/r', sessionId: 'S1', workspace: '/proj' };
    expect(g('/proj/src/a.ts', 'write', bound)).toEqual({ verdict: 'free' });
    expect(g('/proj/src/a.ts', 'read', bound)).toEqual({ verdict: 'free' });
    expect(g('/etc/passwd', 'read', bound)).toEqual({ verdict: 'ask' });
    expect(g('/etc/x', 'write', bound)).toEqual({ verdict: 'ask' });
  });

  it('数据根规则优先：工作区绑到数据根或它的祖先时，数据根里的路径仍按数据根判', () => {
    for (const ws of ['/r', '/']) {
      const s: DataGateScope = { root: '/r', sessionId: 'S1', workspace: ws };
      expect(g('/r/providers.json', 'write', s).verdict).toBe('deny');
      expect(g('/r/minis.db', 'read', s).verdict).toBe('ask');
    }
  });

  it('字符串前缀不算包含：/r-evil 与 /r/..x 的边界', () => {
    expect(g('/r-evil/providers.json', 'write')).toEqual({ verdict: 'ask' });
    // 文件名以 .. 开头仍在数据根内：按「其余应用数据」走卡，不当成根外
    expect(g('/r/..x', 'write')).toEqual({ verdict: 'ask', note: '将修改 DeskMinis 的应用数据' });
  });

  it('posix 区分大小写：Providers.json 不是核心文件（Linux 上是另一个文件），按其余走卡', () => {
    expect(g('/r/Providers.json', 'write')).toEqual({ verdict: 'ask', note: '将修改 DeskMinis 的应用数据' });
  });
});

describe('dataRootSkipper：搜索跳过数据根子树', () => {
  it('win32：基准是数据根的祖先时按段比较，大小写与尾点不影响；近似名不误伤', () => {
    const skip = dataRootSkipper('C:\\Users\\me', 'C:\\Users\\me\\AppData\\Roaming\\DeskMinis', { platform: 'win32' });
    expect(skip).toBeDefined();
    expect(skip!('AppData/Roaming/DeskMinis')).toBe(true);
    expect(skip!('appdata/roaming/deskminis')).toBe(true);
    expect(skip!('AppData/Roaming')).toBe(false);
    expect(skip!('AppData/Roaming/DeskMinis-dev')).toBe(false);
    expect(skip!('AppData/Roaming/DeskMinis/skills')).toBe(false); // 数据根本身已整棵跳过，不会走到这里
  });

  it('基准在数据根内或就是数据根：不给跳过器（那时按 dataGate 判基准本身）', () => {
    const o = { platform: 'linux' as const, realpath: (p: string) => p };
    expect(dataRootSkipper('/r/sessions/S1/workspace', '/r', o)).toBeUndefined();
    expect(dataRootSkipper('/r', '/r', o)).toBeUndefined();
    expect(dataRootSkipper('/elsewhere', '/r', o)).toBeUndefined();
    expect(dataRootSkipper('/', '/r', o)!('r')).toBe(true);
  });
});
