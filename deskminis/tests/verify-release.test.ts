/**
 * W2b-10 · 发布校验脚本 scripts/verify-release.mjs（止血设计稿 §4 W2b-10、§5 第 2、4 条；侦察 release.md「W2b-verifyrelease」；cross.md S28）。
 *
 * 为什么要它：发布资产一旦传错，坏的是所有已装用户——latest.yml 的 sha512 与安装包对不上，
 * electron-updater 下载完就报 ERR_CHECKSUM_MISMATCH 丢弃；漏传 latest.yml，更新永远查不到；
 * 漏了 blockmap，下一版没法差分下载；app-update.yml 还指着私有源码仓，装出去的应用永远 404；
 * 安装包里没有 LICENSE 与第三方署名，违反 MIT / Apache-2.0 / OFL 的随附要求。
 * 这些在 Windows 真机上打包之后才看得见，所以脚本只读 dist 目录、零依赖，在 Linux 上用假 dist 就能钉住。
 *
 * 假 dist 的形状照 electron-builder 26.15.3 的真实输出：latest.yml 由 js-yaml 写出（releaseDate 带单引号），
 * blockmap 是 gzip 压过的 JSON（version '2'，sizes 之和等于安装包字节数）。
 * 另有一例直接用 electron-builder 自己的序列化器与块表生成器造 dist，证明自写的最小 YAML 解析认得它的真实输出。
 *
 * 每个反例都断言「只有一行 FAIL，且这行说的是它」：各自失败、各自给出中文原因，不靠别的检查顺带变红。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { serializeToYaml } from 'builder-util';
import { buildBlockMap } from 'app-builder-lib/out/targets/blockmap/blockmap';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(appRoot, '..');
const SCRIPT = join(appRoot, 'scripts', 'verify-release.mjs');
const VERSION = (JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version: string }).version;

/** 脚本导出的两个入口（.mjs 没有类型声明，动态导入时在这里补上形状）。 */
interface LatestFile { url?: string; sha512?: string; size?: number }
interface LatestYml { version?: string; path?: string; sha512?: string; releaseDate?: string; files: LatestFile[] }
interface CheckResult { status: 'PASS' | 'FAIL' | 'SKIP'; step: string; detail: string }
interface VerifyModule {
  parseLatestYml(text: string): LatestYml;
  verifyRelease(opts: { distDir: string; version: string; projectDir?: string }): Promise<{ results: CheckResult[]; failed: number }>;
}
const loadModule = async (): Promise<VerifyModule> => (await import(pathToFileURL(SCRIPT).href)) as VerifyModule;

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha512 = (buf: Buffer): string => createHash('sha512').update(buf).digest('base64');

/** electron-builder（js-yaml dump，lineWidth 8000）写 latest.yml 的样子，逐字照抄。 */
function latestYmlText(v: { version: string; url: string; sha512: string; size: number }): string {
  return [
    `version: ${v.version}`,
    'files:',
    `  - url: ${v.url}`,
    `    sha512: ${v.sha512}`,
    `    size: ${v.size}`,
    `path: ${v.url}`,
    `sha512: ${v.sha512}`,
    "releaseDate: '2026-09-25T08:00:00.000Z'",
    '',
  ].join('\n');
}

/**
 * 块表：electron-builder 把整个安装包切成若干块，sizes 之和就是安装包字节数。
 * version 与 checksums 条数可改，专供反例造「只有这一处不对」的块表（块长之和仍覆盖安装包，别的检查照过）。
 */
function blockmapBytes(sizes: number[], opts: { version?: string; checksumCount?: number } = {}): Buffer {
  const checksums = Array.from({ length: opts.checksumCount ?? sizes.length },
    (_, i) => createHash('sha256').update(String(i)).digest('base64').slice(0, 24));
  const map = { version: opts.version ?? '2', files: [{ name: 'file', offset: 0, checksums, sizes }] };
  return gzipSync(Buffer.from(JSON.stringify(map)));
}

