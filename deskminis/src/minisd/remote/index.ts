// remote.* RPC 方法 + additionalVerify 工厂（设计 §1-M3a / §2 / §3.2）。
//
// 权限边界（红线 4c）：
//   - remote.pair.begin / remote.status / remote.unpair：仅 local 模式可调
//   - remote.pair.complete：仅 pairing 模式可调（配对握手期专用，一次性）
//   - 业务面（chat.* / permission.* / skills.* 等）：pairing 模式全拒；remote 模式全开，但每次调用复查对端仍在配对表里（W3-sec4）
//     业务面守卫不在本文件——由 startMinisd 在 methods 注册时统一包装（见 index.ts 接线）
//
// additionalVerify 路由：
//   - ?paseto=<v4.local> → 逐个 PairingKey 尝试 decodePaseto → 成功则 remote 模式
//   - ?pairingCode=<8chars> → PairingService.hasPending 查验 + 时效校验 → 成功则 pairing 模式
//   - 都没有 → {ok:false}
//
// F11C 认证配对（实验，默认关闭；docs/specs/2026-10-03-f11c-authenticated-pairing.md）：
//   - 本机策略 legacy | authenticated（settings 表）。authenticated 下 remote.pair.begin 出 12 位、首位是 0 的码，
//     上面的 ?pairingCode 路由与 remote.pair.complete 一律拒。
//   - 握手不走 RPC：?pair=2 由 RpcServer 直接交给 additionalVerify.pairing（PairingService 的受理器），永不变成一条 RPC 连接。
//   - remote.pair.join 按码的格式在本地分派：完整的 12 位码走认证配对，8 位码走旧路径，其余本地拒绝。
//   - remote.pair.cancel / remote.pair.setPolicy：仅 local。
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { sha256 } from '@noble/hashes/sha2.js';
import type { AdditionalVerify, AdditionalVerifyResult, PairingAcceptor, RpcConnection, RpcMethods } from '../rpc/server';
import { assertAuthMode } from '../rpc/access';
import { PAIRING_CODE_TTL_S, type PairingService } from './pairing';
import { decodePaseto } from './paseto';
import { acceptChannelHello, type ChannelAcceptResult } from './channel';
import {
  PAIR_PEER_LEGACY_DISABLED_TEXT, PairError, classifyPairingCode, pairErrorCodeOf,
  type PairBeginResult, type PairJoinResult, type PairedDeviceView,
} from '../../shared/pairing';
import { SYNC_CAP, peerHasCap, type SyncPeerInfo } from '../sync/wire';

/** PASETO 会话 token 有效期 10 分钟（设计 §2.1）。 */
export const PASETO_TTL_MS = 10 * 60 * 1000;

// 向后兼容：测试 import PAIRING_CODE_TTL_S从此处（实际定义在 pairing.ts）
export { PAIRING_CODE_TTL_S };

/** M3c createRemoteMethods 可选第二参（Task 4 注入 onPairComplete 供 begin 侧地址捕获）。 */
export interface RemoteMethodsOpts {
  /** remote.pair.complete 成功后回调：begin 侧从 conn.remoteAddress + p.listenPort 捕获对端地址（必改 4） */
  onPairComplete?: (peerFingerprint: string, remoteAddress: string | undefined, listenPort: number | undefined) => void;
  /** M3c Task 5：出站客户端 lazy getter（避免循环依赖，remote.status 合并出站源 online）。
   *  Task 6：增 dialNow 供 remote.pair.join 成功后立即拨号（计划 L463）。 */
  getOutbound?: () => { isOnline(fp: string): boolean; dialNow?(peerFp: string): void; disconnect?(peerFp: string): void; peerInfo?(fp: string): SyncPeerInfo | undefined } | undefined;
  /** M3c Task 5：RPC 服务端 lazy getter（remote.status 合并入站源 online，命门 2 出站 ∪ 入站）。 */
  getRpcServer?: () => { isInboundOnline(fp: string): boolean; closeByFingerprint?(fp: string): void; terminateByFingerprint?(fp: string): void; inboundSyncPeer?(fp: string): SyncPeerInfo | undefined } | undefined;
}

