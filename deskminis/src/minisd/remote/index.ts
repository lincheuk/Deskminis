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

/**
 * 创建 remote.* RPC 方法集。
 * @param service PairingService 实例（提供 beginPairing/completePairing/list/get/delete/hasPending）
 */
export function createRemoteMethods(service: PairingService): RpcMethods {
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
    }, conn) => {
      assertAuthMode(conn, ['pairing'], 'remote.pair.complete');
      // peerPublicKey 兼容 Uint8Array 与 base64 字符串两种形态（CLI 走 base64，e2e 走 Uint8Array）
      const peerPubKeyB64 = typeof p.peerPublicKey === 'string'
        ? p.peerPublicKey
        : Buffer.from(p.peerPublicKey).toString('base64');
      const r = service.completePairing(p.pairingCode, peerPubKeyB64, p.peerFingerprint, p.peerName);
      return { ok: true, peerFingerprint: r.fingerprint };
    },

    'remote.status': async (_p, conn) => {
      assertAuthMode(conn, ['local'], 'remote.status');
      // 红线 4e：remote.status 返回脱敏列表（不含 authKey/sessionSecret）
      // CLI/测试铸 PASETO 改走直接读 vault（deskminis-cli 是本机进程，有 vault 访问权）
      return { devices: service.list() };
    },

    'remote.unpair': async (p: { peerFingerprint: string }, conn) => {
      assertAuthMode(conn, ['local'], 'remote.unpair');
      service.delete(p.peerFingerprint);
      return { ok: true };
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
