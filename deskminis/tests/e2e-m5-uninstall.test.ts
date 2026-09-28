/** W3-e2e（设计稿 §4.1；0.3.0 真机验证报告 §3.3）：e2e:m5 跑完先就地静默卸载临时安装，再删目录。
 *
 *  e2e:m5 用与正式版同一个身份把安装包静默装进一个临时目录（/S /D=<临时目录>），以前跑完只删目录、不跑卸载：
 *  HKCU\Software\<GUID>\InstallLocation、「应用和功能」里的登记、开始菜单与桌面快捷方式都还指着那个已删的目录。
 *  NSIS 模板按「仅为我」安装时优先用这个 InstallLocation 当安装目录，没有目录页——之后照 RELEASE 重装，会被静默装进那个 Temp 路径
 *  （真机验证实测：向导第一页只有一行小字写着这个路径；存储感知或磁盘清理之后可能把程序本体删掉）。
 *
 *  脚本只在 Windows 上真跑；这里测三样：
 *  ① 卸载程序的路径与参数（纯函数）：名字随 electron-builder.yml 的 productName；/S 静默，_?=<目录> 让它就地跑、等卸完才返回
 *     （不加的话它先把自己拷到临时目录再起，spawnSync 立刻返回，删目录时它还没卸完）；_?= 必须是最后一个参数，
 *     而且整段不能带引号（审查修）：临时安装目录故意带空格，Node 在 Windows 上会给含空格的参数整段加引号，
 *     NSIS 就认不出「 _?=」、照没给处理。所以命令行按原样拼（windowsVerbatimArguments），程序名自己加引号（argv0）。
 *     这里按 libuv 拼命令行、NSIS 从命令行末尾找「 _?=」的规则算一遍卸载程序实际收到什么；
 *  ② 源码守卫：安装段的 finally 里先卸载、后删目录；卸载结果记一行（「§6-1 收尾」；W3-e2ec 起不叫 §6-6——
 *     m5 计划 §6 的第 6 项是「六个桥逐一实测」，脚本里的 §6-x 都指那份清单）；
 *  ③ 被 import 时不跑 CLI（以前模块顶层直接 main()，非 Windows 上 process.exit(2)，测试没法引它）；
 *  ④ W3-e2ec（W3-e2e 独立审查）：收尾的判定。以前只看退出码与 DeskMinis.exe，失败时也写成功的那句，超时与启动失败看不到错误码，
 *     也不核对真正要清掉的东西——HKCU\Software\<GUID> 的安装位置登记（下一次安装读的就是它）。
 *     GUID 是 appId 的 UUID v5（electron-builder 的算法），对 app-builder-lib 与真机报告里的值核对。
 *  ⑤ W3-e2ed（二审必修）：跑的是拷到安装目录之外的那一份卸载程序。electron-builder 的卸载程序静默运行时，在 un.onInit 里先把
 *     「路径以 $INSTDIR 开头的进程」一律结束（allowOnlyOneInstallerInstance.nsh，PowerShell 那一支不排除自己）——就地跑的卸载程序
 *     本身就在 $INSTDIR 里，会把自己结束掉、什么都没卸。electron-builder 卸旧版时也是先拷到 $PLUGINSDIR 再跑（installUtil.nsh）。
 *     收尾没做成就不删临时安装：卸载程序还在，「应用和功能」里能正常卸。reg 的退出码 1 是笼统的失败，先确认 reg 查得了再信「找不到」。
 *  ⑥ W3-e2ef（W3-e2ed 三审）：以前 ② 的源码守卫蒙得过去——「找不到卸载程序」那一支切到 `return;`，改成 return false 之后切到了函数尾，
 *     被 catch 里的 record 蒙过；副本落进安装目录、失败照样返回 true、reg 探测被跳过，也都能全绿。现在把 uninstallTemp 的
 *     exists / copy / spawn / record 换成假的真跑每一支，卸载程序照 electron-builder 模板演（在 $INSTDIR 里跑就把自己结束掉）。
 *     收尾 FAIL 时不再一律说「卸载程序还在」：按安装位置登记与卸载程序在不在分四种说怎么收拾，要删的是临时目录（含拷出来的卸载程序），
 *     RELEASE 第 2 节同一套说法；脚本指向 RELEASE 的段名要真有那一段（W3-e2ec 改了段名，脚本三处还指着旧名）。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(__dirname, '..');
const SCRIPT = join(root, 'scripts', 'e2e-m5-packaging.mjs');
/** 脚本导出的两个纯函数（.mjs 没有类型声明，照 tests/smoke-release.test.ts 的做法按路径动态 import） */
interface SpawnOpts { argv0?: string; windowsVerbatimArguments?: boolean }
interface Verdict { pass: boolean; detail: string }
interface VerdictInput { status: number | null; signal?: string | null; errorCode?: string; exeGone: boolean; registry: 'present' | 'absent' | 'unknown' }
interface SpawnResult { status: number | null; signal?: string | null; error?: { code: string } }
/** uninstallTemp 真去动文件、起进程、记结果的四样（W3-e2ef 起可注入） */
interface UninstallIo {
  exists(p: string): boolean;
  copy(from: string, to: string): void;
  spawn(file: string, args: string[], opts: Record<string, unknown>): SpawnResult;
  record(step: string, pass: boolean, detail: string): void;
}
interface E2eM5Module {
  uninstallTemp?(installDir: string, workDir: string, io?: UninstallIo): boolean;
  leftoverAdvice?(v: { registry: 'present' | 'absent' | 'unknown'; uninstallerLeft: boolean; workDir: string }): string;
  uninstallerPath(installDir: string): string;
  uninstallArgs(installDir: string): string[];
  uninstallSpawnOptions?(exePath: string): SpawnOpts;
  uninstallerCopyPath?(workDir: string): string;
  registryState?(probeStatus: number | null, queryStatus: number | null): 'present' | 'absent' | 'unknown';
  APP_ID?: string;
  ELECTRON_BUILDER_NS_UUID?: string;
  appGuid?(appId: string): string;
  uninstallVerdict?(v: VerdictInput): Verdict;
}
const load = async (): Promise<E2eM5Module> => (await import(pathToFileURL(SCRIPT).href)) as E2eM5Module;
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
/** Node 在 Windows 上起进程时的命令行：argv[0] 是 options.argv0（没给就是程序路径），后面接参数；
 *  libuv（win/process.c 的 make_program_args）在 windowsVerbatimArguments 时原样用空格连起来，否则含空格、制表符或引号的参数
 *  整段加引号（quote_cmd_arg；这里的路径不含引号、不以反斜杠结尾，不涉及它转义的那几种情形）。 */
