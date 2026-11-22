/**
 * 执行隔离第 3 步（二）：密钥改存数据根里的加密文件（secrets.vault），解密用的钥匙留在 Windows 凭据管理器。
 *
 * 为什么：真机验证（2026-11-22）表明低完整性进程照样能读凭据管理器、能解 DPAPI。KeyringVault 把 provider key、
 * 搜索 key、配对私钥直接存在凭据管理器里，沙箱挡不住 shell 读走它们。改成：
 *  - 密文在数据根的 secrets.vault（AES-256-GCM）。沙箱给数据根打了「低完整性进程不许读」的标签，shell 读不到这个文件；
 *  - 钥匙（32 字节随机数）在凭据管理器里，账户名 KEY_ACCOUNT。shell 拿到钥匙没有密文也没用。
 * 同一用户、普通权限的程序两样都拿得到，和以前一样：这一层只挡沙箱，不改原来的威胁模型。
 *
 * 迁移：老版本的密钥逐项在凭据管理器里（同一个服务名、账户名就是键名）。
 *  - get 在文件里找不到就去凭据管理器找，找到了写进文件、确认读得回来，再从凭据管理器删掉；
 *  - 启动时 migrate(keys) 把已知的键（provider、搜索、配对身份与每台配对设备，加上凭据管理器里能列出来的）一次搬完，
 *    不等用到才搬（没搬的那段时间里，沙箱里的命令照样读得到它们）。
 * 只有应用自己的默认数据根（removeLegacy）才删凭据管理器里的老副本：e2e 脚本、开发者另指的数据根和正式根共用同一个
 * 服务名，它们要是也搬了再删，正式根就找不到这些密钥了。别的根只抄一份进自己的文件，老副本留着。
 * 文件坏了或钥匙对不上：原文件改名留底（secrets.vault.broken-<时间>），从空的开始，并告警；凭据管理器里还没搬的照样读得到。
 * 写文件先写 .tmp 再 rename，不会写出半个文件。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultDataRoot, productDirName } from '../paths';
import type { SecretVault } from './provider-store';

export const SECRET_FILE_NAME = 'secrets.vault';
/** 钥匙在凭据管理器里的账户名（与普通键名不会撞：普通键名都带「:」或「.」前缀，见 provider-store / pairing / search）。 */
export const KEY_ACCOUNT = 'secrets-vault-key';
const AAD = Buffer.from('deskminis-secrets-v1', 'utf8');

interface FileShape { v: 1; iv: string; tag: string; data: string }

export class SecretFileVault implements SecretVault {
  readonly file: string;
  private cache: Map<string, string> | undefined;
  private key: Buffer | undefined;

  /** keystore：放钥匙的地方，也是老版本密钥所在（生产是 KeyringVault）。warn：坏文件、迁移失败时告警。
   *  removeLegacy：搬过来之后删不删凭据管理器里的老副本（只有应用自己的默认数据根才删，见 isHomeDataRoot）。 */
  constructor(root: string, private readonly keystore: SecretVault, private readonly warn: (m: string) => void = m => console.warn(m), readonly removeLegacy = true) {
    this.file = join(root, SECRET_FILE_NAME);
  }

  private dropLegacy(k: string): void { if (this.removeLegacy && k !== KEY_ACCOUNT) this.keystore.delete(k); }

  private keyFor(create: boolean): Buffer | undefined {
    if (this.key) return this.key;
    const raw = this.keystore.get(KEY_ACCOUNT);
    if (raw !== undefined) {
      const b = Buffer.from(raw, 'base64');
      if (b.length === 32) { this.key = b; return b; }
      if (!create) return undefined;
      this.warn('密钥文件的钥匙格式不对，换一把新的（旧密钥文件读不出来，已留底）');
    }
    if (!create) return undefined;
    const fresh = randomBytes(32);
    this.keystore.set(KEY_ACCOUNT, fresh.toString('base64'));
    // 写进去之后读回来确认：凭据管理器写失败而不抛的话，下次启动会解不开
    const back = this.keystore.get(KEY_ACCOUNT);
    if (back === undefined || !Buffer.from(back, 'base64').equals(fresh)) throw new Error('凭据管理器写不进密钥文件的钥匙');
    this.key = fresh;
    return fresh;
  }

