// remote.* RPC 方法 + additionalVerify 工厂（设计 §1-M3a / §2 / §3.2）。
//
// 权限边界（红线 4c）：
//   - remote.pair.begin / remote.status / remote.unpair：仅 local 模式可调
//   - remote.pair.complete：仅 pairing 模式可调（配对握手期专用，一次性）
//   - 业务面（chat.* / permission.* / skills.* 等）：pairing 模式全拒；remote 模式全开
//     业务面守卫不在本文件——由 startMinisd 在 methods 注册时统一包装（见 index.ts 接线）
//
// additionalVerify 路由：
//   - ?paseto=<v4.local> → 逐个 PairingKey 尝试 decodePaseto → 成功则 remote 模式
//   - ?pairingCode=<8chars> → PairingService.hasPending 查验 + 时效校验 → 成功则 pairing 模式
//   - 都没有 → {ok:false}
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { sha256 } from '@noble/hashes/sha2.js';
import type { AdditionalVerify, AdditionalVerifyResult, AuthMode, RpcConnection, RpcMethods } from '../rpc/server';
import { PAIRING_CODE_TTL_S, type PairingService } from './pairing';
import { decodePaseto } from './paseto';

/** PASETO 会话 token 有效期 10 分钟（设计 §2.1）。 */
export const PASETO_TTL_MS = 10 * 60 * 1000;

// 向后兼容：测试 import PAIRING_CODE_TTL_S从此处（实际定义在 pairing.ts）
export { PAIRING_CODE_TTL_S };

/** 校验 authMode 是否在允许列表里；不在则抛错。 */
function assertAuthMode(conn: RpcConnection, allowed: AuthMode[], what: string): void {
  if (!allowed.includes(conn.authMode)) {
    throw new Error(`${what} 需要 authMode=${allowed.join('/')}，当前=${conn.authMode}`);
  }
}

/** M3c createRemoteMethods 可选第二参（Task 4 注入 onPairComplete 供 begin 侧地址捕获）。 */
export interface RemoteMethodsOpts {
  /** remote.pair.complete 成功后回调：begin 侧从 conn.remoteAddress + p.listenPort 捕获对端地址（必改 4） */
  onPairComplete?: (peerFingerprint: string, remoteAddress: string | undefined, listenPort: number | undefined) => void;
  /** M3c Task 5：出站客户端 lazy getter（避免循环依赖，remote.status 合并出站源 online）。 */
  getOutbound?: () => { isOnline(fp: string): boolean } | undefined;
  /** M3c Task 5：RPC 服务端 lazy getter（remote.status 合并入站源 online，命门 2 出站 ∪ 入站）。 */
  getRpcServer?: () => { isInboundOnline(fp: string): boolean } | undefined;
}

/**
 * 创建 remote.* RPC 方法集。
 * @param service PairingService 实例（提供 beginPairing/completePairing/list/get/delete/hasPending）
 * @param opts M3c Task 4 注入 onPairComplete 回调
 */