function windowsCommandLine(file: string, args: string[], o: SpawnOpts): string {
  const argv = [o.argv0 ?? file, ...args];
  return argv.map(a => (o.windowsVerbatimArguments === true || !/[ \t"]/.test(a) ? a : `"${a}"`)).join(' ');
}
/** NSIS 卸载程序认「就地运行」的办法（exehead 的 Main.c）：从命令行末尾往前找「 _?=」，其后整段是 $INSTDIR 的初值；找不到就把自己拷到
 *  临时目录再起、原进程立刻退出。所以 _?= 要在最后、前面是空格、整段不带引号（NSIS 手册 3.2：路径有空格也不能加引号）。 */
function nsisInPlaceDir(cmdline: string): string | null {
  const p = cmdline.lastIndexOf(' _?=');
  return p < 0 ? null : cmdline.slice(p + 4);
}

/** ⑥ 的假世界：文件只认在不在；reg 与卸载程序照真东西的做法演。 */
const WORK = join('C:', 'Temp', 'DeskMinis Install ab12');
const INST = join(WORK, 'Program Files', 'DeskMinis');
const EXE = join(INST, 'DeskMinis.exe');
const UN = join(INST, 'Uninstall DeskMinis.exe');
interface World {
  files: Set<string>;
  /** HKCU\Software\<GUID> 的 InstallLocation 在不在 */
  registry: boolean;
  /** reg 查得了 HKCU\Software 本身（拒绝访问、组策略禁用注册表工具时查不了，退出码同样是 1） */
  regWorks: boolean;
  copies: Array<[string, string]>;
  runs: Array<{ file: string; args: string[]; opts: Record<string, unknown> }>;
  regs: string[][];
  recs: Array<{ step: string; pass: boolean; detail: string }>;
  io: UninstallIo;
}
type Uninstaller = (w: World, exe: string, args: string[]) => SpawnResult;
/** electron-builder 的卸载程序（uninstaller.nsh、allowOnlyOneInstallerInstance.nsh、multiUser.nsh）：没有 _?= 就拷到临时目录再起、
 *  原进程立刻退出；静默时 un.onInit 先结束路径以 $INSTDIR（这时是 _?= 给的目录）开头的进程——自己在里面就把自己结束了，什么也没卸；
 *  否则按 HKCU 登记的安装位置 RMDir /r（连原来那份卸载程序一起），最后删两处登记，退出码 0。 */
const nsisUninstaller: Uninstaller = (w, exe, args) => {
  const last = args[args.length - 1] ?? '';
  if (!last.startsWith('_?=')) return { status: 0 };
  if (exe.toLowerCase().startsWith(last.slice(3).toLowerCase())) return { status: 1 };
  for (const f of [...w.files]) if (f.startsWith(INST)) w.files.delete(f);
  w.registry = false;
  return { status: 0 };
};
function world(o: { uninstaller?: boolean; exe?: boolean; registry?: boolean; regWorks?: boolean; copyError?: string; uninstall?: Uninstaller } = {}): World {
  const w: World = {
    files: new Set([...((o.exe ?? true) ? [EXE] : []), ...((o.uninstaller ?? true) ? [UN] : [])]),
    registry: o.registry ?? true, regWorks: o.regWorks ?? true,
    copies: [], runs: [], regs: [], recs: [],
    io: {
      exists: p => w.files.has(p),
      copy: (from, to) => {
        if (o.copyError) throw Object.assign(new Error(`${o.copyError}: operation not permitted, copyfile '${from}' -> '${to}'`), { code: o.copyError });
        if (!w.files.has(from)) throw Object.assign(new Error(`ENOENT: no such file or directory, copyfile '${from}'`), { code: 'ENOENT' });
        w.copies.push([from, to]);
        w.files.add(to);
      },
      spawn: (file, args, opts) => {
        if (file === 'reg') {
          w.regs.push(args);
          if (!w.regWorks) return { status: 1 };
          return { status: args[1] === 'HKCU\\Software' || w.registry ? 0 : 1 };
        }
        w.runs.push({ file, args, opts });
        if (!w.files.has(file)) return { status: null, error: { code: 'ENOENT' } };
        return (o.uninstall ?? nsisUninstaller)(w, file, args);
      },
      record: (step, pass, detail) => { w.recs.push({ step, pass, detail }); },
    },
  };
  return w;
}
/** 收尾那一行破折号后面的部分：按剩下的情形说怎么收拾 */
const advice = (detail: string): string => { const i = detail.indexOf('——'); return i < 0 ? '' : detail.slice(i + 2); };

describe('① 卸载程序的路径与参数', () => {
  it('路径：安装目录下的「Uninstall <productName>.exe」', async () => {
    const { uninstallerPath } = await load();
    const product = /^productName:\s*(.+?)\s*$/m.exec(read('electron-builder.yml'))?.[1];
    expect(product, 'electron-builder.yml 里没有 productName').toBeTruthy();
    expect(uninstallerPath(join('C:', 'Temp', 'x', 'DeskMinis'))).toBe(join('C:', 'Temp', 'x', 'DeskMinis', `Uninstall ${product}.exe`));
  });

  it('参数：/S 静默、_?=<安装目录> 就地运行并等卸完；_?= 在最后', async () => {
    const { uninstallArgs } = await load();
    const dir = join('C:', 'Temp', 'DeskMinis Install ab12', 'Program Files', 'DeskMinis');
    const args = uninstallArgs(dir);
    expect(args).toEqual(['/S', `_?=${dir}`]);
    expect(args[args.length - 1].startsWith('_?=')).toBe(true);
  });

  it('安装目录带空格（脚本故意的）：卸载程序收到的命令行末尾是不带引号的「 _?=<目录>」，程序名带引号，/S 在前', async () => {
    const { uninstallerCopyPath, uninstallArgs, uninstallSpawnOptions } = await load();
    const work = join('C:', 'Temp', 'DeskMinis Install ab12');
    const dir = join(work, 'Program Files', 'DeskMinis');
    expect(uninstallerCopyPath, '脚本没有导出 uninstallerCopyPath').toBeTypeOf('function');
    const exe = uninstallerCopyPath!(work);
    const cmd = windowsCommandLine(exe, uninstallArgs(dir), uninstallSpawnOptions?.(exe) ?? {});
    expect(nsisInPlaceDir(cmd), `卸载程序收到的命令行：${cmd}`).toBe(dir);
    // 程序路径自己带空格（临时目录名）：NSIS 按引号跳过程序名，不加引号就在第一个空格处断开
    expect(cmd.startsWith(`"${exe}" `), cmd).toBe(true);
    expect(cmd).toContain(' /S ');
  });

  it('跑的那一份在安装目录之外（W3-e2ed）：electron-builder 的卸载程序静默时先结束路径以 $INSTDIR 开头的进程，不排除自己', async () => {
    const { uninstallerCopyPath } = await load();
    const work = join('C:', 'Temp', 'DeskMinis Install ab12');
    const dir = join(work, 'Program Files', 'DeskMinis');
    const exe = uninstallerCopyPath!(work);
    // 那边是不分大小写的 StartsWith、不带分隔符（…\DeskMinis-un\ 这样的兄弟目录同样会中）
    expect(exe.toLowerCase().startsWith(dir.toLowerCase()), exe).toBe(false);
    const tpl = readFileSync(join(root, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'allowOnlyOneInstallerInstance.nsh'), 'utf8');
    expect(tpl, '模板认进程的办法变了：回头核一下还要不要拷出去再跑').toMatch(/StartsWith\('\$INSTDIR'/);
  });
});

describe('② 安装段：先卸载、后删目录，卸载结果记一行', () => {
  const src = read('scripts/e2e-m5-packaging.mjs');
  const at = src.search(/async function installAndVerify\(/);
  const body = at < 0 ? '' : src.slice(at, src.indexOf('\n}\n', at) + 2);
  const fin = body.slice(body.search(/\}\s*finally\s*\{/));

  it('finally 里先调 uninstallTemp(installDir, target)，卸干净了才 rmSync(target, …)；没做成就留着临时安装（W3-e2ed）', () => {
    expect(body, '找不到 async function installAndVerify(').not.toBe('');
    const iUn = fin.search(/if \(uninstallTemp\(\s*installDir\s*,\s*target\s*\)\)\s*\{/);
    const iRm = fin.search(/rmSync\(\s*target\b/);
    expect(iUn, 'finally 里没有 if (uninstallTemp(installDir, target)) {').toBeGreaterThan(-1);
    expect(iRm, 'finally 里没有 rmSync(target, …)').toBeGreaterThan(iUn);
    expect(fin.slice(iRm), '删目录要带重试（杀软可能还攥着刚退出的卸载程序）').toMatch(/maxRetries/);
    // 没做成时说一声没删、去哪看怎么收拾（W3-e2ef）：怎么收拾按剩下的情形分，写在「§6-1 收尾」那一行里（⑥ 真跑核对），
    // 这里不能再一律说「卸载程序还在、到『应用和功能』里卸」；要删的是临时目录 target，不是安装目录
    const els = fin.slice(fin.search(/\}\s*else\s*\{/));
    expect(els, '没做成时要说一声').toMatch(/^\}\s*else\s*\{[\s\S]*console\.log\(/);
    expect(els, '指向 RELEASE 第 2 节讲收拾办法的那一段').toMatch(/RELEASE 第 2 节/);
    expect(els, '不能一律说卸载程序还在').not.toMatch(/卸载程序还在/);
    expect(els, '要删的是临时目录（含拷出来的卸载程序），不是安装目录').not.toMatch(/\$\{installDir\}/);
  });

  it('uninstallTemp 用 uninstallerPath 找卸载程序，结果经 uninstallVerdict 记「§6-1 收尾」一行（拷到哪、跑哪一份、带什么参数由 ⑥ 真跑核对）', () => {
    const at = src.search(/function uninstallTemp\(/);
    const u = src.slice(at, src.indexOf('\n}\n', at) + 2);
    expect(u).toMatch(/uninstallerPath\(\s*installDir\s*\)/);
    expect(u, '结果要经 uninstallVerdict 判定').toMatch(/uninstallVerdict\(/);
    expect(src).toMatch(/const UNINSTALL_STEP = '§6-1 收尾：静默卸载临时安装'/);
    expect(src, '「§6-6」是 m5 计划里「六个桥逐一实测」的编号，不能再当这一行的名字').not.toMatch(/['"`]§6-6/);
  });
});

describe('③ 被 import 时不跑 CLI', () => {
  it('模块顶层不直接 main()：只在直接运行时跑（与 smoke-release.mjs 同一认法）', () => {
    const src = read('scripts/e2e-m5-packaging.mjs');
    expect(src).not.toMatch(/^main\(\)/m);
    expect(src).toMatch(/if \(invokedDirectly\) \{?\s*main\(\)/);
  });
});

describe('④ 收尾的判定（W3-e2ec）', () => {
  it('APP_ID 与 electron-builder.yml 的 appId 一致', async () => {
    const { APP_ID } = await load();
    expect(APP_ID).toBe(/^appId:\s*(.+?)\s*$/m.exec(read('electron-builder.yml'))?.[1]);
  });

  it('appGuid：与 electron-builder 同一算法（UUID v5，命名空间取自 app-builder-lib），也与真机报告里的登记键一致', async () => {
    const { appGuid, APP_ID, ELECTRON_BUILDER_NS_UUID } = await load();
    expect(appGuid, '脚本没有导出 appGuid').toBeTypeOf('function');
    const nsis = readFileSync(join(root, 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js'), 'utf8');
    const ns = /ELECTRON_BUILDER_NS_UUID = [\w.]*UUID\.parse\("([0-9a-f-]+)"\)/.exec(nsis)?.[1];
    expect(ns, 'app-builder-lib 里找不到 ELECTRON_BUILDER_NS_UUID').toBeTruthy();
    expect(ELECTRON_BUILDER_NS_UUID).toBe(ns);
    const { UUID } = await import('builder-util-runtime');
    expect(appGuid!(APP_ID!)).toBe(UUID.v5(APP_ID!, UUID.parse(ns!)));
    // 0.3.0 真机验证报告 §3.3：HKCU\Software\ecb7325e-…\InstallLocation 指着已删的 Temp 路径
    expect(appGuid!('com.deskminis.app')).toBe('ecb7325e-e9df-5c5e-b187-bf7bd15b6aa7');
  });

  const ok: VerdictInput = { status: 0, signal: null, exeGone: true, registry: 'absent' };
  it('三样都成（正常退出、DeskMinis.exe 删了、安装位置登记清了）才 PASS', async () => {
    const { uninstallVerdict } = await load();
    expect(uninstallVerdict, '脚本没有导出 uninstallVerdict').toBeTypeOf('function');
    const v = uninstallVerdict!(ok);
    expect(v.pass).toBe(true);
    expect(v.detail).toContain('已静默卸载');
  });

  it('任何一样没成就 FAIL，说明写实际情况——不再套用成功的那句；超时、启动失败带错误码与信号', async () => {
    const { uninstallVerdict } = await load();
    const cases: Array<[VerdictInput, RegExp]> = [
      [{ ...ok, status: 2 }, /退出码 2/],
      [{ ...ok, status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT' }, /ETIMEDOUT[\s\S]*SIGTERM/],
      [{ ...ok, status: null, errorCode: 'ENOENT' }, /ENOENT/],
      [{ ...ok, exeGone: false }, /DeskMinis\.exe 还在/],
      [{ ...ok, registry: 'present' }, /安装位置登记还在/],
      [{ ...ok, registry: 'unknown' }, /查不了安装位置登记/],
    ];
    for (const [input, reason] of cases) {
      const v = uninstallVerdict!(input);
      expect(v.pass, JSON.stringify(input)).toBe(false);
      expect(v.detail, JSON.stringify(input)).toMatch(reason);
      expect(v.detail, JSON.stringify(input)).not.toContain('已静默卸载');
      // 判定只写哪里没成；怎么收拾由 uninstallTemp 按剩下的情形接在破折号后面（W3-e2ef，⑥ 真跑核对），RELEASE 第 2 节也按破折号后面的说法认
      expect(v.detail, JSON.stringify(input)).not.toContain('——');
    }
  });
});

describe('⑤ 登记状态（W3-e2ed）', () => {
  it('先确认 reg 查得了（HKCU\\Software 本身），再按查询结果认：0 在、1 不在；查不了一律算「查不了」', async () => {
    const { registryState } = await load();
    expect(registryState, '脚本没有导出 registryState').toBeTypeOf('function');
    expect(registryState!(0, 0)).toBe('present');
    expect(registryState!(0, 1)).toBe('absent');
    expect(registryState!(0, null)).toBe('unknown');
    // reg 的退出码 1 是笼统的失败：拒绝访问、组策略禁用了注册表工具，也是 1——不能当「清掉了」
    expect(registryState!(1, 1)).toBe('unknown');
    expect(registryState!(null, 1)).toBe('unknown');
  });
});

describe('⑥ 收尾真跑一遍（W3-e2ef：exists / copy / spawn / record 换成假的）', () => {
  const STEP = '§6-1 收尾：静默卸载临时安装';

  it('卸干净：卸载程序拷到安装目录之外（临时安装的上两层）再跑，带 /S 与 _?=<安装目录>、按原样拼命令行；记一行 PASS，返回 true', async () => {
    const { uninstallTemp, uninstallerPath, uninstallerCopyPath, uninstallArgs, uninstallSpawnOptions } = await load();
    expect(uninstallTemp, '脚本没有导出 uninstallTemp').toBeTypeOf('function');
    const w = world();
    expect(uninstallTemp!(INST, WORK, w.io)).toBe(true);
    const copy = uninstallerCopyPath!(WORK);
    expect(w.copies).toEqual([[uninstallerPath(INST), copy]]);
    expect(w.runs.map(r => r.file), '跑的是拷出去的那一份，安装目录里那份一次也不跑').toEqual([copy]);
    expect(w.runs[0].file.toLowerCase().startsWith(INST.toLowerCase())).toBe(false);
    expect(w.runs[0].args).toEqual(uninstallArgs(INST));
    expect(w.runs[0].opts).toMatchObject({ ...uninstallSpawnOptions!(copy), windowsHide: true });
    expect(w.runs[0].opts.timeout, '卸载程序卡住也要有个头').toBeGreaterThan(0);
    expect(w.recs).toEqual([{ step: STEP, pass: true, detail: expect.stringContaining('已静默卸载') }]);
    expect(w.files.has(EXE)).toBe(false);
    expect(w.registry).toBe(false);
  });

  it('卸载程序没卸成（退出码 2，什么也没删）：记 FAIL、返回 false（临时安装留着）；卸载程序还在，就到「应用和功能」里卸，再删临时目录', async () => {
    const { uninstallTemp } = await load();
    const w = world({ uninstall: () => ({ status: 2 }) });
    expect(uninstallTemp!(INST, WORK, w.io)).toBe(false);
    expect(w.recs).toHaveLength(1);
    expect(w.recs[0]).toMatchObject({ step: STEP, pass: false });
    expect(w.recs[0].detail).toMatch(/退出码 2/);
    const a = advice(w.recs[0].detail);
    expect(a).toMatch(/^卸载程序还在：/);
    expect(a).toContain('到「应用和功能」里卸载 DeskMinis');
    expect(a, '要删的是临时目录（含拷出来的卸载程序），不是安装目录').toContain(`删掉临时目录 ${WORK}`);
    expect(a).not.toContain(INST);
  });

  it('卸到一半（超时被结束：原来那份卸载程序已删、DeskMinis.exe 与登记还在）：「应用和功能」里卸不掉，不能叫人去那里卸', async () => {
    const { uninstallTemp } = await load();
    const w = world({ uninstall: w => { w.files.delete(UN); return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }; } });
    expect(uninstallTemp!(INST, WORK, w.io)).toBe(false);
    expect(w.recs).toHaveLength(1);
    expect(w.recs[0].pass).toBe(false);
    expect(w.recs[0].detail).toMatch(/ETIMEDOUT[\s\S]*SIGTERM/);
    const a = advice(w.recs[0].detail);
    expect(a).toMatch(/^卸载程序已经不在了：/);
    expect(a).toContain('「应用和功能」里卸不掉');
    expect(a).not.toContain('到「应用和功能」里卸载');
    expect(a).toContain('RELEASE 第 2 节「登记还在、卸载程序没了」');
    expect(a).toContain(`删掉临时目录 ${WORK}`);
  });

  it('卸载程序走完了（退出码 0、登记已清）只是 DeskMinis.exe 删不掉：只需删临时目录，不用再卸', async () => {
    const { uninstallTemp } = await load();
    const w = world({ uninstall: w => { w.files.delete(UN); w.registry = false; return { status: 0 }; } });
    expect(uninstallTemp!(INST, WORK, w.io)).toBe(false);
    expect(w.recs).toHaveLength(1);
    expect(w.recs[0].pass).toBe(false);
    expect(w.recs[0].detail).toMatch(/DeskMinis\.exe 还在/);
    const a = advice(w.recs[0].detail);
    expect(a).toMatch(/^安装位置登记已清：/);
    expect(a).toContain(`只需删掉临时目录 ${WORK}`);
    expect(a).not.toMatch(/里卸载/);
  });

  it('reg 查不了（HKCU\\Software 本身也查不了）：卸载程序其实跑完了也记 FAIL，给出自己查登记的命令，并按卸载程序在不在给后一步', async () => {
    const { uninstallTemp, appGuid, APP_ID } = await load();
    const w = world({ regWorks: false });
    expect(uninstallTemp!(INST, WORK, w.io)).toBe(false);
    expect(w.regs.map(a => a[1]), '先探 HKCU\\Software 本身').toContain('HKCU\\Software');
    expect(w.recs).toHaveLength(1);
    expect(w.recs[0].pass).toBe(false);
    expect(w.recs[0].detail).toMatch(/查不了安装位置登记/);
    const a = advice(w.recs[0].detail);
    expect(a).toMatch(/^先在 PowerShell 里查登记：/);
    expect(a).toContain(`Test-Path 'HKCU:\\Software\\${appGuid!(APP_ID!)}'`);
    // 原来那份卸载程序已经跟着安装目录删了：登记要是还在，「应用和功能」里也卸不掉
    expect(a).toContain('RELEASE 第 2 节「登记还在、卸载程序没了」');
    expect(a).not.toContain('到「应用和功能」里卸载');
    expect(a).toContain(`删掉临时目录 ${WORK}`);
  });

  it('拷卸载程序出错（EPERM）：记 FAIL、返回 false，不跑卸载程序；卸载程序还在，到「应用和功能」里卸', async () => {
    const { uninstallTemp } = await load();
    const w = world({ copyError: 'EPERM' });
    expect(uninstallTemp!(INST, WORK, w.io)).toBe(false);
    expect(w.runs).toEqual([]);
    expect(w.recs).toHaveLength(1);
    expect(w.recs[0]).toMatchObject({ step: STEP, pass: false });
    expect(w.recs[0].detail).toMatch(/卸载异常[\s\S]*EPERM/);
    const a = advice(w.recs[0].detail);
    expect(a).toMatch(/^卸载程序还在：/);
    expect(a).toContain(`删掉临时目录 ${WORK}`);
  });

  it('装上了却找不到卸载程序：记一行 FAIL（不悄悄跳过）、返回 false，不跑卸载程序；「应用和功能」里卸不掉', async () => {
    const { uninstallTemp } = await load();
    const w = world({ uninstaller: false });
    expect(uninstallTemp!(INST, WORK, w.io)).toBe(false);
    expect(w.copies).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.recs).toHaveLength(1);
    expect(w.recs[0]).toMatchObject({ step: STEP, pass: false });
    expect(w.recs[0].detail).toContain(`找不到卸载程序 ${UN}`);
    const a = advice(w.recs[0].detail);
    expect(a).toMatch(/^卸载程序已经不在了：/);
    expect(a).toContain(`删掉临时目录 ${WORK}`);
  });

  it('没装上（DeskMinis.exe 与卸载程序都不在）：§6-1 已记 FAIL，这里不记、不跑任何东西，返回 true（临时目录照删）', async () => {
    const { uninstallTemp } = await load();
    const w = world({ exe: false, uninstaller: false, registry: false });
    expect(uninstallTemp!(INST, WORK, w.io)).toBe(true);
    expect(w.recs).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.regs).toEqual([]);
  });
});

describe('⑦ 与 RELEASE 第 2 节对得上（W3-e2ef）', () => {
  const release = read('../docs/RELEASE.md');
  const s2 = release.slice(release.indexOf('\n## 2.'), release.indexOf('\n## 3.'));

  it('脚本里每一处「RELEASE 第 2 节『…』」都真有那一段（W3-e2ec 把段名改了，脚本三处还指着旧名「收尾没做成」）', () => {
    expect(s2, 'RELEASE.md 里找不到第 2 节').not.toBe('');
    const src = read('scripts/e2e-m5-packaging.mjs');
    const names = [...src.matchAll(/RELEASE 第 2 节「([^」]+)」/g)].map(m => m[1].replace(/『/g, '「').replace(/』/g, '」'));
    expect(names.length, '脚本里没有指向 RELEASE 第 2 节的地方').toBeGreaterThan(0);
    for (const name of new Set(names)) expect(s2, `RELEASE 第 2 节没有加粗的「${name}」这一段`).toContain(`**${name}**`);
  });

  it('收尾没做成的四种情形，第 2 节的表逐条都有（按破折号后面的开头认）', async () => {
    const { leftoverAdvice } = await load();
    expect(leftoverAdvice, '脚本没有导出 leftoverAdvice').toBeTypeOf('function');
    const cases = [
      { registry: 'absent', uninstallerLeft: false },
      { registry: 'present', uninstallerLeft: true },
      { registry: 'present', uninstallerLeft: false },
      { registry: 'unknown', uninstallerLeft: true },
      { registry: 'unknown', uninstallerLeft: false },
    ] as const;
    const leads = cases.map(c => leftoverAdvice!({ ...c, workDir: WORK }).split('：')[0]);
    expect(new Set(leads).size, `四种情形要四种说法：${leads.join(' / ')}`).toBe(4);
    const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const lead of leads) expect(s2, `第 2 节的表里没有「${lead}」这一行`).toMatch(new RegExp(`^> \\| ${esc(lead)} \\|`, 'm'));
  });
});
