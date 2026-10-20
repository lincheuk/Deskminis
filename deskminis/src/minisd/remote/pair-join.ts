/**
 * 认证配对（F11C）的加入端 J：输入配对码的一端。J 是 SPAKE2 的 A（用 M）。帧格式见 pair-proto.ts。
 *
 * 配对码只进本机的 scrypt，绝不上线路：连接的 URL 字面量里只有 ?pair=2，帧里只有份额、静态公钥、名字、端口和确认值。
 * 这里没有「失败就改走旧的明文配对」的路径，也不自动重试——每次重试都是给假冒的发起端一次猜测机会。
 *
 * 顺序与落盘点：
 *   1. 收 reply，验 cB（常数时间比较）。不过：什么都不写，也不发 confirm。
 *   2. 验过 cB 后先本机落盘（暂存），再发 confirm。落盘失败就不发 confirm，两边都没有记录。
 *      暂存的意思是密钥已经写进 vault，但本进程里读到的仍是提交前的状态：新密钥握不了加密通道，也不算已配对。
 *      一个知道码的对端因此没法在这段窗口里先连上来、再让握手失败而把连接留下。
 *   3. 收到 done 才让记录生效。收到别的、超时、断开：回滚刚写的记录，并通知上层关掉这个指纹名下的连接。
 * 收尾帧不带认证：伪造 done 或丢掉 done 能造成的只是单侧悬空记录（拒绝服务），不承载任何授权决定。
 *
 * 本文件对 pairing.ts 只 import type；落盘函数、本机静态公钥、时钟由 PairingService 经构造参数传入。
 * 秘密材料不进日志、错误串、事件；Uint8Array 形态的用完清零（bigint 标量清不了）。
 */
import { timingSafeEqual } from 'node:crypto';
import { WebSocket } from 'ws';
import { PairError, type PairErrorCode } from '../../shared/pairing';
import type { PairedNotice, PairingCommit, PairingEvent, PairingKey } from './pairing';
import {
  PAIR_MAX_FRAME_BYTES,
  derivePairingMaterial, derivePasswordScalar, encodePairConfirm, encodePairHello, fingerprintOfPublicKey,
  isValidPairName, pairContextHash, pairIdentity, parsePairEnd, parsePairReply,
} from './pair-proto';
import { spake2Finish, spake2Password, spake2Share, type Spake2Output } from './spake2';

export interface PairingJoinerDeps {
  /** 本机 X25519 静态公钥（32 字节）。 */
  myPublicKey: Uint8Array;
  /** 毫秒时钟。 */
  now: () => number;
  /** 每一步的时限（毫秒）。 */
  stepMs: number;
  /** 暂存的落盘（PairingStore.commit 带 staged）。失败抛 PairError('PAIR_COMMIT_FAILED')，内部已恢复原状。 */
  commit: (key: PairingKey, address: string) => PairingCommit;
  emit: (e: PairingEvent) => void;
  notify: (e: PairedNotice) => void;
}