export function createRemoteMethods(service: PairingService, opts?: RemoteMethodsOpts): RpcMethods {
  return {
    'remote.pair.begin': async (_p, conn) => {
      assertAuthMode(conn, ['local'], 'remote.pair.begin');
      const r = service.beginPairing();
      // 字段映射：service 返回 code/ourPubKeyB64/fingerprint/expiresAt
      //          RPC 返回 pairingCode/myPublicKey(Uint8Array)/myFingerprint/expiresIn(秒,TTL)
      return {
        pairingCode: r.code,
        myPublicKey: new Uint8Array(Buffer.from(r.ourPubKeyB64, 'base64')),
        myPublicKeyB64: r.ourPubKeyB64,
        myFingerprint: r.fingerprint,
        expiresIn: PAIRING_CODE_TTL_S,
      };
    },

    'remote.pair.complete': async (p: {
      pairingCode: string;
      peerPublicKey: Uint8Array | string;
      peerFingerprint: string;
      peerName?: string;
      listenPort?: number;
    }, conn) => {
      assertAuthMode(conn, ['pairing'], 'remote.pair.complete');
      // peerPublicKey 兼容 Uint8Array 与 base64 字符串两种形态（CLI 走 base64，e2e 走 Uint8Array）
      const peerPubKeyB64 = typeof p.peerPublicKey === 'string'
        ? p.peerPublicKey
        : Buffer.from(p.peerPublicKey).toString('base64');
      const r = service.completePairing(p.pairingCode, peerPubKeyB64, p.peerFingerprint, p.peerName);
      // M3c Task 4：begin 侧地址捕获（必改 4）——从 conn.remoteAddress + p.listenPort 组合
      opts?.onPairComplete?.(r.fingerprint, conn.remoteAddress, p.listenPort);
      return { ok: true, peerFingerprint: r.fingerprint, myPublicKeyB64: r.ourPubKeyB64 };
    },

    'remote.status': async (_p, conn) => {
      assertAuthMode(conn, ['local'], 'remote.status');
      // 红线 4e：remote.status 返回脱敏列表（不含 authKey/sessionSecret）
      // CLI/测试铸 PASETO 改走直接读 vault（deskminis-cli 是本机进程，有 vault 访问权）
      // M3c Task 5：online = 出站存活 ∪ 入站存活（命门 2）；lastSeenAt 来自地址簿
      const outbound = opts?.getOutbound?.();
      const rpcServer = opts?.getRpcServer?.();
      const devices = service.listWithAddress().map(d => ({
        peerFingerprint: d.peerFingerprint,
        peerName: d.peerName,
        roomId: d.roomId,
        createdAt: d.createdAt,
        address: d.address,
        lastSeenAt: d.lastSeenAt ?? 0,
        online: (outbound?.isOnline(d.peerFingerprint) ?? false) || (rpcServer?.isInboundOnline(d.peerFingerprint) ?? false),
      }));
      return { devices };
    },

    'remote.unpair': async (p: { peerFingerprint: string }, conn) => {
      assertAuthMode(conn, ['local'], 'remote.unpair');
      service.delete(p.peerFingerprint);
      return { ok: true };
    },

    // M3c Task 4：remote.pair.join——免手抄公钥（决策 3），authMode=local
    // join 侧（本端）调此方法，内部连对端 pairing 模式调 complete，拿到对端公钥后本地重算指纹 + 派生 PairingKey
    'remote.pair.join': async (p: {
      host: string;
      port: number;
      pairingCode: string;
      peerName?: string;
      listenPort?: number;
    }, conn) => {
      assertAuthMode(conn, ['local'], 'remote.pair.join');
      if (!p.host || !p.port) throw new Error('remote.pair.join 需要 host 和 port');
      if (!p.pairingCode) throw new Error('remote.pair.join 需要 pairingCode');

      // 连对端（pairing 模式，用 pairingCode 鉴权）
      const joinUrl = `ws://${p.host}:${p.port}/?pairingCode=${encodeURIComponent(p.pairingCode)}`;
      const peerWs = new WebSocket(joinUrl);

      const resp = await new Promise<{ ok: boolean; peerFingerprint: string; myPublicKeyB64: string }>((resolve, reject) => {
        const timer = setTimeout(() => { peerWs.terminate(); reject(new Error('remote.pair.join 连接超时')); }, 10_000);
        timer.unref?.();
        let settled = false;
        const fail = (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); };
        let idc = 0;
        const pending = new Map<number, (m: any) => void>();
        peerWs.on('message', data => {
          const msg = JSON.parse(String(data));
          if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
        });
        peerWs.on('open', () => {
          const id = ++idc;
          pending.set(id, m => {
            if (settled) return; settled = true; clearTimeout(timer);
            if (m.error) { peerWs.close(); reject(new Error(`remote.pair.complete: ${m.error.message ?? JSON.stringify(m.error)}`)); return; }
            resolve(m.result as any);
          });
          peerWs.send(JSON.stringify({
            jsonrpc: '2.0', id, method: 'remote.pair.complete',
            params: {
              pairingCode: p.pairingCode,
              peerPublicKey: Buffer.from(service.myPublicKey).toString('base64'),
              peerFingerprint: service.myFingerprint,
              peerName: p.peerName,
              listenPort: p.listenPort,
            },
          }));
        });
        // 配对码错误/过期 → 对端 pairing 鉴权 401 拒绝：转友好信息（计划契约：测试期望 /配对码|code|失效|过期/i）
        peerWs.on('unexpected-response', (_req, res) => {
          fail(new Error(res.statusCode === 401 ? '配对码无效或已过期' : `remote.pair.join 连接被拒: ${res.statusCode}`));
        });
        peerWs.on('error', e => { fail(e instanceof Error ? e : new Error(String(e))); });
      });

      try { peerWs.close(); } catch { /* */ }

      // 本地重算对端指纹（防伪报，决策 3）：sha256(pubKey).slice(0,6) hex
      const peerPubKey = new Uint8Array(Buffer.from(resp.myPublicKeyB64, 'base64'));
      const recomputedFp = Buffer.from(sha256(peerPubKey).slice(0, 6)).toString('hex');

      // 派生 PairingKey + 持久化 + 记地址簿
      service.joinPairing(
        resp.myPublicKeyB64,
        recomputedFp,
        p.peerName ?? '未命名设备',
        p.pairingCode,
        `${p.host}:${p.port}`,
      );

      return { ok: true, peerFingerprint: recomputedFp };
    },
  };
}

