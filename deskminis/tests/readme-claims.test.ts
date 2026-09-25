/** README 里能机器核对的三条声明（W2b-11b；止血设计稿 §2「发布工程」：加 tests/readme-claims.test.ts，只钉三条）。
 *
 *  为什么只钉三条：README 能力表的大多数行只能对着代码逐行核（改 README 的提交在正文里附逐行核对清单），
 *  硬写成测试要么认字面、一改措辞就红，要么认不出真假。下面三条能机器核对、误报低，而且都已经漂过：
 *  ① 测试例数：README 写过「1832 例」，同一时期的全量已是 1914 例——例数每个提交都在变，写进 README 就一定过期；
 *  ② mDNS：架构图写过「同步引擎（mDNS + 直连）」，src/minisd 里从来没有 mDNS，配对靠在设备页手填 host:port；
 *  ③ 下载地址：README 的 Releases 链接要和 electron-builder.yml 的 publish 段（写进安装包、应用自己查更新的地方）
 *     是同一个仓库。W2b-9 把更新源改成公开发布仓库之后，README 还指着私有源码仓——外人照 README 去下载只看到 404。
 *
 *  读法：README 是 Markdown，按原文查，不剥注释（藏在 <!-- --> 里的例数或 mDNS 也算写了，宁可多拦）；
 *  electron-builder.yml 先剥 # 注释再解析（注释里写着旧仓库名不能让比对失真，与 auto-update.test.ts 同一剥法）；
 *  src/minisd 的源码用 TypeScript 语法树判断：ts.forEachChild 不进注释与 JSDoc，注释里写着
 *  addMembership('224.0.0.251') 不算实现，认的是真的调用与字面量。 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(appRoot, '..');
const readText = (abs: string): string => readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

// ---------- ① 测试例数 ----------

/** 「数字 + 例 / 个测试 / 条用例 / tests」这类写法。数字允许千分位逗号（1,914）。
 *  只认紧跟在数字后面的计数词：「例如」「用例」前面没有数字，不会误伤。 */
const TEST_COUNT_RE = /\d[\d,，]*\s*(?:例|[个条项]?(?:测试)?用例|[个条项]测试|tests?\b|test\s+cases?\b|specs?\b)/gi;

/** 返回 README 里写死的测试例数（原文片段）；没有就是空数组。 */
function testCountClaims(markdown: string): string[] {
  return [...markdown.matchAll(TEST_COUNT_RE)].map(m => m[0]);
}

// ---------- ② mDNS ----------

/** README 提到 mDNS 的各种写法：mDNS、multicast DNS、组播 / 多播 DNS，以及常被当成同义词的 Bonjour、Zeroconf。 */
const MDNS_MENTION_RE = /\bmdns\b|\bmulticast[\s-]*dns\b|[组多]播\s*dns|\bbonjour\b|\bzeroconf\b/i;

function mentionsMdns(markdown: string): boolean {
  return MDNS_MENTION_RE.test(markdown);
}

/** mDNS 的组播组（RFC 6762）：IPv4 224.0.0.251、IPv6 ff02::fb。自己用 dgram 实现就绕不开加入这两个组之一。 */
const MDNS_GROUPS = new Set(['224.0.0.251', 'ff02::fb']);
/** 现成的 mDNS 库。本项目零新依赖，真要引入须先获批（交接 §2 第 1 条）；列在这里只为引入之后这条守卫认得出。 */
const MDNS_LIBS = new Set(['multicast-dns', 'bonjour', 'bonjour-service', 'mdns', 'mdns-js', 'dnssd', '@homebridge/ciao']);

interface MdnsEvidence {
  /** 调了 addMembership( 的文件（组播加组）。 */
  joins: string[];
  /** 代码里（不是注释里）出现 mDNS 组播地址字面量的文件。 */
  groups: string[];
  /** import / require / import() 了 mDNS 库的文件。 */
  libs: string[];
}

/** 在一批源码里找 mDNS 实现的证据。按语法树认：调用、字符串字面量、模块说明符；注释一概不看。 */
function mdnsEvidence(files: ReadonlyArray<{ name: string; code: string }>): MdnsEvidence {
  const ev: MdnsEvidence = { joins: [], groups: [], libs: [] };
  const add = (list: string[], name: string): void => { if (!list.includes(name)) list.push(name); };
  for (const f of files) {
    const kind = /\.(?:m|c)?js$/i.test(f.name) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(f.name, f.code, ts.ScriptTarget.Latest, true, kind);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const calleeName = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
        if (calleeName === 'addMembership') add(ev.joins, f.name);
        // require('x') 与动态 import('x')
        const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
        const isDynImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        const arg0 = n.arguments[0];
        if ((isRequire || isDynImport) && arg0 && ts.isStringLiteralLike(arg0) && MDNS_LIBS.has(arg0.text)) add(ev.libs, f.name);
      }
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)
        && MDNS_LIBS.has(n.moduleSpecifier.text)) add(ev.libs, f.name);
      if (ts.isStringLiteralLike(n) && MDNS_GROUPS.has(n.text.toLowerCase())) add(ev.groups, f.name);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return ev;
}

