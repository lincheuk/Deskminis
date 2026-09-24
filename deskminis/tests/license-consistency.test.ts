import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

// 许可一致性与「借用即登记」双向绊线（W1a-1 · 止血波设计稿 §1 第 5 条、§2「发布工程」；侦察 release.md W2b-license）。
//
// 管四件事：
// 1. 许可字段：package.json、package-lock.json 根、仓库根 LICENSE 三处都是 Apache-2.0。
//    此前 package.json 写的是 npm init 留下的 ISC，与仓库根 LICENSE 自相矛盾，锁根还停在 0.1.1。
// 2. 随包：electron-builder.yml 的 extraResources 把 LICENSE 与 THIRD-PARTY-NOTICES.md 拷进安装目录 resources/。
//    MIT 要求副本附版权与许可声明，Apache-2.0 §4(a)(d) 要求给接收者许可副本与署名，随包字体的 OFL 也要求随附；
//    此前安装包里一样都没有。
// 3. 双向绊线：
//    正向——源码里凡出现「改编自 <名>（https://…）」，THIRD-PARTY-NOTICES.md 就必须有
//          「## N. <名> — 代码改编（<许可>）」一节，节里写着同一个 URL，表里登记了这个文件；
//    反向——改编表登记的每个文件都必须存在，且文件头带着该上游的改编声明（上游 / 许可 / 本文件已修改 三行）。
//    只查一边的话，删了文件忘删登记、借了代码只在一边写，都不会有人发现。
//    W1a-1 落地时两边都是空的；W1a-2 的 src/minisd/tools/edit-text.ts（借 pi-mono）是第一条登记。
// 4. NOTICES「运行时依赖」一节与 package-lock.json 逐包对账：这份文件随安装包给用户看，许可要写实——
//    随包的间接依赖里有 ISC / Apache-2.0 / BSD / Python-2.0 / BlueOak 的包，不能一句「都是 MIT」带过。
//
// 变异自检（输出记在 W1a-1 的提交正文）：给任一源文件加一行假的改编声明、往改编表加一行不存在的路径、
// 登记一个没有文件头的真实文件、把声明写成不带 https 的坏格式，「双向绊线」一例都会变红；
// 依赖一节把某包的许可写错、删掉一个非 MIT 包的行、不点名没带许可文件的包、列一个锁里没有的包，「许可与锁文件对得上」一例都会变红。

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(appRoot, '..');
const readText = (abs: string): string => readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
/** 路径一律写成「相对仓库根、正斜杠」，与 NOTICES 表里的写法一致（Windows 上 relative() 给的是反斜杠）。 */
const toRepoRel = (abs: string): string => relative(repoRoot, abs).split(sep).join('/');

const NOTICES_REL = 'THIRD-PARTY-NOTICES.md';
/** 本文件的夹具里有整段示范声明，扫描时跳过自己。 */
const SELF_REL = 'deskminis/tests/license-consistency.test.ts';
/** 反向核对只看文件头：声明要写在文件开头的注释里，不能埋在中段。 */
const HEAD_LINES = 40;
/** 改编表的列，照登记格式一字不差。 */
const TABLE_HEADER = ['本仓位置', '上游位置 @ 提交', '借了什么', '怎么改的'];

interface AdaptMark { name: string; url: string; line: number }
interface AdaptRow { path: string; cells: string[]; line: number }
interface NoticeSection {
  num: number | null;
  title: string;
  body: string;
  adapt: { name: string; license: string } | null;
  tableHeader: string[] | null;
  rows: AdaptRow[];
}
interface SourceFile { rel: string; text: string }
interface ExtraResource { from: string; to: string }
/** package-lock.json 的 packages 条目里本文件用到的字段。 */
interface LockEntry { license?: string; dev?: boolean; optional?: boolean }

