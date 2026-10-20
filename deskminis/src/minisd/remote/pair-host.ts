/**
 * 认证配对（F11C）的发起端 H：显示配对码的一端。管 v2 码的生命周期，受理 ?pair=2 上的握手。
 *
 * H 是 SPAKE2 的 B（用 N）。握手三段（帧格式见 pair-proto.ts）：
 *   J→H hello（pA）   H→J reply（pB 与 cB 同帧）   J→H confirm（cA）   H→J done / fail
 * RFC 9382 §3.1 的四条消息图是示例流程；规范性要求是双方都发确认、各自验过对端的确认之前不得认为协议完成，
 * 没有规定两条确认的先后。所以 cB 可以随 pB 同帧，前提有两条，都落在本文件：
 *   1. 发出带 cB 的 reply 时就把这次握手计为一次尝试——这一帧让对端可以验证它嵌在 pA 里的那一个猜测。
 *      次数扣在任何用到 w 的计算之前；对端收到 reply 后发不发 confirm、发的 cA 对不对，这一次都已经算数。
 *   2. 验过 cA 之前不落盘、不授予任何权限。
 * 这段是对 RFC 原文的阅读结论，没有经过独立的密码学审查（规格文档的未审查清单）。
 *
 * 状态机全部同步：一帧进来，同步算完、同步落盘、同步给出回帧，中间没有让出事件循环的地方。
 * 同一时刻只有一个 v2 码、一条握手在途；每个码最多 PAIR_MAX_ATTEMPTS 次握手。
 * 码结束的唯一出口是 dropPending：消费、取消、次数耗尽、烧码、过期、被新的码顶掉都走它。
 *
 * 秘密材料（码、w、临时标量、K、Ke、确认值、配对密钥）不进日志、错误串、事件；Uint8Array 形态的用完清零。
 * 本文件对 pairing.ts 只 import type；落盘函数、本机静态公钥、时钟由 PairingService 经构造参数传入。
 */
import { timingSafeEqual } from 'node:crypto';
import {
  PAIRING_CODE_LEN_V1, PAIRING_CODE_LEN_V2, PairError, normalizePairingCode,
  type PairErrorCode, type PairStatus,
} from '../../shared/pairing';
import type { PairingAcceptor, PairingSession, PairingStep } from '../rpc/server';
import type { PairedNotice, PairingCommit, PairingEvent, PairingKey } from './pairing';
import {
  PAIR_DONE_FRAME, PAIR_FAIL_FRAME, PAIR_MAX_ATTEMPTS,
  derivePairingMaterial, derivePasswordScalar, encodePairReply, fingerprintOfPublicKey,
  pairContextHash, pairIdentity, parsePairConfirm, parsePairHello,
} from './pair-proto';
import { spake2Finish, spake2Password, spake2Share, type Spake2Password } from './spake2';

export interface PairingHostDeps {
  /** 本机 X25519 静态公钥（32 字节）。 */
  myPublicKey: Uint8Array;
  /** 毫秒时钟。 */
  now: () => number;
  /** v2 码的有效期（毫秒）。 */
  codeTtlMs: number;
  /** 生成一个 12 位的 v2 码。 */
  generateCode: () => string;
  /** 即时生效的落盘（PairingStore.commit）。失败抛 PairError('PAIR_COMMIT_FAILED')，内部已恢复原状。 */
  commit: (key: PairingKey, address?: string) => PairingCommit;
  emit: (e: PairingEvent) => void;
  notify: (e: PairedNotice) => void;
}

interface Pending {
  /** 留在内存里只为烧码规则做比较；与 pw 一样只活到这个码结束。 */
  code: string;
  pw: Spake2Password;
  expiresAt: number;
  attemptsLeft: number;
  inFlight: boolean;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}

