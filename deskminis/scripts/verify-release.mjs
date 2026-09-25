#!/usr/bin/env node
// DeskMinis 发布校验（W2b-10 · 止血设计稿 §4、§5 第 2/4 条；侦察 release.md「W2b-verifyrelease」；cross.md S28）。
//
// 用法：npm run verify:release [-- --dist <目录>] [-- --version <x.y.z>]
//   dist 缺省为 <cwd>/dist，版本缺省取 <cwd>/package.json；npm run 的 cwd 就是 deskminis/。
//   两个时机各跑一次（docs/RELEASE.md）：npm run dist 之后、上传之前；上传之后把公开 Release 的四件下载回临时目录再跑。
//
// 为什么要它：发布资产传错，坏的是所有已装用户，而且只有在用户机器上才暴露——
//   latest.yml 的 sha512 与安装包对不上，electron-updater 下载完就报 ERR_CHECKSUM_MISMATCH 丢弃；
//   漏了 latest.yml，检查更新永远查不到；漏了 blockmap，下一版没法差分下载；
//   app-update.yml 还指着私有源码仓，装出去的应用检查更新永远 404，而且装上就改不了；
//   安装包里没有 LICENSE 与第三方署名，违反 MIT / Apache-2.0 / OFL 的随附要求。
//
// 依次检查（逐项打印 PASS / FAIL / SKIP，最后汇总）：
//   ① latest.yml 存在；② 按 electron-builder 的输出形状解析它，认不出的结构直接 FAIL，不去猜；
//   ③ version 与本次要发的版本一致；④ files[0] 是本版安装包，每个条目的文件都在、大小与 sha512（流式计算）都对，
//      顶层 path/sha512 与 files[0] 一致；⑤ 每个 .exe 条目都有 gzip 的 blockmap，块长之和等于安装包大小；
//   ⑥ 便携版在且非空；⑦ win-unpacked/resources/app-update.yml 与 electron-builder.yml 的 publish 段一致、不是私有源码仓；
//   ⑧ 随包的 LICENSE.txt 与 THIRD-PARTY-NOTICES.md 在，且与仓库根的原件一致。
//   ⑦⑧ 只在有 win-unpacked/resources 时查：下载回来的发布资产只有四件，这两项写明原因后 SKIP。
//
// 退出码：任一项 FAIL 退 1，参数错误退 2，全过退 0。
// 零依赖（只用 Node 内置模块）：发布机上 npm ci 之外不该再装东西，YAML 只认 electron-builder 写出来的那一种形状。
// 导出 parseLatestYml 与 verifyRelease 供 tests/verify-release.test.ts 直接调用。

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** 私有源码仓：0.1.1 写死的更新源就是它，外人拿不到它的 Release（设计稿 §2「自动更新源」）。 */
const PRIVATE_SOURCE_REPO = 'lincheuk/Deskminis';
/** app-update.yml 与 publish 段要逐项一致的键：github 看 owner/repo，将来换 generic 看 url。 */
const FEED_KEYS = ['provider', 'owner', 'repo', 'url'];
/** latest.yml 顶层要读的标量；其余标量键（如 stagingPercentage）忽略。 */
const TOP_KEYS = new Set(['version', 'path', 'sha512', 'releaseDate']);

const USAGE = [
  '用法：node scripts/verify-release.mjs [--dist <目录>] [--version <x.y.z>]',
  '  --dist     产物目录，缺省 <当前目录>/dist；核对下载回来的发布资产时指向那个临时目录（写绝对路径）',
  '  --version  要核对的版本，缺省取 <当前目录>/package.json 的 version',
  '退出码：0 全部通过；1 有 FAIL；2 参数错误',
].join('\n');

// ---------------------------------------------------------------------------
// 最小 YAML：只认单行标量。electron-builder 用 js-yaml 写 latest.yml / app-update.yml（lineWidth 8000，不折行），
// 值要么是 plain，要么在会被误读成别的类型时加单引号（如 releaseDate、'1.0'）。

