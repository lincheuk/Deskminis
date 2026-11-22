/** 执行隔离第 3 步（二）：密钥改存数据根里的加密文件（src/minisd/store/secret-file-vault.ts）。
 *  真机验证表明低完整性进程读得到凭据管理器；密文挪进打了「不许读」标签的数据根，钥匙留在凭据管理器。 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemoryVault, type SecretVault } from '../src/minisd/store/provider-store';
import { KEY_ACCOUNT, SECRET_FILE_NAME, SecretFileVault, isHomeDataRoot } from '../src/minisd/store/secret-file-vault';

const dirs: string[] = [];
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), 'sfv-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const quiet = (): { warns: string[]; warn: (m: string) => void } => { const warns: string[] = []; return { warns, warn: m => warns.push(m) }; };

describe('加密文件', () => {
  it('存取删；文件里没有明文；钥匙在凭据管理器里，没有别的键', () => {
    const root = mk(); const ks = new InMemoryVault();
    const v = new SecretFileVault(root, ks, quiet().warn);
    v.set('provider:a', 'sk-SECRET-1');
    v.set('pairing.static-identity', '{"priv":"PRIVATE"}');
    expect(v.get('provider:a')).toBe('sk-SECRET-1');
    const text = readFileSync(join(root, SECRET_FILE_NAME), 'utf8');
    expect(text).not.toContain('SECRET'); expect(text).not.toContain('PRIVATE');
    expect(ks.get(KEY_ACCOUNT)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(ks.get('provider:a')).toBeUndefined();
    // 换一个实例（重启）读得回来
    const again = new SecretFileVault(root, ks, quiet().warn);
    expect(again.get('pairing.static-identity')).toBe('{"priv":"PRIVATE"}');
    again.delete('provider:a');
    expect(new SecretFileVault(root, ks, quiet().warn).get('provider:a')).toBeUndefined();
    expect(existsSync(join(root, `${SECRET_FILE_NAME}.tmp`))).toBe(false);
  });

  it('用到时从凭据管理器搬过来，搬完删掉老副本', () => {
    const root = mk(); const ks = new InMemoryVault();
    ks.set('provider:old', 'sk-OLD');
    const v = new SecretFileVault(root, ks, quiet().warn);
    expect(v.get('provider:old')).toBe('sk-OLD');
    expect(ks.get('provider:old')).toBeUndefined();
    expect(new SecretFileVault(root, ks, quiet().warn).get('provider:old')).toBe('sk-OLD');
    expect(v.get('nope')).toBeUndefined();
    expect(v.get(KEY_ACCOUNT)).toBeUndefined(); // 钥匙本身不经 get 外流
  });

  it('启动迁移：一次搬完，已在文件里的只删老副本；数目如实', () => {
    const root = mk(); const ks = new InMemoryVault();
    const v = new SecretFileVault(root, ks, quiet().warn);
    v.set('a', '1');
    ks.set('a', 'stale'); ks.set('b', '2'); ks.set('c', '3');
    expect(v.migrate(['a', 'b', 'c', 'd', 'b', KEY_ACCOUNT])).toBe(2);
    expect([ks.get('a'), ks.get('b'), ks.get('c')]).toEqual([undefined, undefined, undefined]);
    expect([v.get('a'), v.get('b'), v.get('c')]).toEqual(['1', '2', '3']);
    expect(ks.get(KEY_ACCOUNT)).toBeDefined();
  });

  it('文件坏了或钥匙丢了：留底改名、从空的开始、告警；凭据管理器里没搬的照样读得到', () => {
    const root = mk(); const ks = new InMemoryVault();
    new SecretFileVault(root, ks, quiet().warn).set('a', '1');
    ks.delete(KEY_ACCOUNT);
    ks.set('b', 'legacy');
    const q = quiet();
    const v = new SecretFileVault(root, ks, q.warn);
    expect(v.get('a')).toBeUndefined();
    expect(v.get('b')).toBe('legacy');
    expect(q.warns.join('\n')).toContain('密钥文件读不出来');
    expect(readdirSync(root).some(n => n.startsWith(`${SECRET_FILE_NAME}.broken-`))).toBe(true);
    // 篡改密文：认证失败，同样留底
    writeFileSync(join(root, SECRET_FILE_NAME), readFileSync(join(root, SECRET_FILE_NAME), 'utf8').replace(/"data":"(.)/, (_m, c) => `"data":"${c === 'A' ? 'B' : 'A'}`));
    const q2 = quiet();
    expect(new SecretFileVault(root, ks, q2.warn).get('b')).toBeUndefined();
    expect(q2.warns.join('\n')).toContain('密钥文件读不出来');
  });

  it('凭据管理器写不进钥匙：set 抛错，老副本不删', () => {
    const root = mk();
    const inner = new InMemoryVault();
    const broken: SecretVault = { get: k => inner.get(k), set: (k, v) => { if (k !== KEY_ACCOUNT) inner.set(k, v); }, delete: k => inner.delete(k) };
    inner.set('a', 'legacy');
    const q = quiet();
    const v = new SecretFileVault(root, broken, q.warn);
    expect(() => v.set('x', '1')).toThrow('凭据管理器写不进');
    expect(v.get('a')).toBe('legacy');
    expect(inner.get('a')).toBe('legacy');
    expect(q.warns.join('\n')).toContain('搬进密钥文件失败');
  });
});

describe('别的数据根只抄不删', () => {
  it('removeLegacy=false：抄进自己的文件，凭据管理器里的老副本和钥匙都留着', () => {
    const ks = new InMemoryVault();
    ks.set('provider:a', 'sk-A');
    const home = new SecretFileVault(mk(), ks, quiet().warn, true);
    const other = new SecretFileVault(mk(), ks, quiet().warn, false);
    expect(other.get('provider:a')).toBe('sk-A');
    expect(other.migrate(['provider:a'])).toBe(0); // 已在文件里
    other.set('x', '1'); other.delete('provider:a');
    expect(ks.get('provider:a')).toBe('sk-A');
    // 默认根随后照样搬得到（然后删掉）
    expect(home.migrate(['provider:a'])).toBe(1);
    expect(ks.get('provider:a')).toBeUndefined();
    // 两个根共用一把钥匙，谁也不覆盖谁
    expect(new SecretFileVault(other.file.replace(/[\\/]secrets\.vault$/, ''), ks, quiet().warn, false).get('x')).toBe('1');
  });
  it('默认数据根：正式版服务名对 APPDATA\\DeskMinis，开发态对 DeskMinis-dev；别的组合都不算', () => {
    const env = { APPDATA: '/u/AppData/Roaming' };
    expect(isHomeDataRoot('/u/AppData/Roaming/DeskMinis', 'DeskMinis', env, false)).toBe(true);
    expect(isHomeDataRoot('/u/AppData/Roaming/DeskMinis-dev', 'DeskMinis-dev', env, false)).toBe(true);
    expect(isHomeDataRoot('/u/AppData/Roaming/deskminis', 'DeskMinis', env, true)).toBe(true);
    expect(isHomeDataRoot('/u/AppData/Roaming/deskminis', 'DeskMinis', env, false)).toBe(false);
    expect(isHomeDataRoot('/u/AppData/Roaming/DeskMinis-dev', 'DeskMinis', env, false)).toBe(false);
    expect(isHomeDataRoot('/tmp/e2e-root', 'DeskMinis', env, false)).toBe(false);
    expect(isHomeDataRoot('/u/AppData/Roaming/DeskMinis', 'DeskMinis-smoke-1', env, false)).toBe(false);
  });
});

describe('接线（源码守卫）', () => {
  const idx = readFileSync(resolve(__dirname, '..', 'src', 'minisd', 'index.ts'), 'utf8');
  it('生产用 SecretFileVault（钥匙放 KeyringVault），测试与 e2e 照旧；启动时搬一次', () => {
    expect(idx).toContain('new SecretFileVault(root, keyring, undefined, isHomeDataRoot(root, keyring.service, process.env))');
    expect(idx).toMatch(/const keyring = process\.env\.DESKMINIS_E2E \|\| process\.env\.DESKMINIS_TEST \? undefined : new KeyringVault/);
    expect(idx).toContain('vault.migrate(known)');
    expect(idx).toContain('...keyring.accounts()');
  });
  it('文件工具读写 secrets.vault 都按凭据拒', () => {
    const gate = readFileSync(resolve(__dirname, '..', 'src', 'minisd', 'tools', 'data-gate.ts'), 'utf8');
    expect(gate).toContain("['secrets.vault', '本机密钥库', true]");
    expect(gate).toMatch(/CREDENTIAL_FILES = new Set\(\[[^\]]*'secrets\.vault'/);
  });
});