/**
 * 创建 remote.* RPC 方法集。
 * @param service PairingService 实例（提供 beginPairing/completePairing/list/get/delete/hasPending）
 * @param opts M3c Task 4 注入 onPairComplete 回调
 */
export function createRemoteMethods(service: PairingService, opts?: RemoteMethodsOpts): RpcMethods {
  // F11C：v2 配对记录落定或被撤回之后的连接处理。
  // 入站用 terminateByFingerprint（直接销毁套接字）而不是 remote.unpair 用的 closeByFingerprint（关闭握手）：
  // 关闭握手要等对端回 close 帧，等的这段时间收到的帧照常分发；业务守卫只按指纹复查，而这里该指纹名下仍有（新的或恢复的）记录，
  // 复查恒真——不回 close 帧的旧密钥持有者还能继续调业务方法。
  service.setPairedListener(e => {
    const fp = e.peerFingerprint;
    const rpcServer = opts?.getRpcServer?.();
    const outbound = opts?.getOutbound?.();
    if (e.kind === 'paired') {
      // 这个指纹名下此刻还连着的，都是这次配对生效之前握的（旧密钥）：记录一换就该断。
      // 不看 e.replaced、一律断：它取自提交那一刻读到的旧值，凭据库那一次读失败时会报成 false，而旧连接是实实在在的。
      // 首次配对时这个指纹名下没有连接，下面两句是空操作。
      const hadOutbound = outbound?.isOnline(fp) === true;
      rpcServer?.terminateByFingerprint?.(fp);
      outbound?.disconnect?.(fp);
      // 断了之后按现在生效的密钥重建出站（dialNow 对「已有未停止的连接」直接返回，所以先断再拨；没有对端地址时它什么都不做）：
      //   - 加入端总是拨（与 v1 一致：加入端单方拨号就能建立同步通道）。
      //   - 发起端在它原本可能有出站循环时也拨（替换了旧记录，或断之前出站在线）。上面的 disconnect 把常驻的重连循环一并摘掉了；
      //     不重拨的话，发起端是主从裁决下的拨号方时，对端一重启两边就都不拨，一直离线到发起端重启（v1 的重新配对不拆这条循环）。
      //     此刻加入端的记录可能还在暂存，第一次握不上，出站循环按退避重试到它生效。
      //   - 首次配对时发起端照旧不拨（与 v1 一致）。
      if (e.role === 'join' || e.replaced || hadOutbound) outbound?.dialNow?.(fp);
      return;
    }
    // rolledBack：加入端在落盘之后失败。broadcast 不复查配对，一条挂着的 remote 连接只要自己不发起调用就一直收得到广播，
    // 所以不等对端下一次调用，当场断开；回滚后旧记录还在（或窗口内有了别的生效记录）就用现在生效的密钥重建
    rpcServer?.terminateByFingerprint?.(fp);
    outbound?.disconnect?.(fp);
    if (service.get(fp)) outbound?.dialNow?.(fp);
  });

  return {
    'remote.pair.begin': async (_p, conn): Promise<PairBeginResult> => {
      assertAuthMode(conn, ['local'], 'remote.pair.begin');
      // F11C：按本机策略出 v1（8 位）或 v2（12 位、首位是 0）的码。策略每次现读，读失败让这次调用抛错、不建任何状态
      if (service.policy() === 'authenticated') {
        const v2 = await service.beginPairingV2();
        return {
          pairingCode: v2.code,
          myPublicKey: new Uint8Array(Buffer.from(v2.ourPubKeyB64, 'base64')),
          myPublicKeyB64: v2.ourPubKeyB64,
          myFingerprint: v2.fingerprint,
          expiresIn: PAIRING_CODE_TTL_S,
          protocol: 2,
          attempts: v2.attempts,
        };
      }
      const r = service.beginPairing();
      // 字段映射：service 返回 code/ourPubKeyB64/fingerprint/expiresAt
      //          RPC 返回 pairingCode/myPublicKey(Uint8Array)/myFingerprint/expiresIn(秒,TTL)
      return {
        pairingCode: r.code,
        myPublicKey: new Uint8Array(Buffer.from(r.ourPubKeyB64, 'base64')),
        myPublicKeyB64: r.ourPubKeyB64,
        myFingerprint: r.fingerprint,
        expiresIn: PAIRING_CODE_TTL_S,
        protocol: 1,
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
      // F11C：这里收到的码是明文走过网络的——先过烧码规则（它若是当前认证配对码的一段，那个码当场作废）
      if (typeof p.pairingCode === 'string') service.noteLegacyAttempt(p.pairingCode);
      // 策略为 authenticated 时旧入口整体关闭（正常情况这条连接连都连不上）
      if (service.policy() === 'authenticated') {
        conn.closeAfterReply?.();
        throw new PairError('PAIR_LEGACY_DISABLED');
      }
      // peerPublicKey 兼容 Uint8Array 与 base64 字符串两种形态（CLI 走 base64，e2e 走 Uint8Array）
      const peerPubKeyB64 = typeof p.peerPublicKey === 'string'
        ? p.peerPublicKey
        : Buffer.from(p.peerPublicKey).toString('base64');
      const r = service.completePairing(p.pairingCode, peerPubKeyB64, p.peerFingerprint, p.peerName);
      // M3c Task 4：begin 侧地址捕获（必改 4）——从 conn.remoteAddress + p.listenPort 组合
      opts?.onPairComplete?.(r.fingerprint, conn.remoteAddress, p.listenPort);
      // 配对码已用掉，这条 pairing 连接回包之后就关（W3-sec4）：之后的往来走 PASETO 的 remote 连接
      conn.closeAfterReply?.();
      return { ok: true, peerFingerprint: r.fingerprint, myPublicKeyB64: r.ourPubKeyB64 };
    },

    'remote.status': async (_p, conn) => {
      assertAuthMode(conn, ['local'], 'remote.status');
      // 红线 4e：remote.status 返回脱敏列表（不含 authKey/sessionSecret）
      // CLI/测试铸 PASETO 改走直接读 vault（deskminis-cli 是本机进程，有 vault 访问权）
      // M3c Task 5：online = 出站存活 ∪ 入站存活（命门 2）；lastSeenAt 来自地址簿
      const outbound = opts?.getOutbound?.();
      const rpcServer = opts?.getRpcServer?.();
      const devices = service.listWithAddress().map((d): PairedDeviceView => ({
        peerFingerprint: d.peerFingerprint,
        peerName: d.peerName,
        roomId: d.roomId,
        createdAt: d.createdAt,
        address: d.address,
        lastSeenAt: d.lastSeenAt ?? 0,
        online: (outbound?.isOnline(d.peerFingerprint) ?? false) || (rpcServer?.isInboundOnline(d.peerFingerprint) ?? false),
        // F11C：这条配对是用哪种协议建立的；v1 记录且对端（出站或入站任一方向）声明了 pairV2 → 重新配对可以升级
        pairingProtocol: d.pairingProtocol === 2 ? 2 : 1,
        canUpgradePairing: d.pairingProtocol !== 2 && (
          peerHasCap(outbound?.peerInfo?.(d.peerFingerprint), SYNC_CAP.PAIR_V2)
          || peerHasCap(rpcServer?.inboundSyncPeer?.(d.peerFingerprint), SYNC_CAP.PAIR_V2)),
      }));
      // F11C：顶层的 pairing 是本机策略与 v2 发起侧状态（不含码本身）
      return { devices, pairing: service.pairingStatus() };
    },

    'remote.unpair': async (p: { peerFingerprint: string }, conn) => {
      assertAuthMode(conn, ['local'], 'remote.unpair');
      service.delete(p.peerFingerprint);
      // 取消配对当场生效（W3-sec4，安全审计第 3 条）：以前只删配对存储，已经连着的入站连接照样能调业务、出站连接照样挂着
      opts?.getRpcServer?.()?.closeByFingerprint?.(p.peerFingerprint);
      opts?.getOutbound?.()?.disconnect?.(p.peerFingerprint);
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

      // F11C：码的格式就是带外的版本信号，在本地分类，网络上不协商。
      //   - 以 0 开头的完整 12 位码：只走认证配对（?pair=2），码不上线路；失败了也不改走下面的明文路径。
      //   - 格式不对（包括没输完的认证配对码）：本地拒绝，不发任何网络请求。
      //   - 8 位旧码：策略为 authenticated 时本地拒绝；否则走下面原有的 v1 路径（用未改写的 p.pairingCode）。
      const kind = classifyPairingCode(p.pairingCode);
      if (kind.kind === 'invalid') throw new PairError('PAIR_BAD_CODE_FORMAT');
      if (kind.kind === 'v2') {
        const v2 = await service.joinPairingV2({ host: p.host, port: p.port, code: kind.code, name: p.peerName, listenPort: p.listenPort });
        const joined: PairJoinResult = { ok: true, peerFingerprint: v2.peerFingerprint, protocol: 2 };
        return joined;
      }
      if (service.policy() === 'authenticated') throw new PairError('PAIR_LEGACY_DISABLED');

      // F11C：v1 不得覆盖已有的 v2 记录（service.joinPairing 里的闸）。那道闸要等对端回了公钥、算出指纹才判得了，
      // 而那时对端已经落盘、配对码已经消费，只会留下对端单侧的一条 v1 记录。所以发请求之前先按地址簿预检：
      // 目标地址名下已有一条 v2 记录就在本地拒绝，不发任何网络请求（配对码也不上线路）。
      // 对端换了地址时这里认不出来，仍由那道闸兜底（规格文档的已知局限）。
      const target = `${p.host}:${p.port}`;
      if (service.listWithAddress().some(d => d.pairingProtocol === 2 && d.address === target)) throw new PairError('PAIR_LEGACY_DISABLED');

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
            if (m.error) {
              peerWs.close();
              const peerMsg = `${m.error.message ?? JSON.stringify(m.error)}`;
              // F11C：对端因为「旧入口已关」或「v1 不得覆盖它那边的 v2 记录」拒绝时，回来的是它的 PairError 原文，
              // 里面的「这台机器」指的是对端。原样带着方法名前缀交给界面，用户会在错的机器上找原因——换成以「对方」为主语的说明。
              // 其它对端错误保持原样。
              reject(new Error(pairErrorCodeOf(peerMsg) === 'PAIR_LEGACY_DISABLED' ? PAIR_PEER_LEGACY_DISABLED_TEXT : `remote.pair.complete: ${peerMsg}`));
              return;
            }
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

      // M3c Task 6（计划 L463）：join 成功后立即拨号，不等下次 start()
      // join 侧单方拨号即可建立同步通道；begin 侧 start() 已在 startMinisd 时跑过（当时无配对，不会重拨）
      opts?.getOutbound?.()?.dialNow?.(recomputedFp);

      return { ok: true, peerFingerprint: recomputedFp, protocol: 1 };
    },

    // F11C：作废本机全部待用的配对码（v1 与 v2）。界面的「取消」以前只清前端状态，引擎里的码仍有效到过期。
    // 只许 local：remote.* 不经业务守卫包装，靠方法体内的检查——漏了的话，一条已配对的远程连接就能作废配对码
    'remote.pair.cancel': async (_p, conn) => {
      assertAuthMode(conn, ['local'], 'remote.pair.cancel');
      return { ok: true, cancelled: service.cancelPairing().cancelled };
    },

    // F11C：切换本机配对策略（落 settings 表），同时清空全部待用的码。只许 local：否则远程连接可以把策略改回 legacy，构成降级
    'remote.pair.setPolicy': async (p: { policy?: unknown }, conn) => {
      assertAuthMode(conn, ['local'], 'remote.pair.setPolicy');
      const policy = p?.policy;
      if (policy !== 'legacy' && policy !== 'authenticated') throw new Error('remote.pair.setPolicy 的 policy 只能是 legacy 或 authenticated');
      service.setPolicy(policy);
      return { ok: true, policy };
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
export function createAdditionalVerify(service: PairingService): AdditionalVerify & { channel: (hello: string) => ChannelAcceptResult; pairing: PairingAcceptor } {
  // jti 重放缓存：jti → 过期时间戳（ms）。60s 窗口内已见拒重放（决策 1 层 1）。老路径与加密通道的 hello 共用一份
  const seenJtis = new Map<string, number>();
  const jtiCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [jti, exp] of seenJtis) { if (exp <= now) seenJtis.delete(jti); }
  }, 60_000);
  jtiCleanupTimer.unref?.();

  const verifyInner = ({ url }: { req: IncomingMessage; url: URL }): AdditionalVerifyResult | Promise<AdditionalVerifyResult> => {
    // 优先判 pairingCode（一次性，pairing 模式只能调 pair.complete）
    const pairingCode = url.searchParams.get('pairingCode');
    if (pairingCode) {
      // F11C：先过烧码规则——这个码是明文出现在升级请求里的，它若是当前认证配对码的一段，那个码当场作废
      service.noteLegacyAttempt(pairingCode);
      // 策略为 authenticated 时旧入口一律拒（包括策略切换前残留的 v1 码）
      if (service.policy() === 'authenticated') return { ok: false };
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
          // 加密通道的 hello 令牌（带临时公钥）只能用来握手，不能拿来走明文的老路径（W3-sec6）
          if (payload.epk !== undefined) return { ok: false };
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
  // F11C：受理路径上任何异常（例如现读策略失败）一律按拒绝处理，不把异常抛进 ws 的升级回调
  const verify = (info: { req: IncomingMessage; url: URL }): AdditionalVerifyResult | Promise<AdditionalVerifyResult> => {
    try { return verifyInner(info); } catch { return { ok: false }; }
  };

  // 加密通道（W3-sec6，安全审计第 2 条）：?ch=1 连进来的第一帧 hello 由这里受理，RpcServer 经 additionalVerify.channel 取用。
  // 挂在 additionalVerify 上而不另开一个工厂：引擎与各测试装 RpcServer 都经 createAdditionalVerify，少一处会忘接的线
  const channel = (hello: string): ChannelAcceptResult => acceptChannelHello(hello, {
    myFingerprint: service.myFingerprint,
    candidates: () => service.list().flatMap(d => {
      const key = service.get(d.peerFingerprint);
      return key ? [{ peerFingerprint: d.peerFingerprint, keys: { authKey: key.authKey, sessionSecret: key.sessionSecret } }] : [];
    }),
    rememberJti: (jti, exp) => {
      if (seenJtis.has(jti)) return false;
      seenJtis.set(jti, exp);
      return true;
    },
  });
  // 认证配对（F11C）：?pair=2 的握手由 PairingService 的受理器处理，RpcServer 经 additionalVerify.pairing 取用（与 channel 同理，少一处会忘接的线）
  return Object.assign(verify, { channel, pairing: service.pairingAcceptor });
}

/**
 * 业务面守卫工厂：包装一个业务面 method，按 authMode 拒绝 pairing 模式。
 * pairing 模式除了 remote.pair.complete 之外什么都不能调——防止配对期连接乱用业务面。
 * remote 模式（已通过 PASETO 鉴权）：给了 isPaired 就每次调用都复查对端指纹还在配对表里（W3-sec4，安全审计第 3 条）——
 * authMode 在建连时定死，取消配对以后旧连接以前照样能调；不在了就拒，回包之后关掉连接。
 * 已配对的设备等同本机：能发消息、批权限卡（现有设计，写在 CHANGELOG 已知边界）。
 */
export function guardBusinessMethod<T extends (params: any, conn: RpcConnection) => unknown>(
  method: T, name: string, isPaired?: (peerFingerprint: string) => boolean,
): T {
  return ((params: any, conn: RpcConnection) => {
    if (conn.authMode === 'pairing') {
      throw new Error(`${name} 在 pairing 模式下不可用（配对期仅可调 remote.pair.complete）`);
    }
    if (conn.authMode === 'remote' && isPaired && !(conn.peerFingerprint !== undefined && isPaired(conn.peerFingerprint))) {
      // 拒绝的回包要送到，送完再关（先关的话回包发不出去，对端只会干等）
      conn.closeAfterReply?.();
      throw new Error(`${name} 被拒：这台设备已取消配对`);
    }
    return method(params, conn);
  }) as T;
}