interface MockDist {
  dir: string;
  setupName: string;
  setupPath: string;
  ymlPath: string;
  blockmapPath: string;
  portablePath: string;
  resources: string;
}

/**
 * 按 npm run dist 的产物布局造一个假 dist：Setup.exe（64KB 随机字节）+ .blockmap + 便携版 + latest.yml，
 * 以及 win-unpacked/resources 下的 app-update.yml、LICENSE.txt、THIRD-PARTY-NOTICES.md（随包许可取仓库根的真文件）。
 */
function makeDist(opts: { root?: string; version?: string; owner?: string; repo?: string } = {}): MockDist {
  const version = opts.version ?? VERSION;
  const dir = opts.root ?? tempDir('dm-verify-');
  mkdirSync(dir, { recursive: true });
  const setupName = `DeskMinis-${version}-Setup.exe`;
  const setupPath = join(dir, setupName);
  const setup = randomBytes(64 * 1024);
  writeFileSync(setupPath, setup);
  const blockmapPath = `${setupPath}.blockmap`;
  writeFileSync(blockmapPath, blockmapBytes([16384, 16384, 16384, 16384]));
  const portablePath = join(dir, `DeskMinis-${version}-win-x64-portable.exe`);
  writeFileSync(portablePath, randomBytes(32 * 1024));
  const ymlPath = join(dir, 'latest.yml');
  writeFileSync(ymlPath, latestYmlText({ version, url: setupName, sha512: sha512(setup), size: setup.length }));
  const resources = join(dir, 'win-unpacked', 'resources');
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, 'app-update.yml'),
    `owner: ${opts.owner ?? 'lincheuk'}\nrepo: ${opts.repo ?? 'deskminis-releases'}\nprovider: github\nupdaterCacheDirName: deskminis-updater\n`);
  copyFileSync(join(repoRoot, 'LICENSE'), join(resources, 'LICENSE.txt'));
  copyFileSync(join(repoRoot, 'THIRD-PARTY-NOTICES.md'), join(resources, 'THIRD-PARTY-NOTICES.md'));
  return { dir, setupName, setupPath, ymlPath, blockmapPath, portablePath, resources };
}

/** 照 npm run verify:release 的方式起脚本：cwd 是工程目录，Electron 当 Node 跑（先例 tests/bridge-cli.test.ts）。 */
function run(args: string[], cwd = appRoot): { code: number | null; out: string; fails: string[] } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { code: r.status, out, fails: out.split(/\r?\n/).filter((l) => l.startsWith('FAIL')) };
}

const editYml = (d: MockDist, from: RegExp, to: string): void => {
  const text = readFileSync(d.ymlPath, 'utf8');
  expect(text).toMatch(from);
  writeFileSync(d.ymlPath, text.replace(from, to));
};

