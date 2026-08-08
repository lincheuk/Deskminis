import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// tests/ → repoRoot = deskminis/
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const builderYml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8');

describe('M5 electron-builder.yml 静态守卫', () => {
  it('asarUnpack 解包 better-sqlite3 原生模块（硬阻塞 3）', () => {
    expect(builderYml).toMatch(/asarUnpack:/);
    expect(builderYml).toMatch(/better-sqlite3/);
  });

  it('asarUnpack 解包 @napi-rs/keyring-win32-x64-msvc 原生模块（硬阻塞 3）', () => {
    expect(builderYml).toMatch(/asarUnpack:/);
    expect(builderYml).toMatch(/@napi-rs\/keyring-win32-x64-msvc/);
  });

  it('extraResources 携带桥 stub 与 .cmd 垫片（硬阻塞 1/2）', () => {
    expect(builderYml).toMatch(/extraResources:/);
    expect(builderYml).toMatch(/bridge-cli\.mjs/);
    expect(builderYml).toMatch(/bridge-node\.cmd/);
  });

  it('win 目标含 nsis 与 portable 两形态（决策点 2-4）', () => {
    expect(builderYml).toMatch(/win:\s*$/m);
    expect(builderYml).toMatch(/nsis/);
    expect(builderYml).toMatch(/portable/);
  });

  it('artifactName 使用版本模板（决策点 2-6）', () => {
    expect(builderYml).toMatch(/artifactName:\s*'?DeskMinis-\$\{version\}/);
  });

  it('version 从 0.1.0 提升到 0.1.1（决策点 2-6）', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: string };
    expect(pkg.version).toBe('0.1.1');
  });
});