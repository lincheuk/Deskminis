/** F11C：PairingStore.commit——事务式写入、暂存与生效、比较后再回滚、进程内吊销。
 *
 *  要守住的性质：
 *   - 三个写入点（地址簿、索引、vault）任一处失败，三处都回到提交前的样子；
 *   - 暂存的提交在 activate() 之前不生效（get / list 仍是提交前的视图）；
 *   - 回滚只在 vault 里仍是本次写入时才动它：窗口内的解绑、别的写入不会被回滚覆盖；
 *   - 回滚不干净时该指纹在本进程里被吊销，被吊销的原文不会在下一次失败的握手里复活。 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingStore, type PairingKey } from '../src/minisd/remote/pairing';
import { PairError } from '../src/shared/pairing';
import { FaultVault } from './pair-v2-util';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function setup(): { dir: string; vault: FaultVault; store: PairingStore } {
  const dir = mkdtempSync(join(tmpdir(), 'dm-commit-'));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
  const vault = new FaultVault();
  return { dir, vault, store: new PairingStore(dir, vault) };
}
const FP = 'a1b2c3d4e5f6';
const VK = `pairing.${FP}`;
function keyOf(fill: number, extra: Partial<PairingKey> = {}): PairingKey {
  return {
    authKey: new Uint8Array(32).fill(fill), sessionSecret: new Uint8Array(32).fill(fill + 1),
    roomId: 'ROOMROOM', peerFingerprint: FP, peerName: `dev-${fill}`, createdAt: 1_700_000_000 + fill, pairingProtocol: 2, ...extra,
  };
}
const text = (dir: string, name: string): string => existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '';
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof PairError ? e.code : `非 PairError: ${String(e)}`; }
  return undefined;
};
const authOf = (store: PairingStore): number | undefined => store.get(FP)?.authKey[0];

describe('commit：成功路径与 proto 的读写', () => {
  it('即时生效：vault、索引、地址簿三处都写了；get / list 读到 pairingProtocol 2；replaced=false', () => {
    const { dir, vault, store } = setup();
    const c = store.commit(keyOf(7), '10.0.0.2:7820');
    expect(c.peerFingerprint).toBe(FP);
    expect(c.replaced).toBe(false);
    expect(c.activate()).toBe(true);
    expect(JSON.parse(vault.inner.get(VK)!)).toMatchObject({ proto: 2, peerName: 'dev-7', roomId: 'ROOMROOM' });
    expect(JSON.parse(text(dir, 'pairing-index.json'))).toEqual([FP]);
    expect(store.getAddress(FP)).toBe('10.0.0.2:7820');
    expect(store.get(FP)).toMatchObject({ peerFingerprint: FP, peerName: 'dev-7', pairingProtocol: 2 });
    expect(store.list()).toEqual([{ peerFingerprint: FP, peerName: 'dev-7', roomId: 'ROOMROOM', createdAt: 1_700_000_007, pairingProtocol: 2 }]);
  });
  it('save() 写的旧形记录没有 proto，读成 pairingProtocol 1；commit 覆盖它时 replaced=true', () => {
    const { vault, store } = setup();
    store.save(keyOf(3, { pairingProtocol: undefined }));
    expect(JSON.parse(vault.inner.get(VK)!)).not.toHaveProperty('proto');
    expect(store.get(FP)?.pairingProtocol).toBe(1);
    expect(store.list()[0].pairingProtocol).toBe(1);
    const c = store.commit(keyOf(9));
    expect(c.replaced).toBe(true);
    expect(store.get(FP)?.pairingProtocol).toBe(2);
    expect(authOf(store)).toBe(9);
  });
  it('不传地址不写地址簿；已在索引里不重复加', () => {
    const { dir, store } = setup();
    store.save(keyOf(3));
    store.commit(keyOf(4));
    expect(JSON.parse(text(dir, 'pairing-index.json'))).toEqual([FP]);
    expect(text(dir, 'peer-addresses.json')).toBe('');
  });
  it('list() 的 JSON 里没有 authKey、sessionSecret（脱敏视图）', () => {
    const { store } = setup();
    store.commit(keyOf(5), '10.0.0.2:1');
    const json = JSON.stringify(store.list()) + JSON.stringify(store.listWithAddress());
    expect(json).not.toContain('authKey');
    expect(json).not.toContain('sessionSecret');
    expect(json).not.toContain(Buffer.from(new Uint8Array(32).fill(5)).toString('base64'));
  });
});

describe('commit：三个故障点各自恢复原状（新指纹）', () => {
  it('vault.set 抛错 → PAIR_COMMIT_FAILED；索引与地址簿里都没有它；底层错误不向上带', () => {
    const { dir, vault, store } = setup();
    vault.fault = (op, k) => op === 'set' && k === VK ? 'throw' : undefined;
    let err: unknown;
    try { store.commit(keyOf(1), '10.0.0.2:1'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PairError);
    expect((err as PairError).code).toBe('PAIR_COMMIT_FAILED');
    expect((err as Error).message).not.toContain('FaultVault');
    expect(vault.inner.get(VK)).toBeUndefined();
    expect(text(dir, 'pairing-index.json')).not.toContain(FP);
    expect(text(dir, 'peer-addresses.json')).not.toContain(FP);
    expect(store.get(FP)).toBeUndefined();
  });
  it('索引写失败 → PAIR_COMMIT_FAILED；vault 没被写（没有 isPaired 为真的孤儿密钥），地址簿恢复', () => {
    const { dir, vault, store } = setup();
    mkdirSync(join(dir, 'pairing-index.json.tmp')); // writeFileSync 写到目录上，真实抛错
    expect(codeOf(() => store.commit(keyOf(1), '10.0.0.2:1'))).toBe('PAIR_COMMIT_FAILED');
    expect(vault.log.filter(e => e.key === VK)).toEqual([]);
    expect(vault.inner.get(VK)).toBeUndefined();
    expect(text(dir, 'peer-addresses.json')).not.toContain(FP);
  });
  it('地址簿写失败 → PAIR_COMMIT_FAILED；索引与 vault 都没动', () => {
    const { dir, vault, store } = setup();
    mkdirSync(join(dir, 'peer-addresses.json.tmp'));
    expect(codeOf(() => store.commit(keyOf(1), '10.0.0.2:1'))).toBe('PAIR_COMMIT_FAILED');
    expect(vault.log.filter(e => e.key === VK)).toEqual([]);
    expect(text(dir, 'pairing-index.json')).not.toContain(FP);
  });
  it('已有旧记录时 vault.set 抛错：旧记录的 vault 原文、旧地址原样不动', () => {
    const { vault, store } = setup();
    store.save(keyOf(3));
    store.setAddress(FP, '10.0.0.9:9');
    const before = vault.inner.get(VK);
    vault.fault = (op, k) => op === 'set' && k === VK ? 'throw' : undefined;
    expect(codeOf(() => store.commit(keyOf(8), '10.0.0.2:1'))).toBe('PAIR_COMMIT_FAILED');
    expect(vault.inner.get(VK)).toBe(before);
    expect(store.getAddress(FP)).toBe('10.0.0.9:9');
    expect(authOf(store)).toBe(3);
  });
});

describe('暂存与生效', () => {
  it('新指纹：activate() 之前 get / list 读不到（密钥已在 vault 里），之后读到', () => {
    const { vault, store } = setup();
    const c = store.commit(keyOf(6), '10.0.0.2:1', { staged: true });
    expect(vault.inner.get(VK)).toBeDefined();
    expect(store.get(FP)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(c.replaced).toBe(false);
    expect(c.activate()).toBe(true);
    expect(authOf(store)).toBe(6);
    expect(store.list()).toHaveLength(1);
    expect(c.activate()).toBe(true); // 重复调用无害
  });
  it('已有记录：activate() 之前读到的是旧值，之后是新值', () => {
    const { store } = setup();
    store.save(keyOf(3));
    const c = store.commit(keyOf(6), undefined, { staged: true });
    expect(c.replaced).toBe(true);
    expect(authOf(store)).toBe(3);
    expect(store.list()[0].peerName).toBe('dev-3');
    expect(c.activate()).toBe(true);
    expect(authOf(store)).toBe(6);
  });
  it('已 activate() 的提交再 rollback() 是空操作', () => {
    const { vault, store } = setup();
    const c = store.commit(keyOf(6), undefined, { staged: true });
    c.activate();
    const raw = vault.inner.get(VK);
    expect(c.rollback()).toEqual({ clean: true });
    expect(vault.inner.get(VK)).toBe(raw);
    expect(authOf(store)).toBe(6);
  });
  it('即时生效的提交：rollback() 是空操作', () => {
    const { store } = setup();
    const c = store.commit(keyOf(6));
    expect(c.rollback()).toEqual({ clean: true });
    expect(authOf(store)).toBe(6);
  });
  it('被 save() 取代：activate() 返回 false，rollback() 不碰别人写的值', () => {
    const { vault, store } = setup();
    const c = store.commit(keyOf(6), undefined, { staged: true });
    store.save(keyOf(4, { pairingProtocol: undefined }));
    expect(authOf(store)).toBe(4);
    expect(c.activate()).toBe(false);
    const raw = vault.inner.get(VK);
    expect(c.rollback()).toEqual({ clean: true });
    expect(vault.inner.get(VK)).toBe(raw);
    expect(authOf(store)).toBe(4);
  });
  it('被 delete() 取代：activate() 返回 false，记录没有生效', () => {
    const { vault, store } = setup();
    store.save(keyOf(3));
    const c = store.commit(keyOf(6), undefined, { staged: true });
    store.delete(FP);
    expect(c.activate()).toBe(false);
    expect(store.get(FP)).toBeUndefined();
    expect(vault.inner.get(VK)).toBeUndefined();
  });
  it('被另一次即时生效的 commit 取代：activate() 返回 false，回滚不动新记录', () => {
    const { store } = setup();
    const staged = store.commit(keyOf(6), undefined, { staged: true });
    store.commit(keyOf(5));
    expect(authOf(store)).toBe(5);
    expect(staged.activate()).toBe(false);
    expect(staged.rollback()).toEqual({ clean: true });
    expect(authOf(store)).toBe(5);
  });
});

describe('rollback：按 vault 里的当前值分四种情况', () => {
  it('仍是本次写入、提交前有旧值：旧原文逐字节写回，旧地址恢复', () => {
    const { vault, store } = setup();
    store.save(keyOf(3));
    store.setAddress(FP, '10.0.0.9:9');
    const before = vault.inner.get(VK);
    const c = store.commit(keyOf(6), '10.0.0.2:1', { staged: true });
    expect(store.getAddress(FP)).toBe('10.0.0.2:1');
    expect(c.rollback()).toEqual({ clean: true });
    expect(vault.inner.get(VK)).toBe(before);
    expect(store.getAddress(FP)).toBe('10.0.0.9:9');
    expect(authOf(store)).toBe(3);
    expect(c.activate()).toBe(false);
    expect(c.rollback()).toEqual({ clean: true }); // 重复调用无害
    expect(vault.inner.get(VK)).toBe(before);
  });
  it('仍是本次写入、提交前没有记录：删掉，索引与地址簿里都没有它', () => {
    const { dir, vault, store } = setup();
    const c = store.commit(keyOf(6), '10.0.0.2:1', { staged: true });
    expect(c.rollback()).toEqual({ clean: true });
    expect(vault.inner.get(VK)).toBeUndefined();
    expect(text(dir, 'pairing-index.json')).not.toContain(FP);
    expect(text(dir, 'peer-addresses.json')).not.toContain(FP);
    expect(store.get(FP)).toBeUndefined();
  });
  it('窗口内 delete(fp)：回滚后 vault 里没有该指纹，旧密钥没有复活', () => {
    const { dir, vault, store } = setup();
    store.save(keyOf(3));
    store.setAddress(FP, '10.0.0.9:9');
    const c = store.commit(keyOf(6), '10.0.0.2:1', { staged: true });
    store.delete(FP);
    expect(c.rollback()).toEqual({ clean: true });
    expect(vault.inner.get(VK)).toBeUndefined();
    expect(store.get(FP)).toBeUndefined();
    expect(text(dir, 'pairing-index.json')).not.toContain(FP);
    expect(text(dir, 'peer-addresses.json')).not.toContain(FP);
    // 没有任何一次写入把旧密钥写回去
    const oldAuth = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
    const setsAfterCommit = vault.log.slice(vault.log.findIndex(e => e.value?.includes(Buffer.from(new Uint8Array(32).fill(6)).toString('base64'))) + 1);
    expect(setsAfterCommit.filter(e => e.op === 'set' && e.value?.includes(oldAuth))).toEqual([]);
  });
  it('窗口内 save() 了别的记录：回滚不动它（vault、索引、地址簿）', () => {
    const { dir, vault, store } = setup();
    const c = store.commit(keyOf(6), '10.0.0.2:1', { staged: true });
    store.save(keyOf(4, { pairingProtocol: undefined }));
    store.setAddress(FP, '10.0.0.4:4');
    const raw = vault.inner.get(VK);
    expect(c.rollback()).toEqual({ clean: true });
    expect(vault.inner.get(VK)).toBe(raw);
    expect(JSON.parse(text(dir, 'pairing-index.json'))).toEqual([FP]);
    expect(store.getAddress(FP)).toBe('10.0.0.4:4');
    expect(authOf(store)).toBe(4);
  });
});

describe('吊销', () => {
  it('回滚时 vault.delete 不生效 → clean=false；get / list 过滤掉它；索引留着（重启后可解绑）', () => {
    const { dir, vault, store } = setup();
    const c = store.commit(keyOf(6), '10.0.0.2:1', { staged: true });
    vault.fault = (op, k) => op === 'delete' && k === VK ? 'ignore' : undefined;
    expect(c.rollback()).toEqual({ clean: false });
    expect(vault.inner.get(VK)).toBeDefined();        // 确实还在
    expect(store.get(FP)).toBeUndefined();            // 本进程里当它不存在
    expect(store.list()).toEqual([]);
    expect(text(dir, 'pairing-index.json')).toContain(FP);
  });
  it('吊销后再提交、再失败一次：仍然过滤，仍是 clean=false；第一次的残留没有被写回并解除吊销', () => {
    const { vault, store } = setup();
    vault.fault = (op, k) => op === 'delete' && k === VK ? 'ignore' : undefined;
    const first = store.commit(keyOf(6), undefined, { staged: true });
    expect(first.rollback()).toEqual({ clean: false });
    const second = store.commit(keyOf(7), undefined, { staged: true });
    expect(second.replaced).toBe(false);              // 被吊销的原文不算旧值
    expect(store.get(FP)).toBeUndefined();
    expect(second.rollback()).toEqual({ clean: false });
    expect(store.get(FP)).toBeUndefined();
    expect(store.list()).toEqual([]);
    // 回滚没有把第一次的原文写回 vault
    const firstAuth = Buffer.from(new Uint8Array(32).fill(6)).toString('base64');
    expect(vault.log.filter(e => e.op === 'set' && e.value?.includes(firstAuth))).toHaveLength(1);
  });
  it('回滚里把旧值写回去时 vault.set 抛错 → clean=false，该指纹被吊销（旧记录也读不到）', () => {
    const { vault, store } = setup();
    store.save(keyOf(3));
    const c = store.commit(keyOf(6), undefined, { staged: true });
    vault.fault = (op, k) => op === 'set' && k === VK ? 'throw' : undefined;
    expect(c.rollback()).toEqual({ clean: false });
    expect(store.get(FP)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
  it('activate() 成功解除吊销', () => {
    const { vault, store } = setup();
    vault.fault = (op, k) => op === 'delete' && k === VK ? 'ignore' : undefined;
    store.commit(keyOf(6), undefined, { staged: true }).rollback();
    expect(store.get(FP)).toBeUndefined();
    const c = store.commit(keyOf(8), undefined, { staged: true });
    expect(store.get(FP)).toBeUndefined();
    expect(c.activate()).toBe(true);
    expect(authOf(store)).toBe(8);
  });
  it('即时生效的 commit 成功、save() 成功都解除吊销；delete() 不解除', () => {
    const { vault, store } = setup();
    vault.fault = (op, k) => op === 'delete' && k === VK ? 'ignore' : undefined;
    store.commit(keyOf(6), undefined, { staged: true }).rollback();
    store.delete(FP);                                  // 删除被吞掉：条目还在，吊销必须留着
    expect(vault.inner.get(VK)).toBeDefined();
    expect(store.get(FP)).toBeUndefined();
    store.save(keyOf(4, { pairingProtocol: undefined }));
    expect(authOf(store)).toBe(4);                     // 吊销之后做的 v1 配对看得见

    const b = setup();
    b.vault.fault = (op, k) => op === 'delete' && k === VK ? 'ignore' : undefined;
    b.store.commit(keyOf(6), undefined, { staged: true }).rollback();
    b.store.commit(keyOf(5));
    expect(authOf(b.store)).toBe(5);
  });
  // 变异核对补的：去掉「读不到当前值」那一支里的吊销，原有用例全绿——它们的 vault.delete 都是生效的。
  // 真实的凭据库不可用时读与删是一起失灵的（KeyringVault 的 get、delete 都吞错）：回滚读到「不存在」，删除又没删掉。
  it('回滚那一刻凭据库读、删都被吞掉：失败握手写进去的密钥还留在 vault 里，凭据库恢复之后本进程里也读不到它', () => {
    const outage = (s: { vault: FaultVault }): { restore(): void } => {
      let down = true;
      s.vault.fault = (op, k) => down && k === VK && (op === 'get' || op === 'delete') ? 'ignore' : undefined;
      return { restore: () => { down = false; } };
    };
    const failedAuth = Buffer.from(new Uint8Array(32).fill(6)).toString('base64');

    // 新指纹
    const a = setup();
    const c1 = a.store.commit(keyOf(6), '10.0.0.2:1', { staged: true });
    const o1 = outage(a);
    c1.rollback();
    o1.restore();
    expect(a.vault.inner.get(VK), '条目确实没删掉').toContain(failedAuth);
    expect(a.store.get(FP)).toBeUndefined();
    expect(a.store.list()).toEqual([]);

    // 已有旧记录：索引里本来就有这个指纹，回滚不会把它摘出去——不吊销的话 list() 也会把失败握手的密钥交出去
    const b = setup();
    b.store.save(keyOf(3));
    const c2 = b.store.commit(keyOf(6), undefined, { staged: true });
    const o2 = outage(b);
    c2.rollback();
    o2.restore();
    expect(b.vault.inner.get(VK), '留下的是失败握手写的那一份').toContain(failedAuth);
    expect(b.store.get(FP)).toBeUndefined();
    expect(b.store.list()).toEqual([]);
    // 吊销照常由下一条生效的记录解除
    b.store.commit(keyOf(5));
    expect(authOf(b.store)).toBe(5);
  });
});

describe('已声明的局限（规格文档 §局限）：凭据库读失败被吞掉时', () => {
  it('提交那一刻读旧值失败：旧记录被覆盖；这次握手再失败，回滚后该指纹没有记录（往「没有配对」的方向错，不留权限）', () => {
    const { vault, store } = setup();
    store.save(keyOf(3));
    let failGet = true;
    vault.fault = (op, k) => op === 'get' && k === VK && failGet ? 'ignore' : undefined;
    const c = store.commit(keyOf(6), undefined, { staged: true });
    failGet = false;
    expect(c.replaced).toBe(false);
    expect(c.rollback()).toEqual({ clean: true });
    expect(store.get(FP)).toBeUndefined();
    expect(vault.inner.get(VK)).toBeUndefined();
  });
  it('回滚开头读当前值失败：按「窗口内被解绑」处理——删除，不恢复旧记录', () => {
    const { vault, store } = setup();
    store.save(keyOf(3));
    const c = store.commit(keyOf(6), undefined, { staged: true });
    let n = 0;
    vault.fault = (op, k) => op === 'get' && k === VK && n++ === 0 ? 'ignore' : undefined;
    expect(c.rollback()).toEqual({ clean: true });
    expect(vault.inner.get(VK)).toBeUndefined();
    expect(store.get(FP)).toBeUndefined();
  });
});