/** 单行标量去壳；锚点、别名、标签、块标量、流式集合一律不认，返回 null 交给调用方报错。 */
function scalar(raw) {
  const s = raw.trim();
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(s);
    return m ? m[1].replace(/''/g, "'") : null;
  }
  if (s.startsWith('"')) {
    // YAML 双引号的常用转义与 JSON 相同；JSON 解不开的（\x、\e 之类）按认不出处理
    const m = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(s);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }
  if (s === '' || /^[&*!|>[\]{}%@`#,?]/.test(s) || /^-(\s|$)/.test(s)) return null;
  const plain = s.replace(/\s+#.*$/, '');
  // plain 里出现「: 」或以冒号结尾，是嵌套映射写在了一行上，js-yaml 不会这样写
  if (/:(\s|$)/.test(plain)) return null;
  return plain;
}

const KEY_LINE = /^([A-Za-z_][\w.-]*):(.*)$/;
const isBlank = (line) => /^\s*(#.*)?$/.test(line);

/**
 * 解析 latest.yml。只认 electron-builder 的输出形状：顶层标量 version/path/sha512/releaseDate，
 * 加 files 列表下每个条目的 url/sha512/size。未知的标量键忽略（以后多出 blockMapSize、isAdminRightsRequired 之类不该报错），
 * 其余一切认不出的结构直接抛错并带行号——解析器猜错了，比报一句「看不懂」危险得多。
 * @returns {{ version?: string, path?: string, sha512?: string, releaseDate?: string, files: Array<{url?: string, sha512?: string, size?: number}> }}
 */
export function parseLatestYml(text) {
  const bad = (n, why) => {
    throw new Error(`看不懂 latest.yml 第 ${n} 行：${why}——只认 electron-builder 写出的形状，不去猜`);
  };
  const out = { files: [] };
  const seenTop = new Set();
  let list = null; // 正在读 files：{ indent } 是条目「- 」的缩进，第一条出现前为 null
  let item = null;
  let seenItem = null;

  const readItemKey = (s, n) => {
    const m = KEY_LINE.exec(s);
    if (!m || (m[2] !== '' && !/^\s/.test(m[2]))) bad(n, 'files 条目不是「键: 值」');
    const [, key] = m;
    const value = m[2].trim();
    if (seenItem.has(key)) bad(n, `files 条目里 ${key} 重复`);
    seenItem.add(key);
    if (value === '' || value.startsWith('#')) bad(n, `files 条目的 ${key} 下面是嵌套结构`);
    const v = scalar(value);
    if (v === null) bad(n, `files 条目的 ${key} 不是单行标量`);
    if (key === 'size') {
      if (!/^\d+$/.test(v)) bad(n, `size 不是非负整数：${v}`);
      item.size = Number(v);
    } else if (key === 'url' || key === 'sha512') {
      item[key] = v;
    }
  };

  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i];
    if (isBlank(line)) continue;
    const indent = /^ */.exec(line)[0].length;
    if (line[indent] === '\t') bad(n, '缩进里有制表符');

    if (indent === 0 && !line.startsWith('- ')) {
      list = null;
      item = null;
      const m = KEY_LINE.exec(line);
      if (!m || (m[2] !== '' && !/^\s/.test(m[2]))) bad(n, '顶层不是「键: 值」');
      const [, key] = m;
      const value = m[2].trim();
      if (seenTop.has(key)) bad(n, `键 ${key} 重复`);
      seenTop.add(key);
      if (key === 'files') {
        if (value === '[]') continue; // js-yaml 写空列表就是这样
        if (value !== '' && !value.startsWith('#')) bad(n, 'files 应该是块状列表');
        list = { indent: null };
        continue;
      }
      if (value === '' || value.startsWith('#')) bad(n, `${key} 下面是嵌套结构`);
      const v = scalar(value);
      if (v === null) bad(n, `${key} 的值不是单行标量`);
      if (TOP_KEYS.has(key)) out[key] = v;
      continue;
    }

    // 缩进行（或行首「- 」）只能属于 files 列表
    if (!list) bad(n, '多出来的缩进');
    const dash = /^( *)- (.*)$/.exec(line);
    if (dash && (list.indent === null || dash[1].length === list.indent)) {
      list.indent = dash[1].length;
      item = {};
      seenItem = new Set();
      out.files.push(item);
      readItemKey(dash[2], n);
      continue;
    }
    if (item && indent === list.indent + 2) {
      readItemKey(line.slice(indent), n);
      continue;
    }
    bad(n, '多出来的缩进');
  }
  return out;
}

/** 取一段映射里同一缩进的「键: 标量」；更深的缩进（如签名后 app-update.yml 里的 publisherName 列表）跳过。 */
function flatScalars(lines) {
  const out = {};
  let base = null;
  for (const line of lines) {
    if (isBlank(line)) continue;
    const indent = /^ */.exec(line)[0].length;
    if (base === null) base = indent;
    if (indent > base) continue;
    const m = KEY_LINE.exec(line.slice(indent));
    if (!m) continue;
    const value = m[2].trim();
    if (value === '' || value.startsWith('#')) continue;
    const v = scalar(value);
    if (v !== null) out[m[1]] = v;
  }
  return out;
}

/** electron-builder.yml 顶层 publish 段；写成列表时取第一项（electron-builder 写 app-update.yml 用的就是第一项）。 */
function readPublishSection(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^publish:\s*(#.*)?$/.test(l));
  if (at < 0) return null;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (isBlank(line)) continue;
    if (!/^\s/.test(line)) break;
    body.push(line);
  }
  if (body.length === 0) return null;
  const dash = /^( *)- (.*)$/.exec(body[0]);
  if (!dash) return flatScalars(body);
  const indent = dash[1].length;
  const first = [' '.repeat(indent + 2) + dash[2]];
  for (const line of body.slice(1)) {
    if (line.startsWith(`${' '.repeat(indent)}- `)) break;
    first.push(line);
  }
  return flatScalars(first);
}

// ---------------------------------------------------------------------------

const statOf = (p) => statSync(p, { throwIfNoEntry: false });
const isFile = (p) => statOf(p)?.isFile() === true;
const isDir = (p) => statOf(p)?.isDirectory() === true;
const short = (s) => `${String(s).slice(0, 12)}…`;
const normText = (s) => s.replace(/^﻿/, '').replace(/\r\n/g, '\n');

/** 流式算 sha512（base64，与 electron-builder / electron-updater 同一写法）：真安装包约 100MB，不整个读进内存。 */
async function sha512Of(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) hash.update(chunk);
  return hash.digest('base64');
}

/**
 * 逐项核对一个 dist 目录。不打印（除非传 log）、不退出进程，返回逐项结果与 FAIL 数。
 * @param {{ distDir: string, version: string, versionFrom?: string, projectDir?: string, log?: (line: string) => void }} opts
 *   versionFrom 只用于报错措辞（「package.json 是 X 版」）；projectDir 是 electron-builder.yml 所在的工程目录，
 *   随包许可的原件在它的上一级（与 electron-builder.yml 的 extraResources 一致）。
 */
export async function verifyRelease({ distDir, version, versionFrom = 'package.json', projectDir = process.cwd(), log = () => {} }) {
  const results = [];
  const record = (status, step, detail) => {
    results.push({ status, step, detail });
    log(`${status}  [${step}] ${detail}`);
  };
  const pass = (step, detail) => record('PASS', step, detail);
  const fail = (step, detail) => record('FAIL', step, detail);
  const skip = (step, detail) => record('SKIP', step, detail);

  const setupName = `DeskMinis-${version}-Setup.exe`;
  const portableName = `DeskMinis-${version}-win-x64-portable.exe`;

  // ①② latest.yml
  const ymlPath = join(distDir, 'latest.yml');
  let yml = null;
  if (!isFile(ymlPath)) {
    fail('① latest.yml', '缺 latest.yml——electron-updater 靠它发现新版；检查 electron-builder.yml 的 publish 段是否还在');
  } else {
    pass('① latest.yml', ymlPath);
    try {
      yml = parseLatestYml(readFileSync(ymlPath, 'utf8'));
      pass('② 解析 latest.yml', `version ${yml.version ?? '（没写）'}，files ${yml.files.length} 条`);
    } catch (e) {
      fail('② 解析 latest.yml', e.message);
    }
  }

  if (!yml) {
    skip('③④⑤', 'latest.yml 缺失或读不懂，版本、安装包哈希与 blockmap 无从核对');
  } else {
    // ③ 版本
    if (yml.version === version) pass('③ 版本', `latest.yml 与 ${versionFrom} 都是 ${version}`);
    else fail('③ 版本', `latest.yml 是 ${yml.version ?? '（没写）'} 版，${versionFrom} 是 ${version} 版——dist 里是旧产物，重新 npm run dist`);

    // ④ 安装包条目
    const files = yml.files;
    if (files.length === 0) {
      fail('④ files', 'latest.yml 的 files 为空——electron-updater 不知道该下载哪个安装包');
    } else {
      const first = files[0];
      if (first.url === setupName) pass('④ files[0]', setupName);
      else fail('④ files[0]', `latest.yml 的 files[0] 是 ${first.url ?? '（没写 url）'}，应为 ${setupName}——与 electron-builder.yml 的 nsis.artifactName 对不上`);
      // 顶层 path/sha512 是给老版 electron-updater 读的，electron-builder 总是让它们与 files[0] 相同
      const odd = [];
      if (yml.path !== first.url) odd.push(`顶层 path 是 ${yml.path ?? '（没写）'}，files[0].url 是 ${first.url ?? '（没写）'}`);
      if (yml.sha512 !== first.sha512) odd.push(`顶层 sha512 是 ${short(yml.sha512 ?? '（没写）')}，files[0].sha512 是 ${short(first.sha512 ?? '（没写）')}`);
      if (odd.length === 0) pass('④ 顶层 path/sha512', '与 files[0] 一致');
      else fail('④ 顶层 path/sha512', `顶层 path/sha512 与 files[0] 不一致（${odd.join('；')}）——latest.yml 被手改过？`);

      for (const [i, f] of files.entries()) await checkEntry(f, i);
    }
  }

  async function checkEntry(f, i) {
    const label = `④ ${f.url ?? `files[${i}]`}`;
    const missing = ['url', 'sha512', 'size'].filter((k) => f[k] === undefined);
    if (missing.length > 0) { fail(label, `files[${i}] 缺 ${missing.join(' / ')}`); return; }
    // electron-updater 拿 url 拼在发布页的下载地址后面，带目录就对不上上传的资产
    if (/[\\/]/.test(f.url)) { fail(label, `files[${i}] 的 url 带了目录（${f.url}），发布资产只有文件名`); return; }
    const file = join(distDir, f.url);
    if (!isFile(file)) { fail(label, `latest.yml 列了 ${f.url}，dist 里却没有这个文件`); return; }

    const size = statOf(file).size;
    if (size === f.size) pass(`${label} 大小`, `${size} 字节`);
    else fail(`${label} 大小`, `${f.url} 实际 ${size} 字节，latest.yml 记的是 ${f.size}——用户下载后的大小校验会失败`);

    const actual = await sha512Of(file);
    if (actual === f.sha512) pass(`${label} sha512`, `${short(actual)}（与 latest.yml 一致）`);
    else fail(`${label} sha512`, `${f.url} 的 sha512 与 latest.yml 不符（期望 ${short(f.sha512)}，实际 ${short(actual)}，各取前 12 位）——照此上传会让所有用户更新失败（ERR_CHECKSUM_MISMATCH）`);

    if (/\.exe$/i.test(f.url)) checkBlockmap(f.url, size);
  }

  // ⑤ 差分下载要旧版与新版的 blockmap 都在：新版的这一份随本次 Release 上传，下一版才能按块比对
  function checkBlockmap(url, installerSize) {
    const name = `${url}.blockmap`;
    const label = `⑤ ${name}`;
    const file = join(distDir, name);
    if (!isFile(file)) { fail(label, `缺 blockmap（${name}）——下一版无法差分下载，老用户每次都得整包下载`); return; }
    const buf = readFileSync(file);
    if (buf.length === 0) { fail(label, `${name} 是空文件——下一版无法差分下载`); return; }
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) { fail(label, `${name} 不是 gzip（开头不是 1f 8b）——electron-updater 读不了，差分下载会退回整包`); return; }
    let map;
    try { map = JSON.parse(gunzipSync(buf).toString('utf8')); } catch (e) { fail(label, `${name} 解压或解析失败：${e.message}`); return; }
    if (map?.version !== '2') { fail(label, `${name} 的 version 是 ${JSON.stringify(map?.version)}，应为 "2"`); return; }
    const entries = Array.isArray(map.files) ? map.files : [];
    const shapeOk = entries.length > 0 && entries.every((e) => Array.isArray(e?.sizes) && Array.isArray(e?.checksums)
      && e.sizes.length === e.checksums.length && e.sizes.every((s) => Number.isInteger(s) && s >= 0));
    if (!shapeOk) { fail(label, `${name} 的块表结构不对（files / sizes / checksums）`); return; }
    // 块表把整个安装包切成若干块，块长之和就是安装包字节数；对不上说明安装包重新打过、块表还是旧的
    const total = entries.reduce((sum, e) => sum + e.sizes.reduce((a, b) => a + b, 0), 0);
    if (total !== installerSize) { fail(label, `${name} 的块长之和是 ${total} 字节，安装包是 ${installerSize} 字节——不是这个安装包的块表（重新打包后只换了安装包？）`); return; }
    pass(label, `gzip，version 2，${entries[0].sizes.length} 块，覆盖整个安装包`);
  }

  // ⑥ 便携版：不进 latest.yml，只能单独查
  const portable = join(distDir, portableName);
  if (!isFile(portable)) fail('⑥ 便携版', `缺便携版 ${portableName}——electron-builder.yml 的 win.target 里还有 portable 吗`);
  else if (statOf(portable).size === 0) fail('⑥ 便携版', `便携版 ${portableName} 是空文件`);
  else pass('⑥ 便携版', `${portableName}（${statOf(portable).size} 字节）`);

  // ⑦⑧ 看解包目录：安装包与便携版都由它打出来，它的 resources 就是装到用户机器上的 resources
  const resDir = join(distDir, 'win-unpacked', 'resources');
  if (!isDir(resDir)) {
    const why = '没有 win-unpacked/resources——从公开 Release 下载回来的只有四件资产，属正常；本地 npm run dist 的产物里必须有它';
    skip('⑦ app-update.yml', why);
    skip('⑧ 随包许可', why);
  } else {
    checkFeed();
    checkLicenses();
  }

  // ⑦ 更新源写死在 app-update.yml，装到用户机器上就改不了——这是最后一道闸
  function checkFeed() {
    const label = '⑦ app-update.yml';
    const feedFile = join(resDir, 'app-update.yml');
    if (!isFile(feedFile)) { fail(label, '缺 win-unpacked/resources/app-update.yml——装出去的应用不知道去哪查更新（electron-builder.yml 的 publish 段还在吗）'); return; }
    const builderFile = join(projectDir, 'electron-builder.yml');
    if (!isFile(builderFile)) { fail(label, `找不到 ${builderFile}，无从对照 publish 段——请在 deskminis/ 目录下运行`); return; }
    const feed = flatScalars(readFileSync(feedFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/));
    const publish = readPublishSection(readFileSync(builderFile, 'utf8'));
    if (!publish || !publish.provider) { fail(label, '看不懂 electron-builder.yml 的 publish 段（应是 provider / owner / repo 的映射）'); return; }
    const where = (c) => (c.provider === 'github' ? `github ${c.owner ?? '?'}/${c.repo ?? '?'}` : `${c.provider ?? '?'} ${c.url ?? ''}`.trim());
    const isPrivate = (c) => c.provider === 'github' && `${c.owner}/${c.repo}`.toLowerCase() === PRIVATE_SOURCE_REPO.toLowerCase();
    const problems = [];
    if (FEED_KEYS.some((k) => (feed[k] ?? '') !== (publish[k] ?? ''))) {
      problems.push(`app-update.yml 的更新源（${where(feed)}）与 electron-builder.yml 的 publish 段（${where(publish)}）不一致——dist 是改 publish 之前打的包，重新 npm run dist`);
    }
    if (isPrivate(feed) || isPrivate(publish)) {
      problems.push(`更新源指向私有源码仓 ${PRIVATE_SOURCE_REPO}——私仓的 Release 外人拿不到，装出去的应用检查更新永远 404；应为公开发布仓库（止血设计稿 §2）`);
    }
    if (problems.length > 0) fail(label, problems.join('；'));
    else pass(label, `${where(feed)}，与 publish 段一致`);
  }

  // ⑧ MIT 要求副本附版权与许可声明，Apache-2.0 §4(a)(d) 要求给接收者许可副本与署名，随包字体的 OFL 也要求随附
  function checkLicenses() {
    const pairs = [
      ['LICENSE.txt', join(projectDir, '..', 'LICENSE')],
      ['THIRD-PARTY-NOTICES.md', join(projectDir, '..', 'THIRD-PARTY-NOTICES.md')],
    ];
    for (const [name, source] of pairs) {
      const label = `⑧ ${name}`;
      const file = join(resDir, name);
      if (!isFile(file)) { fail(label, `缺 win-unpacked/resources/${name}——安装包里没有许可或第三方署名（electron-builder.yml 的 extraResources）`); continue; }
      const size = statOf(file).size;
      if (size === 0) { fail(label, `win-unpacked/resources/${name} 是空文件`); continue; }
      if (!isFile(source)) { pass(label, `在（${size} 字节）；找不到仓库根的原件，未比对内容`); continue; }
      // 行尾归一：Windows 上 git 可能把原件检出成 CRLF，electron-builder 照原样拷，两边比的是内容不是换行符
      if (normText(readFileSync(file, 'utf8')) !== normText(readFileSync(source, 'utf8'))) {
        fail(label, `随包的 ${name} 与仓库根的 ${basename(source)} 不一致——dist 是改许可文件之前打的包，重新 npm run dist`);
        continue;
      }
      pass(label, `与仓库根的 ${basename(source)} 一致`);
    }
  }

  return { results, failed: results.filter((r) => r.status === 'FAIL').length };
}

// ---------------------------------------------------------------------------
// CLI

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const eq = /^--(dist|version)=(.*)$/.exec(arg);
    if (eq) {
      if (eq[2] === '') throw new UsageError(`--${eq[1]} 后面缺值`);
      opts[eq[1]] = eq[2];
      continue;
    }
    if (arg === '--dist' || arg === '--version') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} 后面缺值`);
      opts[arg.slice(2)] = value;
      i++;
      continue;
    }
    throw new UsageError(`不认识的参数 ${arg}`);
  }
  return opts;
}