/** 有 mDNS 实现：引入了 mDNS 库，或者既加了组播组、代码里又有 mDNS 的组播地址（地址可以放在别的常量文件里）。 */
function hasMdnsImplementation(ev: MdnsEvidence): boolean {
  return ev.libs.length > 0 || (ev.joins.length > 0 && ev.groups.length > 0);
}

const SOURCE_EXT = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
function sourcesUnder(dir: string): Array<{ name: string; code: string }> {
  const out: Array<{ name: string; code: string }> = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (SOURCE_EXT.has(extname(e.name)) && !e.name.endsWith('.d.ts')) {
        out.push({ name: relative(repoRoot, p).split(sep).join('/'), code: readText(p) });
      }
    }
  };
  walk(dir);
  return out;
}

// ---------- ③ Releases 链接与 publish 段 ----------

/** README 里所有 GitHub Releases 链接的 owner/repo（/releases、/releases/latest、/releases/tag/v… 都算）。 */
function releasesRepos(markdown: string): string[] {
  return [...markdown.matchAll(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)\/releases(?![A-Za-z0-9_-])/gi)]
    .map(m => `${m[1]}/${m[2]}`);
}

/** electron-builder.yml 的 publish 段里的 owner/repo。先剥 # 注释；只认映射形态（publish: 下缩进的键），
 *  认不出（没有这一段、写成列表、缺 owner 或 repo）返回 undefined，由调用方报错，不去猜。 */