/** M3c 出站 PASETO 短 TTL（60s，决策 1 层 1）——与会话 TTL 10min 并列，互不影响。 */
export const OUTBOUND_PASETO_TTL_MS = 60 * 1000;

/**
 * 创建 additionalVerify 回调（供 RpcServer 构造函数第三参使用）。
 * 路由：?pairingCode → pairing；?paseto → remote；否则拒。
 *
 * M3c 出站路径增补（决策 1 层 1）：
 *   - PASETO payload 含 jti（出站路径标识）→ 校验 aud === myFingerprint + jti 重放缓存
 *   - 无 jti（会话路径，M3a 兼容）→ 不查缓存，原样通过（红线 4b 双路径兼容）
 *   - 命中 key 时返回 peerFingerprint（命门 2，供 sync.hello 找 authKey + presence）
 *
 * @param service PairingService 实例（提供 hasPending/list/get/myFingerprint）
 */
export function createAdditionalVerify(service: PairingService): AdditionalVerify {
  // jti 重放缓存：jti → 过期时间戳（ms）。60s 窗口内已见拒重放（决策 1 层 1）。
  const seenJtis = new Map<string, number>();
  const jtiCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [jti, exp] of seenJtis) { if (exp <= now) seenJtis.delete(jti); }
  }, 60_000);
  jtiCleanupTimer.unref?.();

  return ({ url }: { req: IncomingMessage; url: URL }): AdditionalVerifyResult | Promise<AdditionalVerifyResult> => {
    // 优先判 pairingCode（一次性，pairing 模式只能调 pair.complete）
    const pairingCode = url.searchParams.get('pairingCode');
    if (pairingCode) {
      if (service.hasPending(pairingCode)) return { ok: true, authMode: 'pairing' };
      return { ok: false };
    }
    // paseto：逐个 PairingKey 尝试解（远程 token 是对称加密，需要正确的 auth_key）
    const paseto = url.searchParams.get('paseto');
    if (paseto) {
      const devices = service.list();
      for (const dev of devices) {
        const key = service.get(dev.peerFingerprint);
        if (!key) continue;
        try {
          const payload = decodePaseto(paseto, key.authKey);
          // M3c 出站路径：payload.jti 存在 → 校验 aud + jti 重放
          if (payload.jti !== undefined) {
            // aud 校验：防投递到错对端
            if (payload.aud !== service.myFingerprint) return { ok: false };
            // jti 重放检查：60s 窗口内已见 → 拒
            if (seenJtis.has(payload.jti)) return { ok: false };
            seenJtis.set(payload.jti, Date.now() + OUTBOUND_PASETO_TTL_MS);
          }
          // 会话路径（无 jti）不查缓存（红线 4b 兼容双路径）
          return { ok: true, authMode: 'remote', peerFingerprint: dev.peerFingerprint };
        } catch {
          // 此 PairingKey 不匹配，继续试下一个
        }
      }
      return { ok: false };
    }
    return { ok: false };
  };
}

/**
 * 业务面守卫工厂：包装一个业务面 method，按 authMode 拒绝 pairing 模式。
 * pairing 模式除了 remote.pair.complete 之外什么都不能调——防止配对期连接乱用业务面。
 * remote 模式全开（已通过 PASETO 鉴权，是合法远程客户端）。
 */
export function guardBusinessMethod<T extends (params: any, conn: RpcConnection) => unknown>(
  method: T, name: string,
): T {
  return ((params: any, conn: RpcConnection) => {
    if (conn.authMode === 'pairing') {
      throw new Error(`${name} 在 pairing 模式下不可用（配对期仅可调 remote.pair.complete）`);
    }
    return method(params, conn);
  }) as T;
}
