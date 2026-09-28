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
 *     GUID 是 appId 的 UUID v5（electron-builder 的算法），对 app-builder-lib 与真机报告里的值核对。 */
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
interface E2eM5Module {
  uninstallerPath(installDir: string): string;
  uninstallArgs(installDir: string): string[];
  uninstallSpawnOptions?(installDir: string): SpawnOpts;
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
/** NSIS 卸载程序认「就地运行」的办法（exehead 的 Main.c）：从命令行末尾往前找「 _?=」，其后整段就是安装目录；找不到就把自己拷到
 *  临时目录再起、原进程立刻退出。所以 _?= 要在最后、前面是空格、整段不带引号（NSIS 手册 3.2：路径有空格也不能加引号）。 */
function nsisInPlaceDir(cmdline: string): string | null {
  const p = cmdline.lastIndexOf(' _?=');
  return p < 0 ? null : cmdline.slice(p + 4);
}

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
    const { uninstallerPath, uninstallArgs, uninstallSpawnOptions } = await load();
    const dir = join('C:', 'Temp', 'DeskMinis Install ab12', 'Program Files', 'DeskMinis');
    const file = uninstallerPath(dir);
    const cmd = windowsCommandLine(file, uninstallArgs(dir), uninstallSpawnOptions?.(dir) ?? {});
    expect(nsisInPlaceDir(cmd), `卸载程序收到的命令行：${cmd}`).toBe(dir);
    // 程序名「Uninstall DeskMinis.exe」自己带空格：NSIS 按引号跳过程序名，不加引号就在第一个空格处断开
    expect(cmd.startsWith(`"${file}" `), cmd).toBe(true);
    expect(cmd).toContain(' /S ');
  });
});

describe('② 安装段：先卸载、后删目录，卸载结果记一行', () => {
  const src = read('scripts/e2e-m5-packaging.mjs');
  const at = src.search(/async function installAndVerify\(/);
  const body = at < 0 ? '' : src.slice(at, src.indexOf('\n}\n', at) + 2);
  const fin = body.slice(body.search(/\}\s*finally\s*\{/));

  it('finally 里先调 uninstallTemp(installDir)，再 rmSync(target, …)', () => {
    expect(body, '找不到 async function installAndVerify(').not.toBe('');
    const iUn = fin.search(/uninstallTemp\(\s*installDir\s*\)/);
    const iRm = fin.search(/rmSync\(\s*target\b/);
    expect(iUn, 'finally 里没有 uninstallTemp(installDir)').toBeGreaterThan(-1);
    expect(iRm, 'finally 里没有 rmSync(target, …)').toBeGreaterThan(iUn);
  });

  it('uninstallTemp 用 uninstallerPath / uninstallArgs / uninstallSpawnOptions 就地静默卸载，结果经 uninstallVerdict 记「§6-1 收尾」一行', () => {
    const at = src.search(/function uninstallTemp\(/);
    const u = src.slice(at, src.indexOf('\n}\n', at) + 2);
    expect(u).toMatch(/spawnSync\(\s*\w+\s*,\s*uninstallArgs\(\s*installDir\s*\)\s*,\s*\{\s*\.\.\.uninstallSpawnOptions\(\s*installDir\s*\)/);
    expect(u).toMatch(/uninstallerPath\(\s*installDir\s*\)/);
    expect(u, '结果要经 uninstallVerdict 判定').toMatch(/uninstallVerdict\(/);
    expect(src).toMatch(/const UNINSTALL_STEP = '§6-1 收尾：静默卸载临时安装'/);
    expect(src, '「§6-6」是 m5 计划里「六个桥逐一实测」的编号，不能再当这一行的名字').not.toMatch(/['"`]§6-6/);
  });

  it('装上了却找不到卸载程序：记一行 FAIL，不悄悄跳过（没装上时 §6-1 已记 FAIL，就没有要卸的）', () => {
    const at = src.search(/function uninstallTemp\(/);
    const u = src.slice(at, src.indexOf('\n}\n', at) + 2);
    const iIf = u.search(/if \(!existsSync\(un\)\)\s*\{/);
    expect(iIf, 'uninstallTemp 里没有「卸载程序不在」这一支').toBeGreaterThan(-1);
    // 只看这一支（到它的 return 为止），不让后面 catch 里的 record 蒙混过关
    const branch = u.slice(iIf, u.indexOf('return;', iIf));
    expect(branch).toMatch(/existsSync\(join\(installDir, 'DeskMinis\.exe'\)\)/);
    expect(branch).toMatch(/record\(UNINSTALL_STEP,\s*false/);
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
    expect(v.detail).toContain('已就地卸载');
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
      expect(v.detail, JSON.stringify(input)).not.toContain('已就地卸载');
      expect(v.detail, '失败时指向 RELEASE 的处理办法').toContain('RELEASE');
    }
  });
});
