import fs from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asar = createRequire(join(app, 'package.json'))('@electron/asar');
const MiB = 1024 * 1024;
// Q04 同锁依赖实测：96,918,596 / 15,116,256 / 3,811,710 字节。
// 余量分别约 8.2% / 11.0% / 10.0%；升级依赖或增加资源时须重新量测并审查阈值。
export const PACKAGE_SIZE_LIMITS = Object.freeze({ installer: 100 * MiB, asar: 16 * MiB, unpacked: 4 * MiB });
export const UNPACKED_PACKAGES = Object.freeze(['better-sqlite3', '@napi-rs/keyring-win32-x64-msvc']);
export const WINDOWS_LOCALES = Object.freeze(['en-US.pak', 'zh-CN.pak']);

function fullMit(text) {
  const section = text.split(/^## 1\./m)[1]?.split(/^## 2\./m)[0] ?? '';
  const mit = section.match(/Permission is hereby granted[\s\S]*?SOFTWARE\./)?.[0].replace(/\s+/g, ' ').trim() ?? '';
  return createHash('sha256').update(mit).digest('hex') === 'fe2a9817987f862eaced948f0468c7f51d2fedfc48c5c505b246a49a3870e9a5';
}

function bundledXtermLicense(text) {
  const section = text.split(/^## 6\./m)[1]?.split(/^## 7\./m)[0] ?? '';
  const credits = [
    ['@xterm/xterm', 'Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)'],
    ['@xterm/xterm', 'Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)'],
    ['@xterm/xterm', 'Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)'],
    ['@xterm/addon-fit', 'Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)'],
  ];
  return fullMit(text) && section.includes('许可全文与第 1 节所录的 MIT 全文相同') &&
    credits.every(([name, credit]) => section.split(/\r?\n/).some(line => line.includes('`' + name + '`') && line.includes(credit)));
}

function packageRoot(file) {
  const matches = [...file.matchAll(/(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)/g)];
  const last = matches.at(-1);
  return last && { name: last[1], root: file.slice(0, last.index + last[0].length) };
}

function unpackedFiles(root) {
  const result = [];
  const walk = (dir, prefix = '') => {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Unpacked payload is a link: ' + dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Unpacked payload is a link: ' + file);
      if (entry.isDirectory()) walk(file, rel + '/');
      else result.push({ file: rel, size: fs.statSync(file).size });
    }
  };
  walk(root);
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

/** 仅两个既有的缺许可文件包由 NOTICES §6 明确指向 §1 MIT 全文，并有包本身的署名。 */
function noticeLicense(name, license, text) {
  const attribution = {
    'lazy-val': 'Vladimir Krivosheev',
    '@napi-rs/keyring-win32-x64-msvc': 'Copyright (c) 2020 N-API for Rust',
  }[name];
  if (!attribution || license !== 'MIT') return false;
  const section = text.split(/^## 6\./m)[1]?.split(/^## 7\./m)[0] ?? '';
  const credit = section.split(/\r?\n(?=- )/).find(p => p.includes('`' + name + '`') && p.includes(attribution));
  // 钉住 MIT 从授权到免责的完整正文；允许排版换行变化，不能只剩开头与结尾。
  return !!credit && section.includes('许可全文与第 1 节所录的 MIT 全文相同') &&
    fullMit(text);
}

// Electron 的 fs 默认把 .asar 当目录；检查产物时必须读物理文件，并恢复调用方状态。
function withRawFilesystem(read) {
  const hadNoAsar = Object.hasOwn(process, 'noAsar');
  const previousNoAsar = process.noAsar;
  try {
    process.noAsar = true;
    return read();
  } finally {
    if (hadNoAsar) process.noAsar = previousNoAsar;
    else delete process.noAsar;
  }
}

/** 只读实际发布产物，不读取源 node_modules 或锁文件来猜包内许可。 */
export function verifyPackageComposition(resources, options = {}) {
  return withRawFilesystem(() => inspectPackageComposition(resources, options));
}

function inspectPackageComposition(resources, { installer } = {}) {
  const archive = join(resources, 'app.asar');
  const report = { ok: false, resources: resolve(resources), installer: installer ? resolve(installer) : null,
    sizes: {}, limits: PACKAGE_SIZE_LIMITS, locales: [], unpackedPackages: [], unpackedFiles: [], packages: [], issues: [] };
  const issue = (code, detail) => report.issues.push({ code, detail });
  try {
    const locales = join(resources, '..', 'locales');
    try {
      report.locales = fs.readdirSync(locales).sort();
      if (fs.lstatSync(locales).isSymbolicLink() || JSON.stringify(report.locales) !== JSON.stringify(WINDOWS_LOCALES) ||
        report.locales.some(name => { const stat = fs.lstatSync(join(locales, name)); return !stat.isFile() || stat.size === 0; })) {
        issue('LANGUAGE_PACKS_INVALID', `Expected nonempty ${WINDOWS_LOCALES.join(', ')} only; found ${report.locales.join(', ')}`);
      }
    } catch (error) { issue('LANGUAGE_PACKS_INVALID', error.message); }
    asar.uncache(archive);
    report.unpackedFiles = unpackedFiles(join(resources, 'app.asar.unpacked'));
    report.sizes = {
      installer: installer ? fs.statSync(installer).size : null,
      asar: fs.statSync(archive).size,
      unpacked: report.unpackedFiles.reduce((n, file) => n + file.size, 0),
    };
    if (report.sizes.asar === 0) {
      issue('ASAR_SIZE_INVALID', 'app.asar: 0 bytes');
      return report;
    }
    for (const [part, size] of Object.entries(report.sizes)) {
      if (size !== null && size > PACKAGE_SIZE_LIMITS[part]) issue('SIZE_LIMIT_EXCEEDED', `${part}: ${size} > ${PACKAGE_SIZE_LIMITS[part]} bytes`);
    }
    const packages = new Set();
    for (const { file } of report.unpackedFiles) {
      const pkg = packageRoot(file);
      if (!file.startsWith('node_modules/') || !pkg || !UNPACKED_PACKAGES.includes(pkg.name)) issue('UNPACKED_PACKAGE_NOT_ALLOWED', file);
      if (pkg) packages.add(pkg.name);
    }
    report.unpackedPackages = [...packages].sort();
    for (const name of UNPACKED_PACKAGES) if (!packages.has(name)) issue('UNPACKED_PACKAGE_MISSING', name);

    const files = asar.listPackage(archive).map(f => f.replace(/^[/\\]+/, '').replaceAll('\\', '/'))
      .filter(f => !asar.statFile(archive, normalize(f)).files);
    const roots = new Map();
    for (const file of files) {
      const pkg = packageRoot(file);
      if (pkg) roots.set(pkg.root, pkg.name);
    }
    const notices = fs.readFileSync(join(resources, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    if (!bundledXtermLicense(notices)) issue('BUNDLED_LICENSE_MISSING', '@xterm/xterm / @xterm/addon-fit copyright and full MIT license in THIRD-PARTY-NOTICES.md');
    for (const [root, name] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
      const record = { root, name, licenseFiles: [], coverage: null };
      report.packages.push(record);
      const manifest = root + '/package.json';
      if (!files.includes(manifest)) { issue('PACKAGE_METADATA_MISSING', root); continue; }
      const pkg = JSON.parse(asar.extractFile(archive, normalize(manifest)).toString('utf8'));
      record.version = pkg.version;
      record.license = pkg.license;
      if (pkg.name !== name) issue('PACKAGE_NAME_MISMATCH', `${root}: ${pkg.name}`);
      record.licenseFiles = files.filter(f => f.startsWith(root + '/') && !f.slice(root.length + 1).includes('/') &&
        /^(licen[cs]e|copying|unlicense)/i.test(f.slice(root.length + 1)) && asar.extractFile(archive, normalize(f)).length > 0);
      if (record.licenseFiles.length) record.coverage = 'packaged-license-file';
      else if (noticeLicense(name, pkg.license, notices)) record.coverage = 'THIRD-PARTY-NOTICES.md §6 → §1 MIT';
      else issue('PACKAGE_LICENSE_MISSING', root);
    }
  } catch (error) { issue('PACKAGE_INSPECTION_FAILED', error.message); }
  report.ok = report.issues.length === 0;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
  const dist = value('--dist'), resourceDir = value('--resources'), output = value('--output');
  if ((!dist && !resourceDir) || (dist && resourceDir) || !output || fs.existsSync(output)) throw new Error('Use --dist or --resources, and a new --output');
  const resources = resourceDir ? resolve(resourceDir) : join(resolve(dist), 'win-unpacked/resources');
  let installer = value('--installer');
  if (dist && !installer) {
    const pkg = withRawFilesystem(() => JSON.parse(asar.extractFile(join(resources, 'app.asar'), 'package.json').toString('utf8')));
    installer = join(resolve(dist), `DeskMinis-${pkg.version}-Setup.exe`);
  }
  const proof = verifyPackageComposition(resources, { installer });
  fs.writeFileSync(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ok: proof.ok, sizes: proof.sizes, unpackedPackages: proof.unpackedPackages, packageCount: proof.packages.length, issues: proof.issues }));
  process.exit(proof.ok ? 0 : 1);
}