describe('verify-release：正例', () => {
  it('完整的 dist：退出 0，逐项 PASS，没有 FAIL', () => {
    const d = makeDist();
    const r = run(['--dist', d.dir]);
    expect(r.fails, r.out).toEqual([]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^PASS/m);
    // 八项里每一项都真的核对过，不是一路 SKIP 过去的
    for (const step of ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧']) {
      expect(r.out, `缺 ${step} 的 PASS 行`).toMatch(new RegExp(`^PASS\\s+\\[${step}`, 'm'));
    }
    expect(r.out).not.toMatch(/^SKIP/m);
  });

  it('用 electron-builder 自己的序列化器与块表生成器造的 dist 照样全过（自写 YAML 解析认得真实输出）', async () => {
    const d = makeDist();
    const setup = randomBytes(200_000);
    writeFileSync(d.setupPath, setup);
    const info = await buildBlockMap(d.setupPath, 'gzip', d.blockmapPath);
    writeFileSync(d.ymlPath, serializeToYaml({
      version: VERSION,
      files: [{ url: d.setupName, sha512: info.sha512, size: info.size }],
      path: d.setupName,
      sha512: info.sha512,
      releaseDate: new Date().toISOString(),
    }));
    writeFileSync(join(d.resources, 'app-update.yml'), serializeToYaml({
      owner: 'lincheuk', repo: 'deskminis-releases', provider: 'github', updaterCacheDirName: 'deskminis-updater',
    }));
    const r = run(['--dist', d.dir]);
    expect(r.fails, r.out).toEqual([]);
    expect(r.code, r.out).toBe(0);
  });

  it('从公开 Release 下载回来的四件（没有 win-unpacked）：退出 0，⑦⑧ 写明 SKIP 的原因', () => {
    const d = makeDist();
    rmSync(join(d.dir, 'win-unpacked'), { recursive: true, force: true });
    const r = run(['--dist', d.dir]);
    expect(r.fails, r.out).toEqual([]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^SKIP\s+\[⑦[^\n]*win-unpacked/m);
    expect(r.out).toMatch(/^SKIP\s+\[⑧[^\n]*win-unpacked/m);
  });

  it('--version 显式指定时按它核对（与 package.json 不同也行）', () => {
    const d = makeDist({ version: '9.8.7' });
    const r = run(['--dist', d.dir, '--version', '9.8.7']);
    expect(r.fails, r.out).toEqual([]);
    expect(r.code, r.out).toBe(0);
  });
});

describe('verify-release：反例各自失败并给出中文原因', () => {
  it('安装包改了一个字节（sha512 不符）：退出 1，点名文件与 ERR_CHECKSUM_MISMATCH', () => {
    const d = makeDist();
    const buf = readFileSync(d.setupPath);
    buf[1000] ^= 0xff;
    writeFileSync(d.setupPath, buf);
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain(`${d.setupName} 的 sha512 与 latest.yml 不符`);
    expect(r.fails[0]).toContain('ERR_CHECKSUM_MISMATCH');
  });

  it('缺 latest.yml：退出 1，说清它是 electron-updater 发现新版的依据', () => {
    const d = makeDist();
    unlinkSync(d.ymlPath);
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('缺 latest.yml');
    expect(r.fails[0]).toContain('electron-updater');
  });

  it('缺 blockmap：退出 1，说清下一版没法差分下载', () => {
    const d = makeDist();
    unlinkSync(d.blockmapPath);
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('缺 blockmap');
    expect(r.fails[0]).toContain('差分');
  });

  it('blockmap 不是 gzip：退出 1', () => {
    const d = makeDist();
    writeFileSync(d.blockmapPath, JSON.stringify({ version: '2', files: [] }));
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('gzip');
  });

  it('blockmap 是旧安装包的（块长之和对不上）：退出 1', () => {
    const d = makeDist();
    writeFileSync(d.blockmapPath, blockmapBytes([16384, 16384]));
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('不是这个安装包的块表');
  });

  it('blockmap 解压后 version 是 "1"（旧格式）：退出 1，说出实际值与应有值', () => {
    const d = makeDist();
    // gzip 对、块长之和照旧等于安装包字节数，只有 version 不对——能拦下它的只有 version 这一项
    writeFileSync(d.blockmapPath, blockmapBytes([16384, 16384, 16384, 16384], { version: '1' }));
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain(`${d.setupName}.blockmap 的 version 是 "1"`);
    expect(r.fails[0]).toContain('应为 "2"');
  });

  it('blockmap 的 checksums 比 sizes 少一条：退出 1，块表结构不对', () => {
    const d = makeDist();
    // 块长之和仍是 65536，只有两个数组不等长——electron-updater 按下标把块长与校验和配对，少一条就错位
    writeFileSync(d.blockmapPath, blockmapBytes([16384, 16384, 16384, 16384], { checksumCount: 3 }));
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('块表结构不对');
  });

  it('latest.yml 的 version 是 0.0.1：退出 1，说 dist 里是旧产物', () => {
    const d = makeDist();
    editYml(d, /^version: .*$/m, 'version: 0.0.1');
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain(`latest.yml 是 0.0.1 版，package.json 是 ${VERSION} 版`);
    expect(r.fails[0]).toContain('旧产物');
  });

  it('latest.yml 记的 size 与安装包不符：退出 1', () => {
    const d = makeDist();
    editYml(d, /^ {4}size: \d+$/m, '    size: 65537');
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('实际 65536 字节，latest.yml 记的是 65537');
  });

  it('files[0] 的文件名不是本版安装包：退出 1', () => {
    const d = makeDist();
    const other = `DeskMinis-${VERSION}-Installer.exe`;
    copyFileSync(d.setupPath, join(d.dir, other));
    copyFileSync(d.blockmapPath, join(d.dir, `${other}.blockmap`));
    editYml(d, /^ {2}- url: .*$/m, `  - url: ${other}`);
    editYml(d, /^path: .*$/m, `path: ${other}`);
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain(`应为 ${d.setupName}`);
  });

  it('顶层 path 与 files[0] 不一致：退出 1', () => {
    const d = makeDist();
    editYml(d, /^path: .*$/m, 'path: DeskMinis-0.0.1-Setup.exe');
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('顶层 path');
  });

  it('只有顶层 sha512 与 files[0] 不一致（path 没动）：退出 1，点名顶层 sha512', () => {
    const d = makeDist();
    // 老版 electron-updater 读顶层 sha512；files[0] 那份仍与安装包相符，所以拦下它的只能是「顶层与 files[0] 一致」这一项
    const other = sha512(Buffer.from('另一个安装包'));
    editYml(d, /^sha512: .*$/m, `sha512: ${other}`);
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain(`顶层 sha512 是 ${other.slice(0, 12)}`);
    expect(r.fails[0]).not.toContain('顶层 path 是');
  });

  it('files 条目的 url 带目录（即使那个子目录里真有文件）：退出 1', () => {
    const d = makeDist();
    // 发布资产是平铺的，electron-updater 把 url 拼在 Release 下载地址后面；子目录里的文件上传后就对不上。
    // 子目录里放齐安装包与块表，好让「文件在不在、大小、哈希、块表」都能过，只剩「带目录」这一项拦它
    const nested = `win/${d.setupName}`;
    mkdirSync(join(d.dir, 'win'));
    copyFileSync(d.setupPath, join(d.dir, nested));
    copyFileSync(d.blockmapPath, join(d.dir, `${nested}.blockmap`));
    const setup = readFileSync(d.setupPath);
    editYml(d, /^path: /m, [
      `  - url: ${nested}`,
      `    sha512: ${sha512(setup)}`,
      `    size: ${setup.length}`,
      'path: ',
    ].join('\n'));
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain(`files[1] 的 url 带了目录（${nested}）`);
  });

  it('latest.yml 里有认不出的结构：退出 1，不去猜', () => {
    const d = makeDist();
    writeFileSync(d.ymlPath, `${readFileSync(d.ymlPath, 'utf8')}extra:\n  nested: 1\n`);
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('看不懂 latest.yml');
  });

  it('缺便携版：退出 1', () => {
    const d = makeDist();
    unlinkSync(d.portablePath);
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('便携版');
    expect(r.fails[0]).toContain(`DeskMinis-${VERSION}-win-x64-portable.exe`);
  });

  it('便携版在但是空文件：退出 1', () => {
    const d = makeDist();
    // 0 字节的文件照样「在」，传上去用户下载到的就是个空壳；只查存在拦不住它
    writeFileSync(d.portablePath, '');
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain(`便携版 DeskMinis-${VERSION}-win-x64-portable.exe 是空文件`);
  });

  it('app-update.yml 的仓库名与 publish 段不一致：退出 1，两边都点出来', () => {
    const d = makeDist({ repo: 'deskminis-release' });
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('与 electron-builder.yml 的 publish 段');
    expect(r.fails[0]).toContain('不一致');
    expect(r.fails[0]).toContain('lincheuk/deskminis-release）');
    expect(r.fails[0]).toContain('lincheuk/deskminis-releases）');
  });

  it('app-update.yml 的 owner 与 publish 段不一致（仓库名相同）：退出 1，两边都点出来', () => {
    // 同名仓库挂在别的账号下，更新就会去别人的 Release 拉安装包——owner 必须和 repo 一样逐项比
    const d = makeDist({ owner: 'someone-else' });
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('与 electron-builder.yml 的 publish 段');
    expect(r.fails[0]).toContain('不一致');
    expect(r.fails[0]).toContain('someone-else/deskminis-releases）');
    expect(r.fails[0]).toContain('lincheuk/deskminis-releases）');
  });

  it('app-update.yml 还指着私有源码仓 Deskminis：退出 1，说明外人拿不到', () => {
    const d = makeDist({ repo: 'Deskminis' });
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('私有源码仓');
  });

  it('本地打包的 dist 有 win-unpacked 却缺 app-update.yml：退出 1', () => {
    const d = makeDist();
    unlinkSync(join(d.resources, 'app-update.yml'));
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('缺 win-unpacked/resources/app-update.yml');
  });

  it('缺随包 LICENSE.txt：退出 1', () => {
    const d = makeDist();
    unlinkSync(join(d.resources, 'LICENSE.txt'));
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('缺 win-unpacked/resources/LICENSE.txt');
  });

  it('缺随包 THIRD-PARTY-NOTICES.md：退出 1', () => {
    const d = makeDist();
    unlinkSync(join(d.resources, 'THIRD-PARTY-NOTICES.md'));
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('缺 win-unpacked/resources/THIRD-PARTY-NOTICES.md');
  });

  it('随包 NOTICES 与仓库根不一致（改了署名没重新打包）：退出 1', () => {
    const d = makeDist();
    writeFileSync(join(d.resources, 'THIRD-PARTY-NOTICES.md'), '# 旧的第三方声明\n');
    const r = run(['--dist', d.dir]);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('与仓库根的 THIRD-PARTY-NOTICES.md 不一致');
  });

  it('版本缺省取 cwd 下的 package.json；publish 段本身指着私有源码仓也拦', () => {
    const root = tempDir('dm-verify-proj-');
    const proj = join(root, 'proj');
    mkdirSync(proj);
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }));
    writeFileSync(join(proj, 'electron-builder.yml'),
      'appId: x\n# 更新源\npublish:\n  provider: github  # 行尾注释\n  owner: lincheuk\n  repo: Deskminis\n');
    makeDist({ root: join(proj, 'dist'), version: '9.9.9', repo: 'Deskminis' });
    const r = run([], proj);
    expect(r.code, r.out).toBe(1);
    expect(r.fails, r.out).toHaveLength(1);
    expect(r.fails[0]).toContain('私有源码仓');
    // ③ 过了，说明版本取的是 cwd 下 package.json 的 9.9.9，dist 也是缺省的 <cwd>/dist
    expect(r.out).toMatch(/^PASS\s+\[③[^\n]*9\.9\.9/m);
  });
});

