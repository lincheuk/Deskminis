/** W2b-7（设计稿 §4 S25 · 侦察 lifecycle.md「W2b-crashlog」）：本地崩溃记录 <logRoot>/crashes.json。
 *
 *  规则：文件是一个数组，每条 {timestamp, version, process, kind, message, stack, exitCode?, stderrTail?}；
 *  写入 = 读出 → 丢掉超过 7 天的 → 追加 → 只留最新 5 条 → 写临时文件再 rename 原子替换；
 *  坏文件当空；写失败一律静默（调用方已经在崩溃路径上，这里再抛就是雪上加霜）。
 *  时间由调用方注入，结果确定。
 *
 *  「原子写」这一例用 vi.mock 给 node:fs 的 writeFileSync 包一层：让它写到一半抛 ENOSPC（磁盘满），
 *  已有的 crashes.json 必须原样不动、目录里不留临时文件——直接写目标文件的实现在这里会把旧记录写坏。 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordCrash, readCrashLog, crashLogPath, CRASH_LOG_NAME, MAX_CRASH_RECORDS, CRASH_MAX_AGE_MS,
  type CrashInput, type CrashRecord,
} from '../src/minisd/diag/crash-log';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, writeFileSync: vi.fn(real.writeFileSync) };
});

const dirs: string[] = [];
function tmpLogRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dm-crashlog-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.mocked(writeFileSync).mockClear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = new Date('2026-09-25T08:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);
const days = (n: number): Date => new Date(T0.getTime() + n * 24 * 60 * 60_000);
const exc = (message: string): CrashInput => ({ process: 'minisd', kind: 'uncaught_exception', version: '0.3.0', error: new Error(message) });
const onDisk = (path: string): CrashRecord[] => JSON.parse(readFileSync(path, 'utf8')) as CrashRecord[];

describe('crashes.json：位置与上限', () => {
  it('放在 <logRoot>/crashes.json；最多 5 条、保留 7 天', () => {
    expect(CRASH_LOG_NAME).toBe('crashes.json');
    expect(crashLogPath('/x/logs')).toBe(join('/x/logs', 'crashes.json'));
    expect(MAX_CRASH_RECORDS).toBe(5);
    expect(CRASH_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('连写 7 条后只剩最新 5 条，旧的在前、新的在后', () => {
    const path = crashLogPath(tmpLogRoot());
    for (let i = 0; i < 7; i++) expect(recordCrash(exc(`m${i}`), path, minutes(i))).toBeDefined();
    const recs = onDisk(path);
    expect(recs.map(r => r.message)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6']);
    expect(recs.map(r => r.timestamp)).toEqual([2, 3, 4, 5, 6].map(i => minutes(i).toISOString()));
    expect(readCrashLog(path)).toEqual(recs);
  });

  it('写入时剔除超过 7 天的旧记录（8 天前的丢掉，6 天前的留着）', () => {
    const path = crashLogPath(tmpLogRoot());
    recordCrash(exc('八天前'), path, days(-8));
    recordCrash(exc('六天前'), path, days(-6));
    recordCrash(exc('刚才'), path, T0);
    expect(onDisk(path).map(r => r.message)).toEqual(['六天前', '刚才']);
  });

  it('日志目录不存在时自己建出来', () => {
    const path = join(tmpLogRoot(), 'a', 'b', CRASH_LOG_NAME);
    expect(recordCrash(exc('x'), path, T0)).toBeDefined();
    expect(onDisk(path)).toHaveLength(1);
  });
});

describe('一条记录的字段', () => {
  it('Error：message、stack、版本、进程、种类、ISO 时间（UTC）', () => {
    const path = crashLogPath(tmpLogRoot());
    const err = new Error('库写失败');
    const rec = recordCrash({ process: 'main', kind: 'unhandled_rejection', version: '0.3.0', error: err }, path, T0);
    expect(rec).toEqual({
      timestamp: '2026-09-25T08:00:00.000Z', version: '0.3.0', process: 'main', kind: 'unhandled_rejection',
      message: '库写失败', stack: err.stack,
    });
    expect(onDisk(path)).toEqual([rec]);
  });

  it('message 为空的 Error 记它的 name；不是 Error 的抛出物：字符串原样、对象给可读的样子，stack 为 null', () => {
    const path = crashLogPath(tmpLogRoot());
    const noMsg = new TypeError('');
    expect(recordCrash({ process: 'minisd', kind: 'uncaught_exception', version: 'v', error: noMsg }, path, T0)?.message).toBe('TypeError');
    const s = recordCrash({ process: 'minisd', kind: 'unhandled_rejection', version: 'v', error: 'plain' }, path, T0);
    expect(s).toMatchObject({ message: 'plain', stack: null });
    const o = recordCrash({ process: 'minisd', kind: 'unhandled_rejection', version: 'v', error: { code: 'E_X', n: 42 } }, path, T0);
    expect(o?.message).toContain('E_X');
    expect(o?.message).toContain('42');
    expect(o?.stack).toBeNull();
  });

  it('minisd_exit：没有抛出物，带说明、退出码与 stderr 末尾', () => {
    const path = crashLogPath(tmpLogRoot());
    const rec = recordCrash({
      process: 'minisd', kind: 'minisd_exit', version: '0.3.0', message: '引擎进程意外退出（code=3）', exitCode: 3, stderrTail: 'boom\n',
    }, path, T0);
    expect(rec).toEqual({
      timestamp: T0.toISOString(), version: '0.3.0', process: 'minisd', kind: 'minisd_exit',
      message: '引擎进程意外退出（code=3）', stack: null, exitCode: 3, stderrTail: 'boom\n',
    });
  });

  it('超长的 message 被截短（5 条记录不该撑成几 MB）', () => {
    const path = crashLogPath(tmpLogRoot());
    const rec = recordCrash(exc('长'.repeat(100_000)), path, T0);
    expect(rec?.message.length).toBeLessThan(5_000);
    expect(rec?.message.startsWith('长长长')).toBe(true);
  });
});

describe('容错：坏文件当空、写失败静默', () => {
  it('坏 JSON 当空处理，这次照样写进去', () => {
    const path = crashLogPath(tmpLogRoot());
    writeFileSync(path, '{not json');
    expect(readCrashLog(path)).toEqual([]);
    expect(recordCrash(exc('新的'), path, T0)).toBeDefined();
    expect(onDisk(path).map(r => r.message)).toEqual(['新的']);
  });

  it('不是数组、数组里夹着坏条目：不是数组当空，坏条目丢掉', () => {
    const path = crashLogPath(tmpLogRoot());
    writeFileSync(path, JSON.stringify({ a: 1 }));
    expect(readCrashLog(path)).toEqual([]);
    const good = { timestamp: minutes(-1).toISOString(), version: 'v', process: 'main', kind: 'uncaught_exception', message: 'ok', stack: null };
    writeFileSync(path, JSON.stringify([1, null, 'x', { timestamp: 5 }, { message: 'no ts' }, good]));
    expect(readCrashLog(path)).toEqual([good]);
    recordCrash(exc('新的'), path, T0);
    expect(onDisk(path).map(r => r.message)).toEqual(['ok', '新的']);
  });

  it('文件不存在：读出空数组', () => {
    expect(readCrashLog(join(tmpLogRoot(), 'nope', CRASH_LOG_NAME))).toEqual([]);
  });

  it('把一个普通文件当目录传进去：返回 undefined，不抛', () => {
    const root = tmpLogRoot();
    const plain = join(root, 'plain.txt');
    writeFileSync(plain, 'x');
    let rec: CrashRecord | undefined;
    expect(() => { rec = recordCrash(exc('x'), join(plain, CRASH_LOG_NAME), T0); }).not.toThrow();
    expect(rec).toBeUndefined();
  });

  it('原子写：写到一半磁盘满，已有的记录原样不动，也不留临时文件', () => {
    const root = tmpLogRoot();
    const path = crashLogPath(root);
    recordCrash(exc('旧的'), path, minutes(-1));
    const before = readFileSync(path, 'utf8');
    const realWrite = vi.mocked(writeFileSync).getMockImplementation()!;
    vi.mocked(writeFileSync).mockImplementationOnce((file, data) => {
      realWrite(file, String(data).slice(0, 7)); // 只写进去一截
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    let rec: CrashRecord | undefined;
    expect(() => { rec = recordCrash(exc('新的'), path, T0); }).not.toThrow();
    expect(rec).toBeUndefined();
    expect(readFileSync(path, 'utf8'), '直接写目标文件的话，旧记录在这里已经被写坏了').toBe(before);
    expect(readdirSync(root)).toEqual([CRASH_LOG_NAME]);
    expect(existsSync(path)).toBe(true);
  });
});
