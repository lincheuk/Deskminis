import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const asar = createRequire(join(__dirname, '../package.json'))('@electron/asar');
const load = () => import(pathToFileURL(join(__dirname, '../scripts/windows-package-composition.mjs')).href);
const notices = fs.readFileSync(join(__dirname, '../../THIRD-PARTY-NOTICES.md'), 'utf8');

async function fixture(scenario: string, run: (resources: string, installer: string, root: string) => Promise<void>) {
  const runtime = process as typeof process & { noAsar?: boolean };
  const previous = runtime.noAsar;
  runtime.noAsar = true;
  const root = fs.mkdtempSync(join(tmpdir(), 'dm-q03-composition-'));
  const source = join(root, 'archive-input'), resources = join(root, 'resources'), installer = join(root, 'Setup.exe');
  const write = (file: string, value: string) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, value); };
  try {
    write(join(source, 'package.json'), JSON.stringify({ name: 'deskminis', version: '0.3.0' }));
    for (const [dir, name, license] of [
      ['better-sqlite3', 'better-sqlite3', 'MIT'], ['@napi-rs/keyring-win32-x64-msvc', '@napi-rs/keyring-win32-x64-msvc', 'MIT'],
      ['lazy-val', 'lazy-val', 'MIT'], ['sax', 'sax', 'BlueOak-1.0.0'], ['electron-updater', 'electron-updater', 'MIT'],
      ['electron-updater/node_modules/semver', 'semver', 'ISC'],
    ]) {
      write(join(source, 'node_modules', dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', license }));
      if (!['lazy-val', '@napi-rs/keyring-win32-x64-msvc'].includes(name)) write(join(source, 'node_modules', dir, 'LICENSE.md'), 'fixture license text');
    }
    write(join(source, 'node_modules/better-sqlite3/binding.node'), 'native fixture');
    write(join(source, 'node_modules/@napi-rs/keyring-win32-x64-msvc/binding.node'), 'native fixture');
    let declaration = notices;
    if (scenario === 'missing-license') fs.unlinkSync(join(source, 'node_modules/sax/LICENSE.md'));
    if (scenario === 'empty-license') write(join(source, 'node_modules/sax/LICENSE.md'), '');
    if (scenario === 'nested-license-cannot-cover-parent') fs.unlinkSync(join(source, 'node_modules/electron-updater/LICENSE.md'));
    if (scenario === 'missing-package-json') fs.unlinkSync(join(source, 'node_modules/sax/package.json'));
    if (scenario === 'wrong-package-name') write(join(source, 'node_modules/sax/package.json'), JSON.stringify({ name: 'another-package', license: 'BlueOak-1.0.0' }));
    if (scenario === 'missing-notice-credit') declaration = declaration.replace('Vladimir Krivosheev', 'missing author');
    if (scenario === 'missing-notice-license') declaration = declaration.replace(/Permission is hereby granted, free of charge/g, 'license omitted');
    if (scenario === 'incomplete-notice-license') declaration = declaration.replace(/The above copyright notice[\s\S]*?substantial portions of the Software\./g, 'condition omitted');
    if (scenario === 'missing-referenced-license-section') declaration = declaration.replace(/^## 1\.[\s\S]*?(?=^## 2\.)/m, '');
    if (scenario === 'notice-cannot-cover-other-license') write(join(source, 'node_modules/lazy-val/package.json'), JSON.stringify({ name: 'lazy-val', license: 'ISC' }));
    if (scenario === 'missing-target-native-package') fs.unlinkSync(join(source, 'node_modules/@napi-rs/keyring-win32-x64-msvc/binding.node'));
    write(join(resources, 'THIRD-PARTY-NOTICES.md'), declaration);
    write(installer, 'installer fixture');
    write(join(root, 'locales/en-US.pak'), 'English fixture');
    write(join(root, 'locales/zh-CN.pak'), 'Chinese fixture');
    if (scenario === 'extra-locale') write(join(root, 'locales/de.pak'), 'unexpected locale');
    if (scenario === 'extra-locale-file') write(join(root, 'locales/readme.txt'), 'unexpected file');
    if (scenario === 'missing-locale') fs.unlinkSync(join(root, 'locales/zh-CN.pak'));
    if (scenario === 'empty-locale') write(join(root, 'locales/zh-CN.pak'), '');
    if (scenario === 'locale-is-directory') { fs.unlinkSync(join(root, 'locales/zh-CN.pak')); fs.mkdirSync(join(root, 'locales/zh-CN.pak')); }
    if (scenario === 'missing-locales-directory') fs.renameSync(join(root, 'locales'), join(root, 'locales-moved'));
    if (scenario === 'missing-xterm-credit') write(join(resources, 'THIRD-PARTY-NOTICES.md'), declaration.replace('Copyright (c) 2012-2013, Christopher Jeffrey', 'credit omitted'));
    if (scenario === 'missing-addon-credit') write(join(resources, 'THIRD-PARTY-NOTICES.md'), declaration.replace('Copyright (c) 2019, The xterm.js authors', 'credit omitted'));
    await asar.createPackageWithOptions(source, join(resources, 'app.asar'), { unpack: '*.node' });
    if (scenario === 'unexpected-unpacked-package') write(join(resources, 'app.asar.unpacked/node_modules/ws/extra.node'), 'not allowed');
    if (scenario === 'unexpected-unpacked-file') write(join(resources, 'app.asar.unpacked/out/extra.node'), 'not allowed');
    const m = await load();
    const grow = (file: string, size: number) => { const fd = fs.openSync(file, 'r+'); try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); } };
    if (scenario === 'installer-over-limit') grow(installer, m.PACKAGE_SIZE_LIMITS.installer + 1);
    if (scenario === 'asar-over-limit') grow(join(resources, 'app.asar'), m.PACKAGE_SIZE_LIMITS.asar + 1);
    if (scenario === 'asar-zero-size') grow(join(resources, 'app.asar'), 0);
    if (scenario === 'pre-q04-sizes') {
      grow(installer, 108379953); grow(join(resources, 'app.asar'), 24793314);
      const file = join(resources, 'app.asar.unpacked/node_modules/better-sqlite3/old-payload.bin');
      write(file, ''); grow(file, 14167902);
    }
    if (scenario === 'unpacked-over-limit') {
      const file = join(resources, 'app.asar.unpacked/node_modules/better-sqlite3/large.bin');
      write(file, ''); grow(file, m.PACKAGE_SIZE_LIMITS.unpacked + 1);
    }
    // 真实产物的缺许可不能由另一个本机安装目录补足。
    write(join(root, 'local/node_modules/sax/LICENSE.md'), 'present only in local dependencies');
    await run(resources, installer, root);
  } finally {
    try {
      asar.uncache(join(resources, 'app.asar'));
      if (!resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unsafe fixture cleanup');
      fs.rmSync(root, { recursive: true, force: true });
    } finally { runtime.noAsar = previous; }
  }
}

describe('Q03 实际 ASAR 的包构成与许可', () => {
  it('Q04 精简前的三个实测体积都超过新预算，不能无声回退全部节省', async () => {
    await fixture('pre-q04-sizes', async (resources, installer) => {
      const m = await load(), result = m.verifyPackageComposition(resources, { installer });
      expect(result.ok).toBe(false);
      for (const part of ['installer', 'asar', 'unpacked']) {
        expect(result.issues.some((i: { code: string; detail: string }) => i.code === 'SIZE_LIMIT_EXCEEDED' && i.detail.startsWith(part + ':'))).toBe(true);
      }
    });
  });
  it('许可文件、两项明确声明、嵌套依赖均从实际产物核对，并记录三项字节数', async () => {
    await fixture('valid', async (resources, installer) => {
      const m = await load(), result = m.verifyPackageComposition(resources, { installer });
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.unpackedPackages).toEqual(['@napi-rs/keyring-win32-x64-msvc', 'better-sqlite3']);
      expect(result.packages).toHaveLength(6);
      expect(result.packages.find((p: { name: string }) => p.name === 'lazy-val')?.coverage).toContain('THIRD-PARTY-NOTICES');
      expect(result.packages.find((p: { name: string }) => p.name === 'semver')?.root).toBe('node_modules/electron-updater/node_modules/semver');
      expect(result.sizes.installer).toBe(fs.statSync(installer).size);
      expect(result.sizes.asar).toBe(fs.statSync(join(resources, 'app.asar')).size);
      expect(result.sizes.unpacked).toBe(Buffer.byteLength('native fixture') * 2);
      expect(result.locales).toEqual(['en-US.pak', 'zh-CN.pak']);
    });
  });

  it.each([
    ['missing-license', 'PACKAGE_LICENSE_MISSING', 'sax'], ['empty-license', 'PACKAGE_LICENSE_MISSING', 'sax'],
    ['nested-license-cannot-cover-parent', 'PACKAGE_LICENSE_MISSING', 'electron-updater'],
    ['missing-package-json', 'PACKAGE_METADATA_MISSING', 'sax'], ['wrong-package-name', 'PACKAGE_NAME_MISMATCH', 'sax'],
    ['missing-notice-credit', 'PACKAGE_LICENSE_MISSING', 'lazy-val'], ['missing-notice-license', 'PACKAGE_LICENSE_MISSING', 'lazy-val'],
    ['incomplete-notice-license', 'PACKAGE_LICENSE_MISSING', 'lazy-val'], ['missing-referenced-license-section', 'PACKAGE_LICENSE_MISSING', 'lazy-val'],
    ['notice-cannot-cover-other-license', 'PACKAGE_LICENSE_MISSING', 'lazy-val'],
    ['unexpected-unpacked-package', 'UNPACKED_PACKAGE_NOT_ALLOWED', 'ws'], ['unexpected-unpacked-file', 'UNPACKED_PACKAGE_NOT_ALLOWED', 'out/'],
    ['missing-target-native-package', 'UNPACKED_PACKAGE_MISSING', 'keyring-win32-x64-msvc'],
    ['installer-over-limit', 'SIZE_LIMIT_EXCEEDED', 'installer'], ['asar-over-limit', 'SIZE_LIMIT_EXCEEDED', 'asar'],
    ['asar-zero-size', 'ASAR_SIZE_INVALID', 'app.asar'],
    ['unpacked-over-limit', 'SIZE_LIMIT_EXCEEDED', 'unpacked'],
    ['extra-locale', 'LANGUAGE_PACKS_INVALID', 'de.pak'], ['extra-locale-file', 'LANGUAGE_PACKS_INVALID', 'readme.txt'],
    ['missing-locale', 'LANGUAGE_PACKS_INVALID', 'zh-CN.pak'], ['empty-locale', 'LANGUAGE_PACKS_INVALID', 'zh-CN.pak'],
    ['locale-is-directory', 'LANGUAGE_PACKS_INVALID', 'zh-CN.pak'], ['missing-locales-directory', 'LANGUAGE_PACKS_INVALID', 'locales'],
    ['missing-xterm-credit', 'BUNDLED_LICENSE_MISSING', '@xterm/xterm'], ['missing-addon-credit', 'BUNDLED_LICENSE_MISSING', '@xterm/addon-fit'],
  ])('%s 不能被本机许可文件、宽白名单或其它包的声明掩盖', async (scenario, code, witness) => {
    await fixture(scenario, async (resources, installer) => {
      const m = await load(), result = m.verifyPackageComposition(resources, { installer });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i: { code: string; detail: string }) => i.code === code && i.detail.includes(witness)), JSON.stringify(result.issues)).toBe(true);
    });
  });

  it.each(['valid', 'asar-over-limit'])('Electron Node 子进程启用默认 ASAR 拦截：%s 仍量物理文件并检查上限', async scenario => {
    await fixture(scenario, async (resources, installer, root) => {
      const script = join(__dirname, '../scripts/windows-package-composition.mjs');
      const output = join(root, 'child-report.json');
      const actualSize = fs.statSync(join(resources, 'app.asar')).size;
      const electron = createRequire(join(__dirname, '../package.json'))('electron') as string;
      const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
      delete env.ELECTRON_NO_ASAR;
      // 仅观察默认拦截，再运行正式 CLI；子进程没有预先修改 process.noAsar。
      const probe = `const fs=require('node:fs'),url=require('node:url');
const [script,...args]=process.argv.slice(1);
const archive=args[args.indexOf('--resources')+1]+'/app.asar';
const stat=fs.statSync(archive);
console.log(JSON.stringify({interceptedSize:stat.size,interceptedDirectory:stat.isDirectory(),noAsar:process.noAsar??null}));
process.argv=[process.execPath,script,...args];import(url.pathToFileURL(script).href);`;
      const run = spawnSync(electron, ['-e', probe, script, '--resources', resources, '--installer', installer, '--output', output],
        { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
      expect(run.error).toBeUndefined();
      const before = JSON.parse(run.stdout.split(/\r?\n/)[0]);
      expect(before).toEqual({ interceptedSize: 0, interceptedDirectory: true, noAsar: null });
      const report = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(report.sizes.asar).toBe(actualSize);
      if (scenario === 'valid') {
        expect(run.status, run.stderr).toBe(0);
        expect(report.ok).toBe(true);
        expect(report.issues).toEqual([]);
      } else {
        expect(run.status, run.stderr).toBe(1);
        expect(report.ok).toBe(false);
        expect(report.issues).toContainEqual({ code: 'SIZE_LIMIT_EXCEEDED', detail: `asar: ${actualSize} > ${report.limits.asar} bytes` });
      }
    });
  });

  it.each([false, true])('成功读取后恢复调用方 process.noAsar=%s', async initial => {
    await fixture('valid', async (resources, installer) => {
      const m = await load(), runtime = process as typeof process & { noAsar?: boolean };
      const before = runtime.noAsar;
      try {
        runtime.noAsar = initial;
        const report = m.verifyPackageComposition(resources, { installer });
        expect(runtime.noAsar).toBe(initial);
        expect(report.ok).toBe(true);
      } finally { runtime.noAsar = before; }
    });
  });

  it('读取失败也恢复调用方原本没有 noAsar 属性的状态', async () => {
    await fixture('valid', async (resources, installer) => {
      const m = await load(), runtime = process as { noAsar?: boolean };
      const before = runtime.noAsar;
      try {
        delete runtime.noAsar;
        const report = m.verifyPackageComposition(join(resources, 'missing'), { installer });
        expect(Object.hasOwn(runtime, 'noAsar')).toBe(false);
        expect(report.ok).toBe(false);
        expect(report.issues.some((issue: { code: string }) => issue.code === 'PACKAGE_INSPECTION_FAILED')).toBe(true);
      } finally { runtime.noAsar = before; }
    });
  });
});