function publishRepo(yml: string): string | undefined {
  const code = yml.replace(/\r\n/g, '\n').replace(/(^|\s)#.*$/gm, '$1');
  const lines = code.split('\n');
  const start = lines.findIndex(l => /^publish:\s*$/.test(l));
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') continue;
    if (!/^\s/.test(l)) break; // 下一个顶层键
    body.push(l);
  }
  // 列表形态（多个发布目标）不猜哪一个是更新源：electron-updater 取第一个，但 README 该指哪个要人来定
  if (body.some(l => /^\s+-(?:\s|$)/.test(l))) return undefined;
  const val = (key: string): string | undefined => {
    const m = body.map(l => new RegExp(`^\\s+${key}:\\s*(\\S+)\\s*$`).exec(l)).find(Boolean);
    return m ? m[1].replace(/^(['"])(.*)\1$/, '$2') : undefined;
  };
  const owner = val('owner');
  const repo = val('repo');
  return owner && repo ? `${owner}/${repo}` : undefined;
}

// ---------- 解析器自检（夹具） ----------

describe('README 声明守卫 · 解析器自检', () => {
  it('例数：认「1832 例」「1,914 个测试」「2926 tests」，不认「例如」「用例」与不带计数词的数字', () => {
    expect(testCountClaims('npm test             # 1832 例')).toEqual(['1832 例']);
    expect(testCountClaims('全量 1,914 个测试，另有 170 文件')).toEqual(['1,914 个测试']);
    expect(testCountClaims('ran 2926 tests')).toEqual(['2926 tests']);
    expect(testCountClaims('例如 Windows 专属用例会失败；90 秒自动拒绝；≥3 回合显示')).toEqual([]);
  });

  it('mDNS：认 mDNS / multicast DNS / 组播 DNS / Bonjour，不认「手填 host:port」', () => {
    expect(mentionsMdns('└─ 同步引擎（mDNS + 直连）')).toBe(true);
    expect(mentionsMdns('uses Multicast-DNS discovery')).toBe(true);
    expect(mentionsMdns('局域网组播 DNS 自动发现')).toBe(true);
    expect(mentionsMdns('Bonjour 发现')).toBe(true);
    expect(mentionsMdns('同步引擎（手填 host:port 配对 + 直连）')).toBe(false);
  });

  it('mDNS 实现：认 addMembership( 调用加 mDNS 组播地址字面量，或引入 mDNS 库；注释里写的不算', () => {
    const impl = { name: 'a.ts', code: "import dgram from 'node:dgram';\nconst s = dgram.createSocket('udp4');\ns.addMembership('224.0.0.251');\n" };
    expect(hasMdnsImplementation(mdnsEvidence([impl]))).toBe(true);
    // 地址放在另一个常量文件里（正常重构）照样认
    const constFile = { name: 'c.ts', code: "export const MDNS_V6 = 'FF02::FB';\n" };
    const joinFile = { name: 'j.ts', code: 'import { MDNS_V6 } from "./c";\nsock.addMembership(MDNS_V6);\n' };
    expect(hasMdnsImplementation(mdnsEvidence([constFile, joinFile]))).toBe(true);
    expect(hasMdnsImplementation(mdnsEvidence([{ name: 'l.ts', code: "import mdns from 'multicast-dns';\n" }]))).toBe(true);
    expect(hasMdnsImplementation(mdnsEvidence([{ name: 'r.mjs', code: "const b = require('bonjour-service');\n" }]))).toBe(true);
    // 注释喂不饱：只有注释与 JSDoc 里写着实现
    const commentsOnly = {
      name: 'x.ts',
      code: "// s.addMembership('224.0.0.251');\n/* import mdns from 'multicast-dns'; */\n/** addMembership('ff02::fb') */\nexport const x = 1;\n",
    };
    expect(mdnsEvidence([commentsOnly])).toEqual({ joins: [], groups: [], libs: [] });
    // 只加了组播组、不是 mDNS 的组，不算
    expect(hasMdnsImplementation(mdnsEvidence([{ name: 'y.ts', code: "s.addMembership('239.255.255.250');\n" }]))).toBe(false);
  });

  it('Releases 链接：取出每个 owner/repo；/releases 之后的路径不影响，/releasesX 不算', () => {
    const md = [
      '到 [Releases](https://github.com/lincheuk/deskminis-releases/releases) 下载',
      '最新版 https://github.com/lincheuk/deskminis-releases/releases/latest',
      '旧写法 https://github.com/lincheuk/Deskminis/releases/tag/v0.1.1',
      '不是发布页 https://github.com/lincheuk/deskminis-releases/releasesX',
    ].join('\n');
    expect(releasesRepos(md)).toEqual(['lincheuk/deskminis-releases', 'lincheuk/deskminis-releases', 'lincheuk/Deskminis']);
  });

  it('publish 段：剥 # 注释后按缩进取到下一个顶层键，引号去壳；认不出就给 undefined', () => {
    const yml = [
      '# publish:', '#   repo: Deskminis',
      'appId: x',
      'publish:',
      '  provider: github',
      "  owner: 'lincheuk'   # 注释里写 repo: Deskminis 不算",
      '  repo: "deskminis-releases"',
      'nsis:',
      '  repo: other',
    ].join('\n');
    expect(publishRepo(yml)).toBe('lincheuk/deskminis-releases');
    expect(publishRepo('publish:\n  - provider: github\n    owner: a\n    repo: b\n')).toBeUndefined();
    expect(publishRepo('publish:\n  provider: github\n  owner: a\n')).toBeUndefined();
    expect(publishRepo('appId: x\n')).toBeUndefined();
  });
});

// ---------- 真文件 ----------

const README_ABS = join(repoRoot, 'README.md');
const readme = readText(README_ABS);

describe('README 声明守卫（仓库根 README.md）', () => {
  it('① 不写死测试例数——例数每个提交都在变，写进 README 就一定过期', () => {
    expect(
      testCountClaims(readme),
      'README 里写死了测试例数。改成不带数字的说法（例如「Windows 上应全绿；Linux 上 Windows 专属用例会失败」），'
      + '例数与失败基线写在提交正文和 docs/RELEASE.md 里',
    ).toEqual([]);
  });

  it('② 提到 mDNS，src/minisd 里就必须真有 mDNS 实现（加入 224.0.0.251 / ff02::fb 组播，或引入 mDNS 库）', () => {
    const ev = mdnsEvidence(sourcesUnder(join(appRoot, 'src', 'minisd')));
    if (!mentionsMdns(readme)) return;
    expect(
      hasMdnsImplementation(ev),
      `README 提到了 mDNS，但 src/minisd 里没有 mDNS 实现（加组播的文件：${ev.joins.join('、') || '无'}；`
      + `mDNS 组播地址字面量：${ev.groups.join('、') || '无'}；mDNS 库：${ev.libs.join('、') || '无'}）。`
      + '配对靠在设备页手填 host:port；README 要写成那样。要写「没有局域网自动发现」这类否定句，也别带 mDNS 字样',
    ).toBe(true);
  });

  it('③ Releases 下载链接与 electron-builder.yml 的 publish 段是同一个仓库（用户下载的地方就是应用查更新的地方）', () => {
    const pub = publishRepo(readText(join(appRoot, 'electron-builder.yml')));
    expect(pub, 'electron-builder.yml 的 publish 段认不出 owner / repo（只认映射形态）').toBeDefined();
    const links = releasesRepos(readme);
    expect(links.length, 'README 里没有 GitHub Releases 下载链接——安装一节要告诉用户去哪下载').toBeGreaterThan(0);
    // GitHub 的 owner/repo 不分大小写，按小写比
    const bad = links.filter(r => r.toLowerCase() !== pub!.toLowerCase());
    expect(
      bad,
      `README 的 Releases 链接指向 ${bad.join('、')}，而安装包里写死的更新源是 ${pub}（electron-builder.yml 的 publish 段）。`
      + '两边要一起改；改更新源还要同步 src/main/update-status.ts 的 RELEASES_PAGE_URL',
    ).toEqual([]);
  });
});