async function main() {
  const usageError = (msg) => {
    console.error(`参数错误：${msg}`);
    console.error(USAGE);
    process.exitCode = 2;
  };
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) return usageError(e.message);
    throw e;
  }
  if (args.help) { console.log(USAGE); return; }

  const cwd = process.cwd();
  let version = args.version;
  let versionFrom = '--version';
  if (version === undefined) {
    versionFrom = 'package.json';
    const pkgFile = join(cwd, 'package.json');
    try {
      version = JSON.parse(readFileSync(pkgFile, 'utf8')).version;
    } catch (e) {
      return usageError(`读不到 ${pkgFile} 的 version（${e.message}）——请在 deskminis/ 下运行，或用 --version 指定`);
    }
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    return usageError(`版本号 ${JSON.stringify(version)} 不是 x.y.z`);
  }
  const distDir = resolve(cwd, args.dist ?? 'dist');
  if (!isDir(distDir)) return usageError(`产物目录不存在：${distDir}——先 npm run dist，或用 --dist 指向产物目录`);

  console.log('═'.repeat(64));
  console.log(`  DeskMinis 发布校验：${distDir}（版本 ${version}，取自 ${versionFrom}）`);
  console.log('═'.repeat(64));
  const { results, failed } = await verifyRelease({ distDir, version, versionFrom, projectDir: cwd, log: (l) => console.log(l) });
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log('═'.repeat(64));
  console.log(`  汇总：PASS ${count('PASS')} · FAIL ${failed} · SKIP ${count('SKIP')}`);
  console.log('═'.repeat(64));
  if (failed > 0) {
    console.error(`有 ${failed} 项 FAIL——这份产物不能上传，先按上面的原因处理（docs/RELEASE.md）。`);
    process.exitCode = 1;
    return;
  }
  console.log('全部通过。上传到公开发布仓库 Release 的四件（docs/RELEASE.md §4）：');
  for (const name of [`DeskMinis-${version}-Setup.exe`, `DeskMinis-${version}-Setup.exe.blockmap`, `DeskMinis-${version}-win-x64-portable.exe`, 'latest.yml']) {
    console.log(`  - ${name}`);
  }
}

// 被测试 import 时不跑 CLI。用 realpath 比对而不是比 URL 字符串：Windows 上盘符大小写、经符号链接调用都会让字符串对不上
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) {
  // 用 exitCode 而不是 process.exit：Windows 上 stdout 接管道时是异步写，process.exit 会截掉尾部输出
  main().catch((e) => { console.error('脚本异常：', e); process.exitCode = 1; });
}
