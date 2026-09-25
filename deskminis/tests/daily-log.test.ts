/** W2b-7（设计稿 §4 S25 · 侦察 lifecycle.md「W2b-crashlog」【按天日志】）：<logRoot>/minisd-YYYY-MM-DD.log。
 *
 *  主进程把 minisd 的 stdout（握手行除外）与 stderr、以及自己的生命周期行（fork、握手端口、请求关停、退出码）写进来。
 *  按本地日期分文件，每行前加带时区的 ISO 时间（日期部分与文件名一致，解析回来就是那一刻）；
 *  启动时删掉超过 7 天的文件；单日超过 10MB 停写，只记一行截断说明；只落本地，写不进也不打断调用方。
 *  时间一律注入；日期用本地时间构造（new Date(年, 月, 日, …)），在哪个时区跑结果都一样。 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DailyLog, DAILY_LOG_MAX_BYTES, DAILY_LOG_KEEP_DAYS, localDateStamp, localIsoTime,
} from '../src/minisd/diag/daily-log';

const dirs: string[] = [];
function tmpLogRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dm-dailylog-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// 整个文件钉在东八区（W2b-7 三审）：验证环境是 UTC，本地午夜就是 UTC 午夜，「按本地日期分文件」「行时间带时区」
// 「按本地日历天清理」这几条在 UTC 里跑不出区别——改成 toISOString 或按 UTC 算日期照样全绿，
// 可目标用户在东八区，那样每天 00:00–08:00 的日志会进前一天的文件。vitest 按文件隔离进程，影响不到别的文件；
// Node 运行中改 TZ 立即生效，下面构造 Date 的地方都在用例里，晚于这里
let savedTz: string | undefined;
beforeAll(() => { savedTz = process.env.TZ; process.env.TZ = 'Asia/Shanghai'; });
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

/** 本地时间 2026-09-25 的某一刻 */
const at = (h: number, m = 0, day = 25): Date => new Date(2026, 8, day, h, m, 7, 123);
const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(l => l !== '');
/** 带时区的 ISO 时间 */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/;
/** 一行 = <ISO 时间> <正文> */
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})) (.*)$/;

