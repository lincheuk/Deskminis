/**
 * 设备之间远程连接的加密通道（W3-sec6，安全审计第 2 条）。
 *
 * 以前：出站连接 ws://<对端>/?paseto=<令牌>，令牌在 URL 里明文走网络；PASETO 只管建连那一下的鉴权，之后的 JSON-RPC 帧
 * （聊天事件、权限请求全文、同步的消息）全是明文，同一网络里的人在链路上直接读得到。
 *
 * 现在（v1）：
 *   1. 客户端连 ?ch=1（URL 里不带任何秘密），第一帧发 hello：{t:'dm.ch.hello', v:1, token}。
 *      token 是 PASETO v4.local（用配对密钥 authKey 加密并认证），payload 带 exp（60 秒）、jti（防重放）、aud（对端指纹）、
 *      device_fingerprint（自己）、epk（这次连接的临时 X25519 公钥）。网络上看不到是谁连谁，也改不动 epk。
 *   2. 服务端逐个配对密钥试解 token，校验 aud、jti 没见过、epk 是合法公钥；自己也生成临时密钥对，回 accept：
 *      {t:'dm.ch.accept', v:1, epk, mac}，mac = HMAC-SHA256(authKey, 'accept' || 握手记录)，证明自己真有这把配对密钥。
 *   3. 两端：shared = X25519(自己的临时私钥, 对端的临时公钥)；
 *      okm = HKDF-SHA256(ikm=shared, salt=sessionSecret, info='DeskMinis/Channel/v1/keys' || 握手记录, 64 字节)，
 *      前 32 字节是客户端→服务端的密钥，后 32 字节是反方向的。sessionSecret 是配对时派生、只有两端有的那 32 字节。
 *      握手记录 th = SHA-256('DeskMinis/Channel/v1' || len(token) || token || 服务端临时公钥)。
 *   4. 之后每一帧：XChaCha20-Poly1305(方向密钥, nonce, AAD='DMCH1') 加密的 UTF-8 JSON，以二进制帧发送。
 *      nonce = [方向字节][15 个零][8 字节大端计数]，计数每帧加一、不随帧发送：重放、乱序、丢帧、篡改都解不开，调用方当场断开。
 *
 * 性质：临时 ECDH 带来前向保密（配对密钥日后泄露，解不开之前录下的流量）；双向认证（客户端靠 PASETO，服务端靠 mac，
 * 而且没有 sessionSecret 算不出帧密钥）；两个方向两把钥匙。
 * 不覆盖的：配对本身（交换公钥那一步）仍是明文、靠配对码，同一网络里的主动攻击者看得到配对码就能在配对时插一脚——
 * 配对请在可信网络里做（CHANGELOG 已知边界）。
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { decodePaseto, encodePaseto, type PasetoPayload } from './paseto';

/** URL 里标明「走加密通道」的查询参数。 */
export const CHANNEL_QUERY = 'ch';
export const CHANNEL_VERSION = 1;
/** hello 令牌的有效期：只管握手那一下，60 秒足够。 */
export const CHANNEL_HELLO_TTL_MS = 60_000;

const TE = new TextEncoder();
const LABEL = TE.encode('DeskMinis/Channel/v1');
const KEYS_INFO = TE.encode('DeskMinis/Channel/v1/keys');
const ACCEPT_LABEL = TE.encode('accept');
const FRAME_AAD = TE.encode('DMCH1');
const DIR_C2S = 1;
const DIR_S2C = 2;

/** 握手之后两端各一个：seal 加密要发的一帧，open 解开收到的一帧；解不开（篡改、重放、乱序、丢帧、别的连接的帧）一律抛错。 */
export interface FrameCipher {
  seal(text: string): Uint8Array;
  open(frame: Uint8Array): string;
}

/** 一对设备之间的配对密钥里通道要用的两样。 */
export interface ChannelKeys {
  authKey: Uint8Array;
  sessionSecret: Uint8Array;
}

export type ChannelAcceptResult =
  | { ok: true; peerFingerprint: string; reply: string; cipher: FrameCipher }
  | { ok: false };

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const unb64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'));

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function transcript(token: string, serverEpk: Uint8Array): Uint8Array {
  const t = TE.encode(token);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, t.length);
  return sha256(concat(LABEL, len, t, serverEpk));
}

function nonceOf(dir: number, counter: bigint): Uint8Array {
  const n = new Uint8Array(24);
  n[0] = dir;
  new DataView(n.buffer).setBigUint64(16, counter);
  return n;
}

/** 由握手结果建两个方向的帧加解密。sendDir 是自己发出去的方向。 */
function makeCipher(okm: Uint8Array, sendDir: number): FrameCipher {
  const kC2S = okm.slice(0, 32);
  const kS2C = okm.slice(32, 64);
  const sendKey = sendDir === DIR_C2S ? kC2S : kS2C;
  const recvKey = sendDir === DIR_C2S ? kS2C : kC2S;
  const recvDir = sendDir === DIR_C2S ? DIR_S2C : DIR_C2S;
  let sendCount = 0n;
  let recvCount = 0n;
  return {
    seal(text) {
      const sealed = xchacha20poly1305(sendKey, nonceOf(sendDir, sendCount), FRAME_AAD).encrypt(TE.encode(text));
      sendCount++;
      return sealed;
    },
    open(frame) {
      // 解不开就抛（noble 的 invalid tag）；计数只在解开之后才前进，调用方收到异常就该断开，不会再拿同一个计数试下一帧
      const plain = xchacha20poly1305(recvKey, nonceOf(recvDir, recvCount), FRAME_AAD).decrypt(frame);
      recvCount++;
      return Buffer.from(plain).toString('utf8');
    },
  };
}