const FAIL: PairingStep = Object.freeze({ reply: PAIR_FAIL_FRAME, end: true });

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export class PairingHost {
  private pending: Pending | undefined;
  /** 每次码的安装、结束、取消都加一：在途握手与正在算 scrypt 的 begin 靠它发现「已经不是原来那个码」。 */
  private generation = 0;
  private lastOutcome: PairStatus['lastHostOutcome'];

  constructor(private deps: PairingHostDeps) {}

  /** 码结束的唯一出口。传了 outcome 就记结局并发一条 failed 事件；
   *  例外是 PAIR_CANCELLED：只记结局，事件由 PairingService.cancelPairing 自己发 cancelled，免得一次取消记两行审计。
   *  在途的握手不用单独通知：它的下一帧会在「同一个 generation」的检查上失败。 */
  private dropPending(outcome?: PairErrorCode): void {
    const p = this.pending;
    if (p) clearTimeout(p.timer);
    this.pending = undefined;
    this.generation++;
    if (outcome) {
      this.lastOutcome = { at: this.deps.now(), kind: 'failed', code: outcome };
      if (outcome !== 'PAIR_CANCELLED') this.deps.emit({ kind: 'failed', protocol: 2, role: 'host', code: outcome });
    }
  }

  /** 码还在且没过期；发现已过期就当场清掉。 */
  private live(): Pending | undefined {
    const p = this.pending;
    if (!p) return undefined;
    if (this.deps.now() >= p.expiresAt) { this.dropPending('PAIR_EXPIRED'); return undefined; }
    return p;
  }

  /** 生成并安装一个新的 v2 码。已有的码作废（不记结局）。 */
  async begin(): Promise<{ code: string; expiresAt: number; attempts: number }> {
    if (this.pending) this.dropPending();
    const gen = ++this.generation;
    this.lastOutcome = undefined;
    let code: string;
    let w: bigint;
    for (;;) {
      code = this.deps.generateCode();
      // scrypt 约 0.2 秒，让出事件循环；w = 0（概率可忽略）时换一个码重来
      try { w = await derivePasswordScalar(code); break; } catch (e) {
        if (e instanceof PairError && e.code === 'PAIR_BAD_CODE_FORMAT') continue;
        throw e;
      }
    }
    // 等待期间又有 begin、cancel 或策略切换：不安装任何状态
    if (this.generation !== gen) throw new PairError('PAIR_CANCELLED');
    const ttlMs = this.deps.codeTtlMs;
    const expiresAt = this.deps.now() + ttlMs;
    // 到期定时器按真实时间走：没有人连进来也会到点清掉，过期的码与 w 不留在内存里
    const timer = setTimeout(() => {
      if (this.pending?.generation === gen) this.dropPending('PAIR_EXPIRED');
    }, ttlMs);
    timer.unref?.();
    this.pending = { code, pw: spake2Password(w), expiresAt, attemptsLeft: PAIR_MAX_ATTEMPTS, inFlight: false, generation: gen, timer };
    this.deps.emit({ kind: 'begin', protocol: 2 });
    return { code, expiresAt, attempts: PAIR_MAX_ATTEMPTS };
  }

  /** 取消：generation 无条件加一（让正在算 scrypt 的 begin 也失败）；有码则作废。返回有没有码被作废。 */
  cancel(): boolean {
    this.generation++;
    if (!this.pending) return false;
    this.dropPending('PAIR_CANCELLED');
    return true;
  }

  /** 当前 v2 码的状态（不含码本身）与最近一次结局。先做过期检查：不报告一个已过期的码。 */
  status(): Pick<PairStatus, 'host' | 'lastHostOutcome'> {
    const p = this.live();
    return {
      ...(p ? { host: { protocol: 2 as const, expiresAt: p.expiresAt, attemptsLeft: p.attemptsLeft, inFlight: p.inFlight } } : {}),
      ...(this.lastOutcome ? { lastHostOutcome: this.lastOutcome } : {}),
    };
  }

  /** 烧码规则：v1 的明文入口上出现了当前 v2 码或它的一段，这个码就算泄露了，当场作废（在途握手随之失败）。
   *  比两段：从第 1 位起（不支持认证配对的版本把输入截成 8 位：标记位加前 7 个随机字符）；
   *  以及从第 2 位起（新版的加入端只有一种情况会走到这里：用户漏掉了开头的标记，又恰好只输了 8 位）。
   *  不相干的来码不作废：随机探测打不掉码，响应也永远是 401，不构成判定器。 */
  noteLegacyAttempt(presented: string): void {
    const p = this.pending;
    if (!p || typeof presented !== 'string') return;
    const c = normalizePairingCode(presented);
    if (c.length < PAIRING_CODE_LEN_V1 || c.length > PAIRING_CODE_LEN_V2) return;
    const got = Buffer.from(c, 'utf8');
    const hitHead = timingSafeEqual(got, Buffer.from(p.code.slice(0, c.length), 'utf8'));
    const hitTail = c.length <= PAIRING_CODE_LEN_V2 - 1
      && timingSafeEqual(got, Buffer.from(p.code.slice(1, 1 + c.length), 'utf8'));
    if (hitHead || hitTail) this.dropPending('PAIR_CODE_EXPOSED');
  }

  /** RpcServer 的 ?pair=2 入口用。ws 的升级是同步完成的，admit 到 open 之间没有空隙：
   *  同一时刻恰好一条握手在途，握手期间连入的其它请求全部在升级阶段得到 401，不扣次数。 */
  readonly acceptor: PairingAcceptor = {
    admit: (): boolean => {
      try {
        const p = this.live();
        return p !== undefined && p.attemptsLeft > 0 && !p.inFlight;
      } catch { return false; }
    },
    open: (info: { remoteAddress?: string }): PairingSession | undefined => {
      const p = this.live();
      if (!p || p.attemptsLeft <= 0 || p.inFlight) return undefined;
      p.inFlight = true;
      return this.openSession(p.generation, info.remoteAddress);
    },
  };

  private openSession(gen: number, remoteAddress: string | undefined): PairingSession {
    let state: 'await_hello' | 'await_confirm' | 'ended' = 'await_hello';
    /** 这次会话扣过次数：扣过的失败才进审计，没扣次数的垃圾连接不进（否则审计表可以被无限刷）。 */
    let charged = false;
    let expectCA: Uint8Array | undefined;
    let Ke: Uint8Array | undefined;
    let ctxH: Uint8Array | undefined;
    let peer: { id: Uint8Array; name: string; listenPort: number } | undefined;

    const wipe = (): void => {
      expectCA?.fill(0); Ke?.fill(0);
      expectCA = undefined; Ke = undefined; ctxH = undefined; peer = undefined;
    };
    /** 这个码还是握手开始时的那一个（没被取消、顶掉、消费、切策略）而且没过期。 */
    const mine = (): Pending | undefined => {
      const p = this.live();
      return p && p.generation === gen ? p : undefined;
    };
    /** 失败出口。失败帧永远是同一串字节，不区分原因。 */
    const fail = (): PairingStep => {
      state = 'ended';
      wipe();
      if (charged) this.deps.emit({ kind: 'failed', protocol: 2, role: 'host', code: 'PAIR_CONFIRM_FAILED' });
      const p = this.pending;
      if (p && p.generation === gen) {
        p.inFlight = false;
        if (p.attemptsLeft <= 0) this.dropPending('PAIR_ATTEMPTS_EXHAUSTED');
      }
      return FAIL;
    };

    const onHello = (text: string): PairingStep => {
      let m;
      try { m = parsePairHello(text); } catch { return fail(); }       // 帧不合规：不扣次数，还没用 w 算过任何东西
      if (sameBytes(m.id, this.deps.myPublicKey)) return fail();        // 对端身份就是本机（反射或自配）：不扣次数
      const p = mine();
      // 次数在这里再查一遍，不只依赖 admit / open 的互斥：哪天在途互斥被改掉，次数上限仍然成立
      if (!p || p.attemptsLeft <= 0) return fail();
      p.attemptsLeft -= 1;
      charged = true;
      let out;
      let share: Uint8Array;
      const aad = pairContextHash({ name: m.name, listenPort: m.listenPort });
      try {
        const own = spake2Share('B', p.pw);
        share = own.share;
        out = spake2Finish({
          role: 'B', pw: p.pw, scalar: own.scalar, pA: m.pA, pB: own.share,
          idA: pairIdentity('joiner', m.id), idB: pairIdentity('host', this.deps.myPublicKey), aad,
        });
      } catch { return fail(); }                                        // 点不合法、差为无穷远点：次数已扣
      expectCA = out.cA;
      Ke = out.Ke;
      ctxH = aad;
      peer = { id: m.id, name: m.name, listenPort: m.listenPort };
      out.K.fill(0); out.TT.fill(0); out.Ka.fill(0); out.KcA.fill(0); out.KcB.fill(0);
      state = 'await_confirm';
      return { reply: encodePairReply({ id: this.deps.myPublicKey, pB: share, cB: out.cB }) };
    };

    const onConfirm = (text: string): PairingStep => {
      let m;
      try { m = parsePairConfirm(text); } catch { return fail(); }
      // 被取消、被新的码顶掉、策略切换、握手中途过期：不落盘
      if (!mine() || !expectCA || !Ke || !ctxH || !peer) return fail();
      if (!sameBytes(m.cA, expectCA)) return fail();
      // 先消费配对码：之后无论落盘成败，这个码都不能再用
      this.dropPending();
      const material = derivePairingMaterial(Ke, ctxH);
      const now = this.deps.now();
      const key: PairingKey = {
        ...material,
        peerFingerprint: fingerprintOfPublicKey(peer.id),
        peerName: peer.name || '未命名设备',
        createdAt: Math.floor(now / 1000),
        pairingProtocol: 2,
      };
      // 对端监听地址：IPv6 地址现有的 host:port 格式表达不了，不记
      const host = remoteAddress?.replace(/^::ffff:/, '');
      const address = peer.listenPort > 0 && host && !host.includes(':') ? `${host}:${peer.listenPort}` : undefined;
      let commit: PairingCommit;
      try {
        commit = this.deps.commit(key, address);
      } catch {
        state = 'ended';
        wipe();
        key.authKey.fill(0); key.sessionSecret.fill(0);
        this.lastOutcome = { at: now, kind: 'failed', code: 'PAIR_COMMIT_FAILED' };
        this.deps.emit({ kind: 'failed', protocol: 2, role: 'host', code: 'PAIR_COMMIT_FAILED' });
        return FAIL;
      }
      // H 的写入即时生效。替换了旧记录时监听者当场断开用旧密钥握的连接
      const fp = key.peerFingerprint;
      this.deps.notify({ kind: 'paired', role: 'host', peerFingerprint: fp, replaced: commit.replaced });
      this.lastOutcome = { at: now, kind: 'paired', peerFingerprint: fp, replaced: commit.replaced };
      this.deps.emit({ kind: 'paired', protocol: 2, role: 'host', peerFingerprint: fp, replaced: commit.replaced });
      state = 'ended';
      wipe();
      key.authKey.fill(0); key.sessionSecret.fill(0);
      return { reply: PAIR_DONE_FRAME, end: true };
    };

    return {
      onFrame: (text: string): PairingStep => {
        if (state === 'await_hello') return onHello(text);
        if (state === 'await_confirm') return onConfirm(text);
        return { end: true }; // 已结束：不会二次落盘
      },
      onClose: (): void => { if (state !== 'ended') fail(); },
    };
  }
}