describe('时间与文件名', () => {
  it('本地日期戳与带时区的 ISO 时间：解析回来是同一刻，日期部分与本地日期一致', () => {
    for (const d of [at(0, 0), at(23, 59), new Date(2026, 0, 1, 0, 30), new Date(2026, 11, 31, 23, 30)]) {
      const iso = localIsoTime(d);
      expect(iso).toMatch(ISO);
      expect(Date.parse(iso)).toBe(d.getTime());
      expect(iso.slice(0, 10)).toBe(localDateStamp(d));
    }
    expect(localDateStamp(at(9))).toBe('2026-09-25');
    expect(localDateStamp(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('上限 10MB、保留 7 天', () => {
    expect(DAILY_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(DAILY_LOG_KEEP_DAYS).toBe(7);
  });

  it('构造不碰磁盘（主进程在模块顶层就建它，单测 import 主进程时不能在开发机上建目录）', () => {
    const root = join(tmpLogRoot(), 'not-yet');
    const log = new DailyLog(root);
    expect(existsSync(root)).toBe(false);
    expect(log.fileFor(at(9))).toBe(join(root, 'minisd-2026-09-25.log'));
  });
});

describe('append', () => {
  it('同一天两次 append 落在同一个文件，按先后各占一行，行首是那一刻的 ISO 时间', () => {
    const root = tmpLogRoot();
    const log = new DailyLog(root);
    log.append('[main] 启动引擎进程', at(9, 0));
    log.append('[minisd:err] 第二行', at(9, 1));
    expect(readdirSync(root)).toEqual(['minisd-2026-09-25.log']);
    const got = lines(join(root, 'minisd-2026-09-25.log'));
    expect(got).toHaveLength(2);
    const parsed = got.map(l => LINE.exec(l));
    expect(parsed.map(m => m?.[2])).toEqual(['[main] 启动引擎进程', '[minisd:err] 第二行']);
    expect(parsed.map(m => Date.parse(m?.[1] ?? ''))).toEqual([at(9, 0).getTime(), at(9, 1).getTime()]);
  });

  it('过了午夜（本地）落到新文件', () => {
    const root = tmpLogRoot();
    const log = new DailyLog(root);
    log.append('今天', at(23, 59));
    log.append('明天', new Date(2026, 8, 26, 0, 0, 1));
    expect(readdirSync(root).sort()).toEqual(['minisd-2026-09-25.log', 'minisd-2026-09-26.log']);
    expect(lines(join(root, 'minisd-2026-09-26.log')).map(l => LINE.exec(l)?.[2])).toEqual(['明天']);
  });

  it('多行文本拆成多行，每行都带时间；空行不写', () => {
    const root = tmpLogRoot();
    const log = new DailyLog(root);
    log.append('Error: boom\n    at a (x.ts:1)\r\n\n    at b (y.ts:2)\n', at(10));
    expect(lines(join(root, 'minisd-2026-09-25.log')).map(l => LINE.exec(l)?.[2]))
      .toEqual(['Error: boom', '    at a (x.ts:1)', '    at b (y.ts:2)']);
  });

  it('单行过长就截短（一行几 MB 的输出不能一口吃掉当天的额度）', () => {
    const root = tmpLogRoot();
    new DailyLog(root).append('x'.repeat(1_000_000), at(10));
    expect(statSync(join(root, 'minisd-2026-09-25.log')).size).toBeLessThan(100_000);
  });

  it('日志目录被删了：下一次 append 重新建出来', () => {
    const root = join(tmpLogRoot(), 'logs');
    const log = new DailyLog(root);
    log.append('一', at(10));
    rmSync(root, { recursive: true, force: true });
    log.append('二', at(11));
    expect(lines(join(root, 'minisd-2026-09-25.log')).map(l => LINE.exec(l)?.[2])).toEqual(['二']);
  });

  it('写不进（日志目录其实是个普通文件）：append 与 prune 都不抛', () => {
    const plain = join(tmpLogRoot(), 'plain.txt');
    writeFileSync(plain, 'x');
    const log = new DailyLog(plain);
    expect(() => log.append('x', at(10))).not.toThrow();
    expect(() => log.prune(at(10))).not.toThrow();
    expect(() => new DailyLog(join(plain, 'sub')).append('x', at(10))).not.toThrow();
  });
});

describe('单日上限', () => {
  it('超过上限后只追加一次截断说明，之后当天不再写；重启（新实例）也不再写、不重复说明；第二天照常', () => {
    const root = tmpLogRoot();
    const file = join(root, 'minisd-2026-09-25.log');
    const log = new DailyLog(root, { maxBytes: 300 });
    for (let i = 0; i < 20; i++) log.append(`第 ${i} 行 ${'.'.repeat(20)}`, at(10, i));
    const got = lines(file);
    const notes = got.filter(l => /上限/.test(l));
    expect(notes, '恰好一行截断说明').toHaveLength(1);
    expect(got[got.length - 1], '截断说明是最后一行').toBe(notes[0]);
    expect(got.length).toBeLessThan(20);
    const size = statSync(file).size;
    expect(size).toBeLessThan(300 + 400);

    log.append('上限之后的一行', at(11));
    expect(statSync(file).size).toBe(size);
    new DailyLog(root, { maxBytes: 300 }).append('重启之后的一行', at(12));
    expect(statSync(file).size, '重启后当天仍然停写，也不再写第二遍说明').toBe(size);

    log.append('第二天', new Date(2026, 8, 26, 9, 0));
    expect(lines(join(root, 'minisd-2026-09-26.log')).map(l => LINE.exec(l)?.[2])).toEqual(['第二天']);
  });
});

describe('prune', () => {
  it('删掉超过 7 天的按天日志（8 天前删、7 天前与 6 天前留），别的文件一概不碰', () => {
    const root = tmpLogRoot();
    const now = at(9);
    const name = (daysAgo: number): string => `minisd-${localDateStamp(new Date(2026, 8, 25 - daysAgo, 12))}.log`;
    const keep = [name(0), name(1), name(6), name(7), 'crashes.json', 'minisd-garbage.log', 'other-2026-01-01.log', 'minisd-2026-01-01.log.bak'];
    const drop = [name(8), name(30), 'minisd-2025-12-31.log'];
    for (const f of [...keep, ...drop]) writeFileSync(join(root, f), 'x\n');
    mkdirSync(join(root, name(40)));   // 同名的目录：不是按天日志文件，不碰

    new DailyLog(root).prune(now);

    expect(readdirSync(root).sort()).toEqual([...keep, name(40)].sort());
  });

  it('跨月跨年也按日历天算', () => {
    const root = tmpLogRoot();
    for (const f of ['minisd-2025-12-24.log', 'minisd-2025-12-25.log', 'minisd-2025-12-31.log']) writeFileSync(join(root, f), 'x\n');
    new DailyLog(root).prune(new Date(2026, 0, 1, 8), 7);   // 2026-01-01：8 天前是 2025-12-24
    expect(readdirSync(root).sort()).toEqual(['minisd-2025-12-25.log', 'minisd-2025-12-31.log']);
  });

  it('目录不存在：什么也不做', () => {
    expect(() => new DailyLog(join(tmpLogRoot(), 'nope')).prune(at(9))).not.toThrow();
  });
});

describe('本地日期与 UTC 日期不同的时刻（东八区凌晨）', () => {
  it('前提：这个文件确实跑在东八区（否则下面几例又成了空转）', () => {
    expect(new Date(2026, 8, 25, 0, 30).getTimezoneOffset()).toBe(-480);
  });

  it('本地 2026-09-25 00:30（UTC 还是 09-24 16:30）写的一行：落在 25 号的文件，行首逐字是 +08:00 的本地时间', () => {
    const root = tmpLogRoot();
    const log = new DailyLog(root);
    const t = new Date(2026, 8, 25, 0, 30, 7, 123);
    expect(t.toISOString()).toBe('2026-09-24T16:30:07.123Z');
    log.append('[main] 凌晨的一行', t);
    expect(readdirSync(root)).toEqual(['minisd-2026-09-25.log']);
    expect(lines(join(root, 'minisd-2026-09-25.log'))).toEqual(['2026-09-25T00:30:07.123+08:00 [main] 凌晨的一行']);
  });

  it('按本地日历天清理：本地 2026-09-25 00:30 时删 17 号、留 18 号（按 UTC 算会差一天）', () => {
    const root = tmpLogRoot();
    for (const day of ['2026-09-17', '2026-09-18']) writeFileSync(join(root, `minisd-${day}.log`), 'x\n');
    new DailyLog(root).prune(new Date(2026, 8, 25, 0, 30));
    expect(readdirSync(root).sort()).toEqual(['minisd-2026-09-18.log']);
  });
});