describe('verify-release：参数错误退 2', () => {
  // 各自断言原因：只看退出码的话，「不认识的参数被悄悄放过、再因缺省 dist 不存在退 2」也能蒙混过关
  it.each([
    [['--bogus'], '不认识的参数 --bogus'],
    [['--dist'], '--dist 后面缺值'],
    [['--version', 'abc'], '不是 x.y.z'],
    [['--dist', join(tmpdir(), 'dm-verify-no-such-dir-4b1d')], '产物目录不存在'],
  ])('%j → 退出 2：%s', (args, why) => {
    const r = run(args);
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain(why);
  });

  it('--help：打印用法，退出 0', () => {
    const r = run(['--help']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('--dist');
    expect(r.out).toContain('--version');
  });
});

describe('parseLatestYml（最小 YAML 解析，只认 electron-builder 的输出形状）', () => {
  const SHA = 'Ab+/cd==' + 'x'.repeat(80);

  it('读出含 + / = 的 sha512、数值型 size；单引号去壳', async () => {
    const { parseLatestYml } = await loadModule();
    const y = parseLatestYml(latestYmlText({ version: '0.3.0', url: 'DeskMinis-0.3.0-Setup.exe', sha512: SHA, size: 104857600 }));
    expect(y.version).toBe('0.3.0');
    expect(y.files).toEqual([{ url: 'DeskMinis-0.3.0-Setup.exe', sha512: SHA, size: 104857600 }]);
    expect(typeof y.files[0].size).toBe('number');
    expect(y.path).toBe('DeskMinis-0.3.0-Setup.exe');
    expect(y.sha512).toBe(SHA);
    expect(y.releaseDate).toBe('2026-09-25T08:00:00.000Z');
  });

  it('electron-builder 的序列化器写出什么就读回什么（含会被加引号的值与空 files）', async () => {
    const { parseLatestYml } = await loadModule();
    const src = {
      version: '1.0',
      files: [
        { url: 'a.exe', sha512: '+starts/with+plus==', size: 1 },
        { url: "it's.exe", sha512: SHA, size: 22 },
      ],
      path: 'a.exe',
      sha512: '+starts/with+plus==',
      releaseDate: '2026-09-25T08:00:00.000Z',
    };
    expect(parseLatestYml(serializeToYaml(src))).toEqual(src);
    expect(parseLatestYml(serializeToYaml({ ...src, files: [] })).files).toEqual([]);
  });

  it('files 条目里多出来的标量键（blockMapSize、isAdminRightsRequired）忽略，不报错', async () => {
    const { parseLatestYml } = await loadModule();
    const text = serializeToYaml({
      version: '0.3.0',
      files: [{ url: 'a.exe', sha512: SHA, size: 5, blockMapSize: 123, isAdminRightsRequired: true }],
      path: 'a.exe', sha512: SHA, releaseDate: '2026-09-25T08:00:00.000Z', stagingPercentage: 50,
    });
    expect(parseLatestYml(text).files).toEqual([{ url: 'a.exe', sha512: SHA, size: 5 }]);
  });

  it('CRLF 与 BOM 照样读；双引号值去壳', async () => {
    const { parseLatestYml } = await loadModule();
    const text = '﻿' + latestYmlText({ version: '0.3.0', url: 'a.exe', sha512: SHA, size: 7 })
      .replace("releaseDate: '2026-09-25T08:00:00.000Z'", 'releaseDate: "2026-09-25T08:00:00.000Z"')
      .replace(/\n/g, '\r\n');
    const y = parseLatestYml(text);
    expect(y.version).toBe('0.3.0');
    expect(y.files[0].size).toBe(7);
    expect(y.releaseDate).toBe('2026-09-25T08:00:00.000Z');
  });

  it.each([
    ['未知的嵌套键', 'version: 0.3.0\nextra:\n  nested: 1\n'],
    ['块标量', 'version: |\n  0.3.0\n'],
    ['流式映射', 'version: 0.3.0\nfiles: {url: a.exe}\n'],
    ['锚点', 'version: &v 0.3.0\n'],
    ['顶层缩进', '  version: 0.3.0\n'],
    ['条目下的更深嵌套', 'files:\n  - url: a.exe\n    extra:\n      deep: 1\n'],
    ['size 不是整数', 'files:\n  - url: a.exe\n    size: 12.5\n'],
    ['重复键', 'version: 0.3.0\nversion: 0.3.1\n'],
    ['未闭合的引号', "version: '0.3.0\n"],
  ])('认不出的结构直接抛错并带行号：%s', async (_name, text) => {
    const { parseLatestYml } = await loadModule();
    expect(() => parseLatestYml(text)).toThrow(/看不懂 latest\.yml 第 \d+ 行/);
  });
});

describe('verifyRelease 可在进程内调用（供测试与别的脚本复用）', () => {
  it('返回逐项结果与 FAIL 数，不打印、不退出进程', async () => {
    const { verifyRelease } = await loadModule();
    const d = makeDist();
    unlinkSync(d.portablePath);
    const { results, failed } = await verifyRelease({ distDir: d.dir, version: VERSION, projectDir: appRoot });
    expect(failed).toBe(1);
    expect(results.filter((x) => x.status === 'FAIL').map((x) => x.step)).toEqual([expect.stringContaining('⑥')]);
    expect(results.some((x) => x.status === 'PASS')).toBe(true);
  });
});