/** 「改编自 <名>（<URL>）」。登记格式用全角括号；半角也认，免得括号写错就漏网。名字可以带空格（如 Appica UI）。 */
const MARK_RE = /改编自\s*([^\s（(][^（(\n]*?)\s*[（(]\s*(https?:\/\/[^\s）)]+)\s*[）)]/g;

/** 找出文本里的改编声明。一行里「改编自」出现的次数多于合规声明数，这一行记为坏格式——
 *  不带 URL、URL 不是 http(s) 的声明解析不出上游，放过去就等于没登记。 */
function findAdaptMarks(text: string): { marks: AdaptMark[]; malformed: number[] } {
  const marks: AdaptMark[] = [];
  const malformed: number[] = [];
  text.split('\n').forEach((line, i) => {
    const said = line.split('改编自').length - 1;
    if (said === 0) return;
    const found = [...line.matchAll(MARK_RE)];
    for (const m of found) marks.push({ name: m[1].trim(), url: m[2], line: i + 1 });
    if (found.length < said) malformed.push(i + 1);
  });
  return { marks, malformed };
}

const splitCells = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** 按「## 」切节。改编节的标题是「N. <名> — 代码改编（<许可>）」；节内第一张表是改编表（表头 + 分隔行 + 登记行）。 */
function parseNotices(md: string): NoticeSection[] {
  const lines = md.split('\n');
  const sections: NoticeSection[] = [];
  const starts: number[] = [];
  let fenced = false; // 代码块里（许可全文、登记格式示例）以「## 」开头的行不是节标题
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fenced = !fenced;
    else if (!fenced && /^## /.test(l)) starts.push(i);
  });
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const heading = lines[start].slice(3).trim();
    const numbered = /^(\d+)\.\s+(.+)$/.exec(heading);
    const title = numbered ? numbered[2] : heading;
    const adaptM = /^(.+?)\s+—\s+代码改编（(.+?)）$/.exec(title);
    let tableHeader: string[] | null = null;
    const rows: AdaptRow[] = [];
    if (adaptM) {
      const first = lines.slice(start + 1, end).findIndex((l) => l.trimStart().startsWith('|'));
      if (first >= 0) {
        const t0 = start + 1 + first;
        let t = t0;
        while (t < end && lines[t].trimStart().startsWith('|')) t++;
        tableHeader = splitCells(lines[t0]);
        // t0 是表头、t0+1 是分隔行，其后才是登记行
        for (let r = t0 + 2; r < t; r++) {
          const cells = splitCells(lines[r]);
          const path = (/`([^`]+)`/.exec(cells[0] ?? '')?.[1] ?? '').replace(/:[\d,\-–\s]+$/, '');
          rows.push({ path, cells, line: r + 1 });
        }
      }
    }
    sections.push({
      num: numbered ? Number(numbered[1]) : null,
      title,
      body: lines.slice(start + 1, end).join('\n'),
      adapt: adaptM ? { name: adaptM[1].trim(), license: adaptM[2].trim() } : null,
      tableHeader,
      rows,
    });
  });
  return sections;
}

/** 改编节的格式：标准表头；项目链接；版权行；MIT 照录全文，Apache 注明全文同本仓 LICENSE。 */
function checkAdaptSectionFormat(s: NoticeSection): string[] {
  const p: string[] = [];
  const at = `NOTICES「${s.title}」`;
  if (JSON.stringify(s.tableHeader) !== JSON.stringify(TABLE_HEADER)) {
    p.push(`${at} 的改编表表头应为「| ${TABLE_HEADER.join(' | ')} |」`);
  }
  if (!/<https?:\/\/[^>]+>/.test(s.body)) p.push(`${at} 缺项目链接（写成 <https://…>）`);
  if (!/Copyright/.test(s.body)) p.push(`${at} 缺上游的 Copyright 版权行`);
  if (s.adapt?.license === 'MIT' && !s.body.includes('Permission is hereby granted')) {
    p.push(`${at} 是 MIT：要照录 MIT 全文（含版权行）`);
  }
  if (s.adapt?.license === 'Apache-2.0' && !s.body.includes('LICENSE')) {
    p.push(`${at} 是 Apache-2.0：要注明全文同本仓 LICENSE`);
  }
  return p;
}

/** 双向核对。sources 的 rel 与 readFile 的参数都是「相对仓库根、正斜杠」的路径；readFile 读不到（不存在或不是文件）返回 null。 */
function checkTripwire(sources: SourceFile[], noticesMd: string, readFile: (rel: string) => string | null): string[] {
  const problems: string[] = [];
  const adapt = parseNotices(noticesMd).filter((s) => s.adapt);
  const byName = new Map(adapt.map((s) => [s.adapt?.name ?? '', s]));

  // 正向：源码里的每一处声明，都要落到对应节的表里
  for (const f of sources) {
    const { marks, malformed } = findAdaptMarks(f.text);
    for (const line of malformed) {
      problems.push(`${f.rel}:${line} 写了「改编自」，但不是登记格式「改编自 <名>（https://…）」`);
    }
    for (const m of marks) {
      const s = byName.get(m.name);
      if (!s) {
        problems.push(`${f.rel}:${m.line} 声明改编自 ${m.name}，但 NOTICES 没有「## N. ${m.name} — 代码改编（<许可>）」一节`);
        continue;
      }
      if (!s.body.includes(m.url)) problems.push(`${f.rel}:${m.line} 的上游 URL ${m.url} 在 NOTICES「${s.title}」里找不到`);
      if (!s.rows.some((r) => r.path === f.rel)) problems.push(`${f.rel} 声明改编自 ${m.name}，但 NOTICES「${s.title}」的表里没有登记这个文件`);
    }
  }

  // 反向：表里的每一行，文件都在、文件头都带着这个上游的声明
  for (const s of adapt) {
    const name = s.adapt?.name ?? '';
    for (const r of s.rows) {
      const at = `NOTICES:${r.line}`;
      if (r.cells.length !== TABLE_HEADER.length || r.cells.some((c) => c === '')) {
        problems.push(`${at} 改编表的行要填满四列：${TABLE_HEADER.join(' | ')}`);
      }
      if (!(r.cells[1] ?? '').includes('@')) problems.push(`${at} 第二列要写「上游路径 @ 提交」`);
      if (!r.path) {
        problems.push(`${at} 第一列要写本仓路径（反引号包住、相对仓库根）`);
        continue;
      }
      const text = readFile(r.path);
      if (text === null) {
        problems.push(`${at} 登记的 ${r.path} 不存在（文件删了或改了名，登记要跟着改）`);
        continue;
      }
      const head = text.split('\n').slice(0, HEAD_LINES);
      const idx = head.findIndex((l) => findAdaptMarks(l).marks.some((m) => m.name === name));
      if (idx < 0) {
        problems.push(`${r.path} 登记在 NOTICES「${s.title}」，但文件头（前 ${HEAD_LINES} 行）没有「改编自 ${name}（https://…）」`);
        continue;
      }
      // 「本文件已修改」一行满足 Apache-2.0 §4(b) 的显著修改声明；三行都要在声明之后紧跟着写
      const block = head.slice(idx, idx + 6).join('\n');
      const lack = ['上游：', '许可：', '本文件已修改：'].filter((k) => !block.includes(k));
      if (lack.length > 0) problems.push(`${r.path} 的改编声明缺「${lack.join('」「')}」行`);
    }
  }
  return [...new Set(problems)];
}

/** 只认 electron-builder.yml 里 extraResources 段的 from/to 对，到下一个顶层键为止；去掉注释与引号。 */
function extraResourcesOf(yml: string): ExtraResource[] {
  const lines = yml.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^extraResources:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const out: Array<Partial<ExtraResource>> = [];
  for (const raw of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(raw)) break;
    const line = raw.replace(/\s+#.*$/, '').trim();
    const m = /^(-\s+)?(from|to):\s*(.+)$/.exec(line);
    if (!m) continue;
    if (m[1] || out.length === 0) out.push({});
    out[out.length - 1][m[2] as 'from' | 'to'] = m[3].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out.filter((e): e is ExtraResource => typeof e.from === 'string' && typeof e.to === 'string');
}

/** 包目录里的许可文件：LICENSE / LICENCE / COPYING 及其带后缀的写法（LICENSE.md、LICENSE.MIT 等）。 */
const LICENSE_FILE_RE = /^(licen[cs]e|copying)/i;

/** 依赖一节里所有表的登记行：第一格里每个反引号包住的包名 → 第二格（许可）。每张表的头两行是表头与分隔行。 */
function depRowsOf(body: string): Map<string, string> {
  const rows = new Map<string, string>();
  let inTable = 0; // 当前表已读的行数，0 表示不在表里
  for (const line of body.split('\n')) {
    if (!line.trimStart().startsWith('|')) {
      inTable = 0;
      continue;
    }
    if (++inTable <= 2) continue;
    const cells = splitCells(line);
    for (const m of (cells[0] ?? '').matchAll(/`([^`]+)`/g)) rows.set(m[1], cells[1] ?? '');
  }
  return rows;
}

/** 依赖一节「列全」：required 里没在节里任何一张表上占一行的包。
 *  只认表格行，不在整节里找「`包名`」子串：第 6 节散文也用反引号提包名（如末尾「`@napi-rs/keyring` 的平台二进制包」），
 *  W1a-1 初版按子串找，直接依赖 @napi-rs/keyring 那一行删掉照样绿——守卫被散文喂饱了。 */
function unlistedDeps(body: string, required: string[]): string[] {
  const listed = depRowsOf(body);
  return required.filter((n) => !listed.has(n));
}

/** 「运行时依赖」一节与锁文件对账。lockPackages 是 package-lock.json 的 packages；
 *  随包的包 = 锁里除本项目（键 ""）外不带 dev 的条目——实测 electron-builder --dir 出的 app.asar 里 68 个包，
 *  正是这批 78 条减去本机没装的 10 个平台二进制包。
 *  1. 许可不是纯 MIT 的随包包，都要在节里的表上列出，许可一格与锁里的 license 一字不差：
 *     W1a-1 初稿一句「安装包里的第三方包都是 MIT 许可」，抹掉了经 better-sqlite3 → prebuild-install、
 *     electron-updater 带进来的 15 份非纯 MIT 包（ISC / Apache-2.0 / BSD-3-Clause / Python-2.0 / BlueOak-1.0.0，
 *     另有两个含 MIT 的多选一许可）；
 *     逐包对账，而不是去匹配「都是 MIT」这类措辞——说法换个写法就漏网，表对不上锁是换不掉的。
 *  2. 表上列的包，许可一格也要与锁里一致；锁里没有这个包就报（删了依赖，登记要跟着删）。
 *  3. 包内没有许可文件的随包包，节里要点名（反引号包住）：「各自的许可文件随包」对它不成立，只能靠本文件带出去。
 *     hasLicenseFile 返回 null 表示本机没装，不查。可选包（optional，平台二进制包）也不查：装哪几个因平台而异——
 *     Linux 开发机上是 linux-x64-gnu / musl，安装包里是 win32-x64-msvc，按本机点名会点错；NOTICES 按「平台二进制包」统称。 */
function checkDepLicenses(
  body: string,
  lockPackages: Record<string, LockEntry>,
  hasLicenseFile: (lockKey: string) => boolean | null,
): string[] {
  const problems: string[] = [];
  const rows = depRowsOf(body);
  const nameOf = (key: string): string => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const wrong = (name: string, cell: string, key: string, license: string): string =>
    `依赖一节把 ${name} 的许可写成「${cell}」，锁文件 ${key} 里是「${license}」`;

  for (const [key, e] of Object.entries(lockPackages)) {
    if (key === '' || e.dev) continue;
    const name = nameOf(key);
    const license = e.license ?? '（锁里没写）';
    if (license !== 'MIT') {
      const cell = rows.get(name);
      if (cell === undefined) problems.push(`${name}（${license}）随安装包分发，但依赖一节的表上没列（锁文件 ${key}）`);
      else if (cell !== license) problems.push(wrong(name, cell, key, license));
    }
    if (!e.optional && hasLicenseFile(key) === false && !body.includes('`' + name + '`')) {
      problems.push(`${name} 包内没有许可文件，依赖一节要点名（反引号包住）并写明许可与版权归属（锁文件 ${key}）`);
    }
  }

  // 表上的一行对的是锁里随包的同名条目（顶层一份、嵌套若干份）。同名的 dev 条目不算：
  // 构建工具链里的 tar 自带一份 BlueOak-1.0.0 的 chownr，与随包的 ISC 版同名。
  // 一份随包的都没有时才对 dev 条目——vue / pinia / electron 是 devDependencies，却在表上。
  for (const [name, cell] of rows) {
    const same = Object.keys(lockPackages).filter((key) => key !== '' && nameOf(key) === name);
    const shipped = same.filter((key) => !lockPackages[key].dev);
    if (same.length === 0) problems.push(`依赖一节列了 ${name}，但锁文件里没有这个包（node_modules/…/${name}）`);
    for (const key of shipped.length > 0 ? shipped : same) {
      const license = lockPackages[key].license ?? '（锁里没写）';
      if (cell !== license) problems.push(wrong(name, cell, key, license));
    }
  }
  return [...new Set(problems)];
}

// ───────────────────────── 仓库里的真实文件 ─────────────────────────

// 扫描面比侦察计划写的（src 的 ts/vue + scripts/*.mjs）宽：tests 与 css/html/js 也扫——
// 测试照抄上游用例、样式照抄上游取值同样是借用，声明了就得登记。
const SCAN_DIRS = ['src', 'scripts', 'tests'];
const SCAN_EXT = /\.(ts|tsx|vue|js|mjs|cjs|css|html)$/;

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p, out);
    } else if (SCAN_EXT.test(e.name)) {
      out.push(p);
    }
  }
}

function repoSources(): SourceFile[] {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(appRoot, d), files);
  return files
    .map((abs) => ({ rel: toRepoRel(abs), abs }))
    .filter((f) => f.rel !== SELF_REL)
    .map((f) => ({ rel: f.rel, text: readText(f.abs) }));
}

function readRepoFile(rel: string): string | null {
  const abs = join(repoRoot, rel);
  return existsSync(abs) && statSync(abs).isFile() ? readText(abs) : null;
}

const pkgNameOf = (spec: string): string =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

describe('许可字段：三处都是 Apache-2.0', () => {
  const pkg = JSON.parse(readText(join(appRoot, 'package.json'))) as { name?: string; version?: string; license?: string };
  const lock = JSON.parse(readText(join(appRoot, 'package-lock.json'))) as {
    name?: string;
    version?: string;
    packages?: Record<string, { name?: string; version?: string; license?: string }>;
  };

  it('package.json 的 license 是 Apache-2.0（SPDX 写法），与仓库根 LICENSE 一致', () => {
    expect(pkg.license).toBe('Apache-2.0');
  });

  it('仓库根 LICENSE 是 Apache License 2.0 正文', () => {
    const head = readText(join(repoRoot, 'LICENSE')).split('\n').slice(0, 3).join('\n');
    expect(head).toMatch(/Apache License/);
    expect(head).toMatch(/Version 2\.0/);
  });

  it('package-lock.json 根元数据与 package.json 一致（name / version / license）', () => {
    const root = lock.packages?.[''] ?? {};
    // 锁根是 npm install 时抄过去的；本仓升版和改许可都没跑 npm install，于是停在 0.1.1 / ISC。
    // 升版时这里会逼着同步改锁根两处 version（手改即可，依赖树不动）。
    expect({ name: lock.name, version: lock.version }).toEqual({ name: pkg.name, version: pkg.version });
    expect({ name: root.name, version: root.version, license: root.license }).toEqual({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
    });
  });
});

describe('随包：LICENSE 与 THIRD-PARTY-NOTICES.md 进安装目录 resources/', () => {
  it('extraResources 解析器只读本段、认 from/to 对、到下一个顶层键为止', () => {
    const yml = [
      'files:',
      "  - 'out/**'",
      'extraResources:',
      '  - from: a.mjs',
      '    to: a.mjs',
      '  # 注释行',
      "  - from: '../LICENSE'   # 行尾注释",
      '    to: LICENSE.txt',
      'asarUnpack:',
      '  - from: nope',
    ].join('\n');
    expect(extraResourcesOf(yml)).toEqual([
      { from: 'a.mjs', to: 'a.mjs' },
      { from: '../LICENSE', to: 'LICENSE.txt' },
    ]);
  });

  it('electron-builder.yml 拷 ../LICENSE → LICENSE.txt、../THIRD-PARTY-NOTICES.md → THIRD-PARTY-NOTICES.md，且每个 from 都真有其文件', () => {
    const items = extraResourcesOf(readText(join(appRoot, 'electron-builder.yml')));
    expect(items).toContainEqual({ from: '../LICENSE', to: 'LICENSE.txt' });
    expect(items).toContainEqual({ from: '../THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md' });
    // electron-builder 的 copyFiles 对不存在的 from 只打一行 warn、照样出包（app-builder-lib fileMatcher.js），
    // 仓库根的文件一改名，安装包就悄悄少了许可——所以在这里拦。
    const missing = items.filter((i) => !existsSync(join(appRoot, i.from))).map((i) => i.from);
    expect(missing, 'extraResources 的这些 from 没有对应文件（electron-builder 不会报错，只会少拷）').toEqual([]);
  });
});

describe('绊线的解析与核对（纯函数，夹具）', () => {
  const HEADER = [
    '/* 部分改编自 pi-mono（https://github.com/badlogic/pi-mono）',
    ' *   上游：packages/ai/src/utils/overflow.ts @ 8676a0d',
    ' *   许可：MIT，Copyright (c) 2025 Mario Zechner（全文见仓库根 THIRD-PARTY-NOTICES.md）',
    ' *   本文件已修改：只取正则表，接入本仓的 ProviderError */',
    'export const x = 1;',
  ].join('\n');
  const ROW = '| `deskminis/src/a.ts` | packages/ai/src/utils/overflow.ts @ 8676a0d | 溢出正则表 | 接入 ProviderError |';
  const notices = (rows: string[]): string =>
    [
      '# 第三方声明',
      '',
      '## 1. pi-mono — 代码改编（MIT）',
      '',
      '| 本仓位置 | 上游位置 @ 提交 | 借了什么 | 怎么改的 |',
      '|---|---|---|---|',
      ...rows,
      '',
      '- 项目：<https://github.com/badlogic/pi-mono>',
      '',
      'Copyright (c) 2025 Mario Zechner',
      'Permission is hereby granted, free of charge …',
      '',
      '## 2. 运行时依赖',
      '',
      '正文',
    ].join('\n');
  const only = (rel: string, text: string) => (r: string): string | null => (r === rel ? text : null);

  it('findAdaptMarks 认登记格式（全角 / 半角括号都认），坏格式单独报行号', () => {
    expect(findAdaptMarks(HEADER).marks).toEqual([{ name: 'pi-mono', url: 'https://github.com/badlogic/pi-mono', line: 1 }]);
    expect(findAdaptMarks('// 改编自 ZCode (https://github.com/zai-org/ZCode)').marks.map((m) => m.name)).toEqual(['ZCode']);
    expect(findAdaptMarks('x\n// 改编自 pi-mono（github.com/badlogic/pi-mono）').malformed).toEqual([2]);
    expect(findAdaptMarks('const a = 1; // 普通注释')).toEqual({ marks: [], malformed: [] });
  });

  it('parseNotices 认出改编节、表头与登记行（路径去掉行号后缀）', () => {
    const [s, deps] = parseNotices(notices([ROW.replace('a.ts`', 'a.ts:10-40`')]));
    expect(s.num).toBe(1);
    expect(s.adapt).toEqual({ name: 'pi-mono', license: 'MIT' });
    expect(s.tableHeader).toEqual(TABLE_HEADER);
    expect(s.rows.map((r) => r.path)).toEqual(['deskminis/src/a.ts']);
    expect(s.rows[0].cells).toHaveLength(4);
    expect(checkAdaptSectionFormat(s)).toEqual([]);
    expect(deps.adapt).toBeNull();
    expect(deps.title).toBe('运行时依赖');
  });

  it('代码块里以「## 」开头的行不算节标题', () => {
    const md = ['## 1. pi-mono — 代码改编（MIT）', '', '```', '## 不是标题', '```', '', '## 2. 运行时依赖'].join('\n');
    expect(parseNotices(md).map((s) => s.num)).toEqual([1, 2]);
  });

  it('空表也是合规的改编节', () => {
    const [s] = parseNotices(notices([]));
    expect(s.rows).toEqual([]);
    expect(checkAdaptSectionFormat(s)).toEqual([]);
  });

  it('改编节缺表头 / 缺项目链接 / 缺版权行 / MIT 缺许可全文，都报', () => {
    const [s] = parseNotices(
      '## 1. pi-mono — 代码改编（MIT）\n\n| 位置 | 上游 |\n|---|---|\n',
    );
    const p = checkAdaptSectionFormat(s);
    expect(p.join('\n')).toMatch(/表头/);
    expect(p.join('\n')).toMatch(/项目链接/);
    expect(p.join('\n')).toMatch(/Copyright/);
    expect(p.join('\n')).toMatch(/MIT 全文/);
  });

  it('两边一致时没有问题', () => {
    expect(checkTripwire([{ rel: 'deskminis/src/a.ts', text: HEADER }], notices([ROW]), only('deskminis/src/a.ts', HEADER))).toEqual([]);
  });

  it('正向：声明了却没有对应节、表里没登记、URL 对不上、坏格式，都报', () => {
    const zc = '// 改编自 ZCode（https://github.com/zai-org/ZCode）';
    expect(checkTripwire([{ rel: 'deskminis/src/z.ts', text: zc }], notices([]), () => null)).toEqual([
      expect.stringContaining('没有「## N. ZCode — 代码改编'),
    ]);
    expect(checkTripwire([{ rel: 'deskminis/src/a.ts', text: HEADER }], notices([]), () => null)).toEqual([
      expect.stringContaining('表里没有登记'),
    ]);
    const wrongUrl = HEADER.replace('badlogic/pi-mono）', 'someone/pi-mono）');
    expect(checkTripwire([{ rel: 'deskminis/src/a.ts', text: wrongUrl }], notices([ROW]), only('deskminis/src/a.ts', wrongUrl))).toEqual([
      expect.stringContaining('https://github.com/someone/pi-mono'),
    ]);
    expect(checkTripwire([{ rel: 'deskminis/src/b.ts', text: '// 改编自 pi-mono（见上游）' }], notices([]), () => null)).toEqual([
      expect.stringContaining('deskminis/src/b.ts:1'),
    ]);
  });

  it('反向：登记的文件不存在、文件头没有声明、声明缺「本文件已修改」、行没填满，都报', () => {
    expect(checkTripwire([], notices([ROW]), () => null)).toEqual([expect.stringContaining('不存在')]);

    const buried = ['export const x = 1;', ...Array.from({ length: HEAD_LINES }, () => ''), HEADER].join('\n');
    expect(checkTripwire([], notices([ROW]), only('deskminis/src/a.ts', buried))).toEqual([
      expect.stringContaining(`文件头（前 ${HEAD_LINES} 行）没有「改编自 pi-mono`),
    ]);

    const noModNote = HEADER.replace(/ \*   本文件已修改：[^\n]*/, ' */');
    expect(checkTripwire([], notices([ROW]), only('deskminis/src/a.ts', noModNote))).toEqual([
      expect.stringContaining('本文件已修改'),
    ]);

    expect(checkTripwire([], notices(['| `deskminis/src/a.ts` | 没写提交 | 溢出正则表 |']), only('deskminis/src/a.ts', HEADER))).toEqual([
      expect.stringContaining('四列'),
      expect.stringContaining('第二列'),
    ]);
  });

  it('checkDepLicenses：非 MIT 的随包包没列、许可写错、表上的包锁里没有、没带许可文件的包没点名，都报；dev 包与可选包不按这几条查', () => {
    const lockPkgs: Record<string, LockEntry> = {
      '': { license: 'Apache-2.0' }, // 本项目自己
      'node_modules/ws': { license: 'MIT' },
      'node_modules/@n/a': { license: 'MIT' },
      'node_modules/@n/b': { license: 'MIT' },
      'node_modules/lazy-val': { license: 'MIT' }, // 包内没有许可文件，正文没点名
      'node_modules/ini': { license: 'ISC' }, // 列了，许可对
      'node_modules/tool/node_modules/ini': { license: 'BlueOak-1.0.0', dev: true }, // 构建工具自带的同名包，不拿来对表
      'node_modules/sax': { license: 'BlueOak-1.0.0' }, // 列了，许可写成 MIT
      'node_modules/detect-libc': { license: 'Apache-2.0' }, // 没列
      'node_modules/x/node_modules/semver': { license: 'ISC' }, // 嵌套的一份，也没列
      'node_modules/vue': { license: 'MIT', dev: true },
      'node_modules/speakingurl': { license: 'BSD-3-Clause', dev: true }, // dev 包不进 asar，不要求列
      'node_modules/@n/bin-win32': { license: 'MIT', optional: true }, // 平台二进制包，本机装没装因平台而异
      'node_modules/gone': { license: 'ISC' }, // 本机没装：没列照样报（许可看锁，不看本机）
    };
    const noFile = new Set(['node_modules/lazy-val', 'node_modules/@n/bin-win32']);
    const has = (k: string): boolean | null => (k === 'node_modules/gone' ? null : !noFile.has(k));
    const body = [
      '直接依赖均为 MIT：',
      '',
      '| 包 | 许可 | 随包形态 |',
      '|---|---|---|',
      '| `ws` | MIT | app.asar |',
      '| `@n/a`、`@n/b` | MIT | app.asar |',
      '| `vue` | MIT | 渲染包 |',
      '| `left-pad` | MIT | app.asar |',
      '',
      '间接依赖里许可不同的：',
      '',
      '| 包 | 许可 | 经由 |',
      '|---|---|---|',
      '| `ini` | ISC | x → rc |',
      '| `sax` | MIT | y |',
    ].join('\n');
    expect(checkDepLicenses(body, lockPkgs, has)).toEqual([
      expect.stringMatching(/^lazy-val 包内没有许可文件/),
      expect.stringMatching(/^依赖一节把 sax 的许可写成「MIT」，锁文件 node_modules\/sax 里是「BlueOak-1\.0\.0」/),
      expect.stringMatching(/^detect-libc（Apache-2\.0）随安装包分发，但依赖一节的表上没列/),
      expect.stringMatching(/^semver（ISC）随安装包分发，但依赖一节的表上没列（锁文件 node_modules\/x\/node_modules\/semver）/),
      expect.stringMatching(/^gone（ISC）随安装包分发/),
      expect.stringMatching(/^依赖一节列了 left-pad，但锁文件里没有这个包/),
    ]);

    // 补齐之后没有问题：嵌套的 semver 与顶层同名，一行就够；lazy-val 在正文里点名即可，不必进表
    const fixed = body.replace('| `sax` | MIT |', '| `sax` | BlueOak-1.0.0 |').replace('| `left-pad` | MIT | app.asar |\n', '') +
      '\n| `detect-libc` | Apache-2.0 | z |\n| `semver` | ISC | x |\n| `gone` | ISC | w |\n\n`lazy-val` 包内没有许可文件，MIT。';
    expect(checkDepLicenses(fixed, lockPkgs, has)).toEqual([]);
    // 只有 dev 条目的包（vue）照 dev 条目对许可
    expect(checkDepLicenses(fixed.replace('| `vue` | MIT |', '| `vue` | ISC |'), lockPkgs, has)).toEqual([
      expect.stringMatching(/^依赖一节把 vue 的许可写成「ISC」，锁文件 node_modules\/vue 里是「MIT」/),
    ]);
  });

  it('unlistedDeps 只认表上的行：散文、列表项里带反引号的包名不算列了', () => {
    const body = [
      '| 包 | 许可 | 随包形态 |',
      '|---|---|---|',
      '| `ws` | MIT | app.asar |',
      '| `@noble/ciphers`、`@noble/hashes` | MIT | app.asar |',
      '',
      '`undici` 等包也是 MIT。',
      '',
      '- `@napi-rs/keyring` 的平台二进制包只有 `.node`、README 与 package.json。',
    ].join('\n');
    const required = ['@napi-rs/keyring', '@noble/ciphers', '@noble/hashes', 'undici', 'ws'];
    expect(unlistedDeps(body, required)).toEqual(['@napi-rs/keyring', 'undici']);
    // 表头那一格里的反引号也不算
    expect(unlistedDeps('| `yauzl` | 许可 |\n|---|---|', ['yauzl'])).toEqual(['yauzl']);
  });
});

describe('THIRD-PARTY-NOTICES.md（仓库根）', () => {
  const md = readText(join(repoRoot, NOTICES_REL));
  const sections = parseNotices(md);
  const adapt = sections.filter((s) => s.adapt);

  it('pi-mono（MIT）与 ZCode（Apache-2.0）各有一节改编表，格式合规；每个上游只开一节', () => {
    expect(adapt.map((s) => s.adapt)).toEqual(
      expect.arrayContaining([
        { name: 'pi-mono', license: 'MIT' },
        { name: 'ZCode', license: 'Apache-2.0' },
      ]),
    );
    const names = adapt.map((s) => s.adapt?.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i), '同一上游只开一节，后来的借用往既有表里追加行').toEqual([]);
    expect(adapt.flatMap(checkAdaptSectionFormat)).toEqual([]);
  });

  it('带编号的节从 1 起连续编号', () => {
    const nums = sections.map((s) => s.num).filter((n): n is number => n !== null);
    expect(nums).toEqual(nums.map((_, i) => i + 1));
  });

  it('AionUi 令牌取值一节与「仅借思路、未复制代码」一节都在', () => {
    const aion = sections.find((s) => s.title.startsWith('AionUi'));
    expect(aion, 'NOTICES 缺 AionUi 一节（tokens.css A 区的取值来自 AionUi）').toBeDefined();
    expect(aion?.body ?? '').toMatch(/tokens\.css/);
    expect(aion?.body ?? '').toMatch(/Copyright 2025 AionUi/);
    const ideas = sections.find((s) => s.title.includes('仅借思路'));
    expect(ideas, 'NOTICES 缺「仅借思路、未复制代码」一节').toBeDefined();
    expect(ideas?.body ?? '').toMatch(/OpenMinis/);
  });

  it('依赖一节列全了随包分发的第三方包（dependencies 全部 + 打进渲染包的）', () => {
    const pkg = JSON.parse(readText(join(appRoot, 'package.json'))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const known = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
    // 渲染端与 preload 由 vite 打成单文件，devDependencies 里的 vue / pinia 也在其中，而且打包后不留许可注释，
    // 所以它们的署名只能靠本文件。
    const bundled: string[] = [];
    for (const d of ['src/renderer/src', 'src/preload']) walk(join(appRoot, d), bundled);
    const imported = new Set<string>();
    for (const f of bundled) {
      for (const m of readText(f).matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"]([^'"./][^'"]*)['"]/g)) {
        const name = pkgNameOf(m[1]);
        if (known.has(name)) imported.add(name);
      }
    }
    const required = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...imported])].sort();
    const deps = sections.find((s) => s.title.includes('运行时依赖'));
    expect(deps, 'NOTICES 缺「运行时依赖」一节').toBeDefined();
    expect(
      unlistedDeps(deps?.body ?? '', required),
      '这些包随安装包分发，但 NOTICES 依赖一节的表上没有它们的行（每个包要在表上占一行，第一格反引号包住包名）',
    ).toEqual([]);
  });

  it('依赖一节的许可与锁文件对得上：许可不是 MIT 的随包包都列了、表上的许可与锁一致、没带许可文件的包点了名', () => {
    const lock = JSON.parse(readText(join(appRoot, 'package-lock.json'))) as { packages?: Record<string, LockEntry> };
    // 「包内有没有许可文件」看本机 node_modules：electron-builder 的默认过滤不碰 LICENSE / COPYING，
    // 实测 app.asar 里缺许可文件的包与 node_modules 里缺的是同一批。本机没装的（别的平台的可选包）返回 null，不查。
    const hasLicenseFile = (key: string): boolean | null => {
      const dir = join(appRoot, ...key.split('/'));
      return existsSync(dir) ? readdirSync(dir).some((f) => LICENSE_FILE_RE.test(f)) : null;
    };
    const deps = sections.find((s) => s.title.includes('运行时依赖'));
    expect(deps, 'NOTICES 缺「运行时依赖」一节').toBeDefined();
    const problems = checkDepLicenses(deps?.body ?? '', lock.packages ?? {}, hasLicenseFile);
    expect(problems, 'NOTICES 第 6 节随安装包分发，许可要写实：\n' + problems.join('\n')).toEqual([]);
  });
});

describe('双向绊线：源码的改编声明 ↔ NOTICES 改编表', () => {
  it('两边一致', () => {
    const problems = checkTripwire(repoSources(), readText(join(repoRoot, NOTICES_REL)), readRepoFile);
    expect(problems, '借用即登记（设计稿 §1 第 5 条）：\n' + problems.join('\n')).toEqual([]);
  });
});