type Incoming = { kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'closed' } | { kind: 'timeout' };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export class PairingJoiner {
  private busy = false;

  constructor(private deps: PairingJoinerDeps) {}

  /** 用 12 位的 v2 码（已归一化）加入对端的配对。失败抛 PairError；成功返回对端指纹与是否替换了旧记录。 */
  async join(p: { host: string; port: number; code: string; name?: string; listenPort?: number }): Promise<{ peerFingerprint: string; replaced: boolean }> {
    // 先做本地检查，再做耗时的事。名字进 ctxH、两端存下来的也是它，不做静默截断
    const name = p.name ?? '';
    if (!isValidPairName(name)) throw new PairError('PAIR_BAD_NAME');
    const lp = p.listenPort;
    const listenPort = typeof lp === 'number' && Number.isInteger(lp) && lp >= 0 && lp <= 65535 ? lp : 0;
    // 同一时刻只允许一个加入
    if (this.busy) throw new PairError('PAIR_BUSY');
    this.busy = true;

    let ws: WebSocket | undefined;
    let out: Spake2Output | undefined;
    let key: PairingKey | undefined;
    try {
      const pw = spake2Password(await derivePasswordScalar(p.code));
      const mine = spake2Share('A', pw);
      const ctxH = pairContextHash({ name, listenPort });

      const sock = new WebSocket(`ws://${p.host}:${p.port}/?pair=2`, { handshakeTimeout: this.deps.stepMs, maxPayload: 8192 });
      ws = sock;
      const read = frameReader(sock);
      await opened(sock, this.deps.stepMs);

      sock.send(encodePairHello({ id: this.deps.myPublicKey, name, listenPort, pA: mine.share }));
      const first = await read(this.deps.stepMs);
      if (first.kind === 'timeout') throw new PairError('PAIR_TIMEOUT');
      if (first.kind === 'closed') throw new PairError('PAIR_PEER_REJECTED');
      if (first.kind === 'binary' || Buffer.byteLength(first.text, 'utf8') > PAIR_MAX_FRAME_BYTES) throw new PairError('PAIR_PROTOCOL');
      if (parsePairEnd(first.text) === 'fail') throw new PairError('PAIR_PEER_REJECTED');
      const m = parsePairReply(first.text);                                  // 不合规抛 PAIR_PROTOCOL
      if (sameBytes(m.id, this.deps.myPublicKey)) throw new PairError('PAIR_SELF');
      if (sameBytes(m.pB, mine.share)) throw new PairError('PAIR_PROTOCOL');   // 把自己的份额弹了回来
      try {
        out = spake2Finish({
          role: 'A', pw, scalar: mine.scalar, pA: mine.share, pB: m.pB,
          idA: pairIdentity('joiner', this.deps.myPublicKey), idB: pairIdentity('host', m.id), aad: ctxH,
        });
      } catch { throw new PairError('PAIR_PROTOCOL'); }
      // 码不对，或连接被篡改：不写任何东西，不发 confirm
      if (!sameBytes(m.cB, out.cB)) throw new PairError('PAIR_CONFIRM_FAILED');

      // ---- 从这里到发出 confirm 是同一段同步代码，中间不得让出事件循环 ----
      const peerFingerprint = fingerprintOfPublicKey(m.id);
      key = {
        ...derivePairingMaterial(out.Ke, ctxH),
        peerFingerprint,
        peerName: p.name ?? '未命名设备',
        createdAt: Math.floor(this.deps.now() / 1000),
        pairingProtocol: 2,
      };
      // 抛 PAIR_COMMIT_FAILED 时本机什么都没留下；对端按未完成的握手处理，不会落盘
      const commit = this.deps.commit(key, `${p.host}:${p.port}`);
      let failure: PairErrorCode = 'PAIR_PEER_REJECTED';
      let done = false;
      try {
        sock.send(encodePairConfirm({ cA: out.cA }));
        const last = await read(this.deps.stepMs);
        if (last.kind === 'timeout') failure = 'PAIR_TIMEOUT';
        else if (last.kind === 'text' && parsePairEnd(last.text) === 'done') {
          // 等 done 的这段时间里本机对这个指纹做了解绑或另一次配对：这次提交已被取代，不生效
          if (commit.activate()) done = true; else failure = 'PAIR_CANCELLED';
        }
      } catch { /* 发送失败：按对端拒绝处理，下面回滚 */ }
      if (done) {
        this.deps.notify({ kind: 'paired', role: 'join', peerFingerprint, replaced: commit.replaced });
        this.deps.emit({ kind: 'paired', protocol: 2, role: 'join', peerFingerprint, replaced: commit.replaced });
        return { peerFingerprint, replaced: commit.replaced };
      }
      // 落盘之后失败：撤回刚写的记录，并让上层当场关掉这个指纹名下的入站与出站连接（不论回滚干净与否）
      const r = commit.rollback();
      this.deps.notify({ kind: 'rolledBack', peerFingerprint });
      throw new PairError(r.clean ? failure : 'PAIR_ROLLBACK_INCOMPLETE');
    } catch (e) {
      const err = e instanceof PairError ? e : new PairError('PAIR_UNREACHABLE');
      this.deps.emit({ kind: 'failed', protocol: 2, role: 'join', code: err.code });
      throw err;
    } finally {
      try { ws?.terminate(); } catch { /* 已关闭 */ }
      if (out) { out.K.fill(0); out.TT.fill(0); out.Ke.fill(0); out.Ka.fill(0); out.KcA.fill(0); out.KcB.fill(0); out.cA.fill(0); out.cB.fill(0); }
      if (key) { key.authKey.fill(0); key.sessionSecret.fill(0); }
      this.busy = false;
    }
  }
}

/** 等连接建立。401 → PAIR_NO_PENDING（对方没有待用的码、码已作废、正忙，或版本不支持）；
 *  其它状态码与连接错误 → PAIR_UNREACHABLE；到时限 → PAIR_TIMEOUT。 */
function opened(ws: WebSocket, stepMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err?: PairError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => settle(new PairError('PAIR_TIMEOUT')), stepMs);
    timer.unref?.();
    ws.once('open', () => settle());
    ws.once('unexpected-response', (_req, res) => {
      settle(new PairError(res.statusCode === 401 ? 'PAIR_NO_PENDING' : 'PAIR_UNREACHABLE'));
    });
    ws.once('error', () => settle(new PairError('PAIR_UNREACHABLE')));
    ws.once('close', () => settle(new PairError('PAIR_UNREACHABLE')));
  });
}

/** 逐帧读：帧按到达顺序排队，read(ms) 取下一帧或等到时限。连接关闭、出错都当作 closed。 */
function frameReader(ws: WebSocket): (ms: number) => Promise<Incoming> {
  const queue: Incoming[] = [];
  let waiter: ((m: Incoming) => void) | undefined;
  const push = (m: Incoming): void => {
    if (waiter) { const w = waiter; waiter = undefined; w(m); } else queue.push(m);
  };
  ws.on('message', (raw, isBinary) => {
    if (isBinary) { push({ kind: 'binary' }); return; }
    const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    push({ kind: 'text', text: buf.toString('utf8') });
  });
  ws.on('close', () => push({ kind: 'closed' }));
  // 没有 error 监听器的话，ws 的协议层错误会变成未捕获异常
  ws.on('error', () => push({ kind: 'closed' }));
  return (ms: number): Promise<Incoming> => new Promise(resolve => {
    const queued = queue.shift();
    if (queued) { resolve(queued); return; }
    const timer = setTimeout(() => { waiter = undefined; resolve({ kind: 'timeout' }); }, ms);
    timer.unref?.();
    waiter = m => { clearTimeout(timer); resolve(m); };
  });
}