function deriveKeys(myEphemeralPriv: Uint8Array, peerEpk: Uint8Array, keys: ChannelKeys, th: Uint8Array): Uint8Array {
  // 对端给低阶点时 noble 直接抛（invalid private or public key），调用方按握手失败处理
  const shared = x25519.getSharedSecret(myEphemeralPriv, peerEpk);
  return hkdf(sha256, shared, keys.sessionSecret, concat(KEYS_INFO, th), 64);
}

function acceptMac(authKey: Uint8Array, th: Uint8Array): Uint8Array {
  return hmac(sha256, authKey, concat(ACCEPT_LABEL, th));
}

/** 客户端（拨号方）：生成 hello；收到 accept 后 finish 校验并得出帧加解密，校验不过抛错。 */
export function beginClientHandshake(
  keys: ChannelKeys, myFingerprint: string, peerFingerprint: string, opts: { now?: number } = {},
): { hello: string; finish(reply: string): FrameCipher } {
  const now = opts.now ?? Date.now();
  const eph = x25519.keygen();
  const payload: PasetoPayload = {
    exp: now + CHANNEL_HELLO_TTL_MS, iat: now, device_fingerprint: myFingerprint,
    jti: randomUUID(), aud: peerFingerprint, epk: b64u(eph.publicKey),
  };
  const token = encodePaseto(payload, keys.authKey);
  return {
    hello: JSON.stringify({ t: 'dm.ch.hello', v: CHANNEL_VERSION, token }),
    finish(reply: string): FrameCipher {
      const r = JSON.parse(reply) as { t?: unknown; v?: unknown; epk?: unknown; mac?: unknown };
      if (r.t !== 'dm.ch.accept' || r.v !== CHANNEL_VERSION || typeof r.epk !== 'string' || typeof r.mac !== 'string') {
        throw new Error('加密通道握手失败：对端的应答格式不对');
      }
      const serverEpk = unb64u(r.epk);
      if (serverEpk.length !== 32) throw new Error('加密通道握手失败：对端临时公钥长度不对');
      const th = transcript(token, serverEpk);
      const expected = acceptMac(keys.authKey, th);
      const got = unb64u(r.mac);
      if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
        throw new Error('加密通道握手失败：对端没能证明持有配对密钥');
      }
      return makeCipher(deriveKeys(eph.secretKey, serverEpk, keys, th), DIR_C2S);
    },
  };
}

/** 服务端受理 hello 要的东西：本机指纹、逐个试的配对密钥、jti 防重放（第一次见到返回 true 并记下）。 */
export interface ChannelAcceptorDeps {
  myFingerprint: string;
  candidates(): Array<{ peerFingerprint: string; keys: ChannelKeys }>;
  rememberJti(jti: string, exp: number): boolean;
  now?: () => number;
}

/** 服务端：受理一帧 hello。任何一项不对都返回 {ok:false}，不说原因（不给探测的人线索）。 */
export function acceptChannelHello(hello: string, deps: ChannelAcceptorDeps): ChannelAcceptResult {
  let token: string;
  try {
    const h = JSON.parse(hello) as { t?: unknown; v?: unknown; token?: unknown };
    if (h.t !== 'dm.ch.hello' || h.v !== CHANNEL_VERSION || typeof h.token !== 'string') return { ok: false };
    token = h.token;
  } catch { return { ok: false }; }
  const now = deps.now?.() ?? Date.now();
  for (const c of deps.candidates()) {
    let payload: PasetoPayload;
    try { payload = decodePaseto(token, c.keys.authKey, { now }); } catch { continue; }
    // 解开了就是这一把：之后任何一项不对都直接拒，不再试别的密钥
    if (payload.aud !== deps.myFingerprint || typeof payload.jti !== 'string' || typeof payload.epk !== 'string') return { ok: false };
    if (payload.device_fingerprint !== c.peerFingerprint) return { ok: false };
    const clientEpk = unb64u(payload.epk);
    if (clientEpk.length !== 32) return { ok: false };
    if (!deps.rememberJti(payload.jti, payload.exp)) return { ok: false };
    try {
      const eph = x25519.keygen();
      const th = transcript(token, eph.publicKey);
      const okm = deriveKeys(eph.secretKey, clientEpk, c.keys, th);
      const reply = JSON.stringify({ t: 'dm.ch.accept', v: CHANNEL_VERSION, epk: b64u(eph.publicKey), mac: b64u(acceptMac(c.keys.authKey, th)) });
      return { ok: true, peerFingerprint: c.peerFingerprint, reply, cipher: makeCipher(okm, DIR_S2C) };
    } catch {
      return { ok: false }; // 低阶点等非法公钥
    }
  }
  return { ok: false };
}