  private setAside(why: string): void {
    const to = `${this.file}.broken-${Date.now()}`;
    try { renameSync(this.file, to); } catch { /* 留不了底就算了，下面照样从空的开始 */ }
    this.warn(`密钥文件读不出来（${why}），已改名为 ${to}，从空的开始；需要重新填写的 API key 会在设置里显示未配置`);
  }

  /** 读文件解密；读不出来就抛。 */
  private readFile(key: Buffer): Map<string, string> {
    const f = JSON.parse(readFileSync(this.file, 'utf8')) as FileShape;
    if (f?.v !== 1) throw new Error('版本不认得');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
    d.setAAD(AAD);
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8');
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(JSON.parse(plain) as Record<string, unknown>)) if (typeof v === 'string') map.set(k, v);
    return map;
  }

  private load(): Map<string, string> {
    if (this.cache) return this.cache;
    let map = new Map<string, string>();
    if (existsSync(this.file)) {
      try {
        const key = this.keyFor(false);
        if (!key) throw new Error('凭据管理器里没有钥匙');
        map = this.readFile(key);
      } catch (e) {
        this.key = undefined;
        this.setAside(e instanceof Error ? e.message : String(e));
      }
    }
    this.cache = map;
    return map;
  }

  private flush(map: Map<string, string>): void {
    const key = this.keyFor(true)!;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(AAD);
    const data = Buffer.concat([c.update(JSON.stringify(Object.fromEntries(map)), 'utf8'), c.final()]);
    const out: FileShape = { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), 'utf8');
    renameSync(tmp, this.file);
    // 读回来核对一遍：之后才会去删凭据管理器里的老副本
    const back = this.readFile(key);
    if (back.size !== map.size || [...map].some(([k, v]) => back.get(k) !== v)) throw new Error('密钥文件写进去读回来不一致');
  }

  set(k: string, v: string): void {
    const map = new Map(this.load());
    map.set(k, v);
    this.flush(map);
    this.cache = map;
    this.dropLegacy(k); // 老版本可能还留着一份
  }

  get(k: string): string | undefined {
    const hit = this.load().get(k);
    if (hit !== undefined) return hit;
    if (k === KEY_ACCOUNT) return undefined;
    const legacy = this.keystore.get(k);
    if (legacy === undefined) return undefined;
    try { this.set(k, legacy); } catch (e) { this.warn(`把 ${k} 搬进密钥文件失败，这次照旧从凭据管理器读：${e instanceof Error ? e.message : String(e)}`); }
    return legacy;
  }

  delete(k: string): void {
    const map = this.load();
    if (map.has(k)) {
      const next = new Map(map);
      next.delete(k);
      this.flush(next);
      this.cache = next;
    }
    this.dropLegacy(k);
  }

  /** 启动时把这些键从凭据管理器搬进文件（已在文件里的只把凭据管理器里的残留删掉）。返回搬了几项。从不抛。 */
  migrate(keys: Iterable<string>): number {
    let moved = 0;
    for (const k of new Set(keys)) {
      if (k === KEY_ACCOUNT) continue;
      try {
        if (this.load().has(k)) { this.dropLegacy(k); continue; }
        const legacy = this.keystore.get(k);
        if (legacy === undefined) continue;
        this.set(k, legacy);
        moved++;
      } catch (e) {
        this.warn(`把 ${k} 搬进密钥文件失败，下次启动再试：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return moved;
  }
}

/** 这个数据根是不是应用自己的默认数据根（正式版服务名对正式版的根、开发态服务名对开发态的根）。不分大小写比较。 */
export function isHomeDataRoot(root: string, service: string, env: Readonly<Record<string, string | undefined>>, win = process.platform === 'win32'): boolean {
  const variant = service === productDirName('prod') ? 'prod' : service === productDirName('dev') ? 'dev' : undefined;
  if (variant === undefined) return false;
  const a = resolve(root); const b = resolve(defaultDataRoot(env, variant));
  return win ? a.toLowerCase() === b.toLowerCase() : a === b;
}
