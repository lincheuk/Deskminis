/**
 * F11A · 附件同步的名字校验与线格式解析（设计 §3.1、§3.3、§4.1）
 *
 * 钉住的行为：
 *   ① validateAttachmentName / attachmentNameOf：只认单层 ASCII 文件名；路径穿越、盘符、备用数据流、
 *      Windows 保留设备名、结尾的点一律不认——对端给的名字过不了这一关就不会进任何 join。
 *   ② 各解析器逐字段：信封不合规整条 ATT_BAD_REQUEST；清单里单条不合规只记在那一条上。
 *   ③ 块的 base64 必须规范、长度不超过一块；get 的应答必须正是请求的那一块。
 *   ④ 错误码经 message 往返（RpcServer 只回传 message）。
 *   ⑤ 状态文案覆盖设计 §4.12 的全部键。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import {
  validateAttachmentName, attachmentNameOf, localAttachmentName, localAttachmentNameOf, ATTACHMENT_STATE_TEXT, attachmentStateText,
  SESSION_ID_RE, SHA256_HEX_RE, ATTACHMENT_GUEST_PREFIX,
} from '../src/shared/attachments';
import {
  ATT_PROTO, AttError, attErrorCodeOf, attOffsetExpected, normalizeMime,
  parseWireAttachment, parseManifestRequest, parseManifestResponse,
  parseGetRequest, parseGetResponse, parsePutRequest, parsePutResponse, toWire,
} from '../src/minisd/sync/attachments/wire';
import { writeFileSync } from 'node:fs';
import { watchEngine } from './engine-wiring';
import { onCall } from './engine-trace';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import type { StartMinisdOpts } from '../src/minisd/index';

const qEngines: CapturedEngine[] = [];

const qSavedFake = process.env.DESKMINIS_FAKE_PROVIDER;

afterEach(async () => {
  for (const e of qEngines.splice(0).reverse()) await e.close();
  vi.restoreAllMocks();
  if (qSavedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER;
  else process.env.DESKMINIS_FAKE_PROVIDER = qSavedFake;
});

async function qStart(opts: StartMinisdOpts = {}): Promise<CapturedEngine> {
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const e = await startCapturedEngine(opts);
  qEngines.push(e);
  return e;
}

async function qRpc(e: CapturedEngine, name: string, p: any = {}, conn = probeConnection('local')): Promise<any> {
  return await e.methods[name](p, conn);
}

const SID = '11111111-2222-4333-8444-555555555555';
const SHA = 'a'.repeat(64);
const CHUNK = ATT_PROTO.CHUNK_BYTES;

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return e instanceof AttError ? e.code : `非 AttError: ${String(e)}`; }
  return undefined;
}

describe('F11A 名字校验', () => {
  it('合规的单层文件名原样返回', () => {
    for (const n of ['paste-1700000000000.png', 'paste-1700000000000-0a1b2c3d.jpg', 'a', 'A.B_c-9.docx', 'x'.repeat(128), 'console.png', 'com10.txt', 'nulx.png']) {
      expect(validateAttachmentName(n), n).toBe(n);
    }
  });

  it('路径穿越、盘符、备用数据流、设备名、结尾的点、超长、非字符串一律不认', () => {
    const bad: unknown[] = [
      '..\\..\\evil.png', '../x', 'a/b.png', 'a\\b.png', 'C:evil', 'x.png:ads', 'CON.png', 'con', 'nul', 'NUL.txt',
      'Com1.png', 'lpt9', 'aux.tar.gz', 'prn.', '.hidden', 'x.', 'a..b', '', 'x\u0000.png', 'x'.repeat(129),
      '中文.png', 'a b.png', '-x.png', '_x.png', 123, null, undefined, {}, ['a.png'],
    ];
    for (const n of bad) expect(validateAttachmentName(n), String(n)).toBeUndefined();
  });

  it('attachmentNameOf 只认 attachments/<合法名字>', () => {
    expect(attachmentNameOf('attachments/paste-1.png')).toBe('paste-1.png');
    const bad: unknown[] = [
      'paste-1.png', 'attachments/', 'attachments/../../../evil.png', 'attachments/a/b.png', 'attachments\\a.png',
      'C:\\Users\\x\\attachments\\a.png', '/var/minis/attachments/a.png', 'Attachments/a.png', 'attachments//a.png',
      '', 42, null, undefined,
    ];
    for (const p of bad) expect(attachmentNameOf(p), String(p)).toBeUndefined();
  });

  it('本机单层文件名（比同步的规则宽一档）：chat.prompt 的白名单收、同步不收的名字它认；分隔符、盘符、全是点、设备名仍不认', async () => {
    // chat.prompt 的白名单原样抄在这里，并钉住源码里确实是这一条：两处规则要一起看
    const PROMPT_RE = /^attachments\/[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp)$/i;
    const promptOnly = ['_shot.png', '-a.png', '.hidden.png', 'a..b.png', '...png', `${'x'.repeat(200)}.png`];
    for (const n of promptOnly) {
      expect(PROMPT_RE.test(`attachments/${n}`), n).toBe(true);
      expect(validateAttachmentName(n), n).toBeUndefined(); // 不同步
      expect(localAttachmentName(n), n).toBe(n); // 但它是本机桶里的一个文件名
      expect(localAttachmentNameOf(`attachments/${n}`), n).toBe(n);
    }
    // 同步认的名字它当然也认
    for (const n of ['paste-1700000000000.png', 'A.B_c-9.docx', 'x'.repeat(128)])
      expect(localAttachmentName(n), n).toBe(n);
    const bad: unknown[] = [
      '..', '.', '....', '', '../x', '..\\..\\evil.png', 'a/b.png', 'a\\b.png', 'C:evil', 'x.png:ads', 'CON.png', 'nul', 'Com1.png',
      'x.', 'x\u0000.png', 'a b.png', '中文.png', 'x'.repeat(256), 7, null, undefined, {},
    ];
    for (const n of bad)
      expect(localAttachmentName(n), String(n)).toBeUndefined();
    for (const p of ['_shot.png', 'attachments/', 'attachments/../../../evil.png', 'attachments/a/_b.png', 'attachments\\_a.png',
      'C:\\Users\\x\\attachments\\_a.png', '/var/minis/attachments/_a.png', 42, null]) {
      expect(localAttachmentNameOf(p), String(p)).toBeUndefined();
    }
    // 引擎实际采用此白名单；合规名字已跨过附件校验并落user消息，坏名字拒在非法路径断言上。
    const w = watchEngine();
    const e = await qStart();
    const paths = w.args('new CheckpointService')[0].paths;
    const chat = w.made('new ChatStore');
    for (const rel of ['attachments/_shot.png', 'Attachments/.hidden.GIF', 'ATTACHMENTS/a..b.webp', 'attachments/a-b.jpeg', 'attachments/x.jpg']) {
      const { id } = await qRpc(e, 'chat.sessions.create');
      paths.ensureSessionDirs(id);
      const filename = rel.slice('attachments/'.length);
      writeFileSync(join(paths.sessionBucket(id, 'attachments'), filename), Buffer.from('Q20A'));
      await qRpc(e, 'chat.prompt', { sessionId: id, text: '附件', providerId: '__fake__', attachments: [rel] });
      expect(chat.listMessages(id).filter((m: any) => m.role === 'user')).toHaveLength(1);
    }
    const { id } = await qRpc(e, 'chat.sessions.create');
    for (const rel of ['attachments/x.bmp', 'attachments/a/b.png', 'attachments\\x.png', 'attachments/../x.png', 'attachments/x.png:ads', 'attachmentſ/x.png', 'attachments/.png']) {
      await expect(qRpc(e, 'chat.prompt', { sessionId: id, text: '附件', providerId: '__fake__', attachments: [rel] }), rel).rejects.toThrow('非法附件路径');
    }
  }, 60000);

  it('本机引用的前缀不分大小写：chat.prompt 的白名单整条带 /i，Attachments/x.png 它照收；同步侧仍只认全小写的前缀', () => {
    // 与上一条用的是同一条白名单（源码里确实是它，上一条已钉住）
    const PROMPT_RE = /^attachments\/[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp)$/i;
    const prefixes = ['Attachments/', 'ATTACHMENTS/', 'aTtAcHmEnTs/', 'attachmentS/'];
    // 名字合规的、只有 chat.prompt 收的，都要认：chat.prompt 收下的引用原样落库，请求构建按 basename 读桶里的这个文件
    const names = ['x.png', 'paste-1700000000000-0a1b2c3d.PNG', '_shot.jpg', '-a.jpeg', '.hidden.gif', 'a..b.webp', `${'x'.repeat(200)}.png`];
    for (const pre of prefixes) {
      for (const n of names) {
        const rel = `${pre}${n}`;
        expect(PROMPT_RE.test(rel), rel).toBe(true);
        expect(localAttachmentNameOf(rel), rel).toBe(n);                 // 本机：桶里的这个文件名
        expect(attachmentNameOf(rel), rel).toBeUndefined();              // 同步：不认，不登记、不上线路
      }
    }
    // 全小写的前缀两边照旧
    expect(localAttachmentNameOf('attachments/x.png')).toBe('x.png');
    expect(attachmentNameOf('attachments/x.png')).toBe('x.png');
    // 放宽的只有前缀里 ASCII 字母的大小写。分隔符、多层目录、别的前缀、保留设备名照旧不认；
    // 非 ASCII 的「大小写」不算（ſ 的大写是 S、全角 Ａ）：chat.prompt 的正则也不收它们
    const still = [
      'Attachments\\x.png', 'Attachments//x.png', 'Attachments/a/x.png', 'Attachments/../x.png', 'Attachments/', 'Attachments', 'Attachments/CON.png',
      'xAttachments/x.png', ' Attachments/x.png', '/Attachments/x.png', 'Attachment/x.png', 'C:\\Attachments\\x.png',
      'attachment\u017f/x.png', '\uff21ttachments/x.png',
    ];
    for (const p of still) {
      expect(localAttachmentNameOf(p), p).toBeUndefined();
      expect(attachmentNameOf(p), p).toBeUndefined();
    }
    for (const p of ['attachment\u017f/x.png', '\uff21ttachments/x.png']) expect(PROMPT_RE.test(p), p).toBe(false);
    // chat.prompt \u7684\u6b63\u5219\u6536\u3001\u8fd9\u91cc\u4ecd\u4e0d\u8ba4\u7684\u53ea\u5269\u4e24\u79cd\uff1aWindows \u4fdd\u7559\u8bbe\u5907\u540d\u3001\u8d85\u8fc7 255 \u5b57\u7b26\u7684\u540d\u5b57\uff08\u89c4\u683c\u6587\u6863\u5df2\u77e5\u9650\u5236\u7b2c 10 \u6761\u7167\u6b64\u5199\uff09
    for (const p of ['attachments/CON.png', 'Attachments/nul.jpg', `attachments/${'x'.repeat(252)}.png`, `ATTACHMENTS/${'x'.repeat(252)}.png`]) {
      expect(PROMPT_RE.test(p), p).toBe(true);
      expect(localAttachmentNameOf(p), p).toBeUndefined();
    }
    // \u6070\u597d 255 \u5b57\u7b26\u7684\u540d\u5b57\u8ba4
    expect(localAttachmentNameOf(`Attachments/${'x'.repeat(251)}.png`)).toBe(`${'x'.repeat(251)}.png`);
  });

  it('共用的正则与前缀', () => {
    expect(SESSION_ID_RE.test(SID)).toBe(true);
    expect(SESSION_ID_RE.test('..\\..\\x')).toBe(false);
    expect(SESSION_ID_RE.test('not-a-uuid')).toBe(false);
    expect(SHA256_HEX_RE.test(SHA)).toBe(true);
    expect(SHA256_HEX_RE.test('A'.repeat(64))).toBe(false);
    expect(SHA256_HEX_RE.test('a'.repeat(63))).toBe(false);
    expect(ATTACHMENT_GUEST_PREFIX).toBe('/var/minis/attachments/');
  });
});

describe('F11A 线格式解析', () => {
  it('parseWireAttachment：合规条目、bad_name、bad_entry、mimeType 不合规退回通用类型', () => {
    expect(parseWireAttachment({ name: 'a.png', size: 3, sha256: SHA, mimeType: 'Image/PNG' }))
      .toEqual({ ok: true, value: { name: 'a.png', size: 3, sha256: SHA, mimeType: 'image/png' } });
    expect(parseWireAttachment({ name: 'a.png', size: 3, sha256: SHA, mimeType: 'not a mime' }))
      .toEqual({ ok: true, value: { name: 'a.png', size: 3, sha256: SHA, mimeType: 'application/octet-stream' } });
    expect(parseWireAttachment({ name: 'a.png', size: 3, sha256: SHA }))
      .toEqual({ ok: true, value: { name: 'a.png', size: 3, sha256: SHA, mimeType: 'application/octet-stream' } });
    // 超过单文件上限形状仍合规：由存储层判 too_large
    expect(parseWireAttachment({ name: 'a.png', size: ATT_PROTO.MAX_FILE_BYTES + 1, sha256: SHA, mimeType: 'image/png' }).ok).toBe(true);
    for (const name of ['../x', 'a/b.png', 'CON.png', '', 7]) {
      expect(parseWireAttachment({ name, size: 3, sha256: SHA, mimeType: 'image/png' })).toEqual({ ok: false, code: 'bad_name' });
    }
    for (const patch of [{ size: 0 }, { size: -1 }, { size: 1.5 }, { size: '3' }, { size: Number.MAX_SAFE_INTEGER + 2 }, { sha256: 'A'.repeat(64) }, { sha256: 'abc' }, { sha256: 5 }]) {
      expect(parseWireAttachment({ name: 'a.png', size: 3, sha256: SHA, mimeType: 'image/png', ...patch }), JSON.stringify(patch)).toEqual({ ok: false, code: 'bad_entry' });
    }
    for (const raw of [null, undefined, 'x', 3, [1]]) expect(parseWireAttachment(raw)).toEqual({ ok: false, code: 'bad_entry' });
  });

  it('parseWireAttachment 的输出没有任何多余字段（对端塞进来的路径字段带不过去）', () => {
    const r = parseWireAttachment({ name: 'a.png', size: 3, sha256: SHA, mimeType: 'image/png', relativePath: 'C:\\x', path: '/etc/passwd', localPath: 'D:\\y' });
    expect(r.ok && Object.keys(r.value).sort()).toEqual(['mimeType', 'name', 'sha256', 'size']);
  });

  it('parseManifestRequest：信封、会话 id、条数', () => {
    const ok = parseManifestRequest({ v: 1, sessionId: SID, entries: [{ name: 'a.png', size: 1, sha256: SHA, mimeType: 'image/png' }, { name: '../x', size: 1, sha256: SHA }] });
    expect(ok.sessionId).toBe(SID);
    expect(ok.entries.map(e => e.ok)).toEqual([true, false]);
    expect(parseManifestRequest({ v: 1, sessionId: SID, entries: [] }).entries).toEqual([]);
    const entry = { name: 'a.png', size: 1, sha256: SHA, mimeType: 'image/png' };
    const bad: unknown[] = [
      null, 'x', [], { v: 2, sessionId: SID, entries: [] }, { sessionId: SID, entries: [] }, { v: '1', sessionId: SID, entries: [] },
      { v: 1, sessionId: '..\\..\\x', entries: [] }, { v: 1, sessionId: 'not-a-uuid', entries: [] }, { v: 1, entries: [] },
      { v: 1, sessionId: SID }, { v: 1, sessionId: SID, entries: {} },
      { v: 1, sessionId: SID, entries: Array.from({ length: ATT_PROTO.LIST_MAX + 1 }, () => entry) },
    ];
    for (const raw of bad) expect(codeOf(() => parseManifestRequest(raw)), JSON.stringify(raw)?.slice(0, 80)).toBe('ATT_BAD_REQUEST');
    // 恰好 LIST_MAX 条是合规的
    expect(parseManifestRequest({ v: 1, sessionId: SID, entries: Array.from({ length: ATT_PROTO.LIST_MAX }, () => entry) }).entries).toHaveLength(ATT_PROTO.LIST_MAX);
  });

  it('parseManifestResponse：不合规的条目、want、rejected 丢弃；信封不合规抛错', () => {
    const r = parseManifestResponse({
      v: 1,
      entries: [{ name: 'a.png', size: 1, sha256: SHA, mimeType: 'image/png' }, { name: '..\\evil', size: 1, sha256: SHA }, 'x'],
      want: [
        { name: 'b.png', sha256: SHA, offset: CHUNK }, { name: 'b.png', sha256: SHA, offset: 5 }, { name: '../b', sha256: SHA, offset: 0 },
        { name: 'b.png', sha256: 'zz', offset: 0 }, { name: 'b.png', sha256: SHA, offset: -CHUNK }, null,
      ],
      rejected: [{ index: 0, code: 'held' }, { index: 0, code: 'nope' }, { index: -1, code: 'held' }, { index: ATT_PROTO.LIST_MAX, code: 'held' }, { index: 1.5, code: 'busy' }, 7],
      indexing: false,
      extra: 'ignored',
    });
    expect(r).toEqual({
      v: 1,
      entries: [{ name: 'a.png', size: 1, sha256: SHA, mimeType: 'image/png' }],
      want: [{ name: 'b.png', sha256: SHA, offset: CHUNK }],
      rejected: [{ index: 0, code: 'held' }],
      indexing: false,
    });
    const base = { v: 1, entries: [], want: [], rejected: [], indexing: true };
    expect(parseManifestResponse(base)).toEqual(base);
    for (const patch of [{ v: 2 }, { entries: null }, { want: {} }, { rejected: 'x' }, { indexing: 1 }, { indexing: 'true' }]) {
      expect(codeOf(() => parseManifestResponse({ ...base, ...patch })), JSON.stringify(patch)).toBe('ATT_BAD_REQUEST');
    }
    expect(codeOf(() => parseManifestResponse(undefined))).toBe('ATT_BAD_REQUEST');
    // entries 只取前 LIST_MAX 条
    const many = Array.from({ length: ATT_PROTO.LIST_MAX + 5 }, (_, i) => ({ name: `f${i}.png`, size: 1, sha256: SHA, mimeType: 'image/png' }));
    expect(parseManifestResponse({ ...base, entries: many }).entries).toHaveLength(ATT_PROTO.LIST_MAX);
  });

  it('parseGetRequest：sessionId、名字、sha256、offset 逐个校验', () => {
    const base = { v: 1, sessionId: SID, name: 'a.png', sha256: SHA, offset: 2 * CHUNK };
    expect(parseGetRequest(base)).toEqual(base);
    expect(parseGetRequest({ ...base, offset: 0, relativePath: 'C:\\x' })).toEqual({ ...base, offset: 0 });
    for (const patch of [
      { v: 0 }, { sessionId: '..\\..\\x' }, { sessionId: 'not-a-uuid' }, { name: '..\\..\\evil.png' }, { name: 'a/b.png' }, { name: 'nul' },
      { name: 'x.png:ads' }, { name: 5 }, { sha256: 'q'.repeat(64) }, { offset: 1 }, { offset: -CHUNK }, { offset: CHUNK + 0.5 }, { offset: '0' },
    ]) {
      expect(codeOf(() => parseGetRequest({ ...base, ...patch })), JSON.stringify(patch)).toBe('ATT_BAD_REQUEST');
    }
  });

  it('parsePutRequest：data 必须是规范的 base64、解码后 1…一块', () => {
    const bytes = Buffer.from('hello attachments');
    const base = { v: 1, sessionId: SID, name: 'a.png', sha256: SHA, offset: 0, data: bytes.toString('base64') };
    const r = parsePutRequest(base);
    expect(r.bytes.equals(bytes)).toBe(true);
    expect({ sessionId: r.sessionId, name: r.name, sha256: r.sha256, offset: r.offset }).toEqual({ sessionId: SID, name: 'a.png', sha256: SHA, offset: 0 });
    // 恰好一块：合规
    expect(parsePutRequest({ ...base, data: Buffer.alloc(CHUNK, 7).toString('base64') }).bytes.length).toBe(CHUNK);
    const tooLong = Buffer.alloc(CHUNK + 3, 7).toString('base64');
    for (const data of ['', 'abc', 'ab=c', 'a b=', '-_-_', 'QQ=', 'QR==', tooLong, 5, null, undefined]) {
      expect(codeOf(() => parsePutRequest({ ...base, data })), String(data).slice(0, 20)).toBe('ATT_BAD_REQUEST');
    }
    expect(codeOf(() => parsePutRequest({ ...base, name: '..\\x' }))).toBe('ATT_BAD_REQUEST');
    expect(codeOf(() => parsePutRequest({ ...base, offset: 3 }))).toBe('ATT_BAD_REQUEST');
  });

  it('parseGetResponse：应答必须正是请求的那一块', () => {
    const size = CHUNK + 10;
    const first = Buffer.alloc(CHUNK, 1);
    const last = Buffer.alloc(10, 2);
    expect(parseGetResponse({ v: 1, offset: 0, size, data: first.toString('base64') }, { offset: 0, size }).equals(first)).toBe(true);
    expect(parseGetResponse({ v: 1, offset: CHUNK, size, data: last.toString('base64') }, { offset: CHUNK, size }).equals(last)).toBe(true);
    const bad: Array<[unknown, { offset: number; size: number }]> = [
      [{ v: 1, offset: 0, size, data: first.toString('base64') }, { offset: CHUNK, size }],          // 是上一块的应答（offset 不符）
      [{ v: 1, offset: 0, size: size + 1, data: first.toString('base64') }, { offset: 0, size }],      // size 与 manifest 不符
      [{ v: 1, offset: CHUNK, size, data: first.toString('base64') }, { offset: CHUNK, size }],        // 末块比该有的长
      [{ v: 1, offset: 0, size, data: last.toString('base64') }, { offset: 0, size }],                 // 比该有的短
      [{ v: 1, offset: 0, size, data: '***' }, { offset: 0, size }],
      [{ v: 2, offset: 0, size, data: first.toString('base64') }, { offset: 0, size }],
      [{ v: 1, offset: 0, size }, { offset: 0, size }],
      [null, { offset: 0, size }],
    ];
    for (const [raw, expectArg] of bad) expect(codeOf(() => parseGetResponse(raw, expectArg))).toBe('ATT_BAD_CHUNK');
  });

  it('parsePutResponse：offset 是块界或恰为 size，done 是严格布尔', () => {
    const size = CHUNK + 10;
    expect(parsePutResponse({ v: 1, offset: CHUNK, done: false }, size)).toEqual({ v: 1, offset: CHUNK, done: false });
    expect(parsePutResponse({ v: 1, offset: size, done: true }, size)).toEqual({ v: 1, offset: size, done: true });
    for (const raw of [{ v: 1, offset: 5, done: false }, { v: 1, offset: size + CHUNK, done: false }, { v: 1, offset: -1, done: false }, { v: 1, offset: CHUNK, done: 1 }, { v: 1, done: true }, { v: 3, offset: 0, done: false }, 'x']) {
      expect(codeOf(() => parsePutResponse(raw, size)), JSON.stringify(raw)).toBe('ATT_BAD_REQUEST');
    }
  });

  it('块长可注入（组件级测试两端一起缩小）：解析器按注入的块长校验', () => {
    const base = { v: 1, sessionId: SID, name: 'a.png', sha256: SHA, offset: 1024 };
    expect(codeOf(() => parseGetRequest(base))).toBe('ATT_BAD_REQUEST');
    expect(parseGetRequest(base, 1024).offset).toBe(1024);
    expect(codeOf(() => parsePutRequest({ ...base, data: Buffer.alloc(2048).toString('base64') }, 1024))).toBe('ATT_BAD_REQUEST');
    expect(parsePutRequest({ ...base, data: Buffer.alloc(1024).toString('base64') }, 1024).bytes.length).toBe(1024);
  });

  it('toWire 只带四个字段；normalizeMime 转小写', () => {
    const w = toWire({ name: 'a.png', size: 9, sha256: SHA, mimeType: 'image/PNG', ...({ sessionId: SID, statSize: 9 } as object) });
    expect(w).toEqual({ name: 'a.png', size: 9, sha256: SHA, mimeType: 'image/png' });
    expect(normalizeMime('')).toBe('application/octet-stream');
    expect(normalizeMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
});

describe('F11A 错误码', () => {
  it('码经 message 往返；detail 只有数字', () => {
    expect(new AttError('ATT_HASH').message).toBe('ATT_HASH');
    expect(new AttError('ATT_OFFSET', 'expected=524288').message).toBe('ATT_OFFSET expected=524288');
    expect(attErrorCodeOf(new AttError('ATT_PAUSED').message)).toBe('ATT_PAUSED');
    expect(attErrorCodeOf(new Error('ATT_OFFSET expected=0'))).toBe('ATT_OFFSET');
    expect(attErrorCodeOf('ATT_NOPE')).toBeUndefined();
    expect(attErrorCodeOf('未知方法: sync.att.get')).toBeUndefined();
    expect(attErrorCodeOf(undefined)).toBeUndefined();
    expect(attOffsetExpected('ATT_OFFSET expected=262144')).toBe(262144);
    expect(attOffsetExpected(new Error('ATT_OFFSET expected=0'))).toBe(0);
    expect(attOffsetExpected('ATT_OFFSET expected=-1')).toBeUndefined();
    expect(attOffsetExpected('ATT_OFFSET expected=1e9')).toBeUndefined();
    expect(attOffsetExpected('ATT_OFFSET')).toBeUndefined();
    expect(attOffsetExpected('ATT_HASH expected=3')).toBeUndefined();
  });
});

describe('F11A 状态文案', () => {
  it('覆盖设计 §4.12 的全部键', () => {
    const keys = [
      'transferring', 'paused', 'held',
      'pending/queued', 'pending/interrupted', 'pending/source_offline', 'pending/peer_paused',
      'failed/hash_mismatch', 'failed/bad_chunk', 'failed/io_error', 'failed/name_conflict', 'failed/local_changed',
      'unavailable/peer_unsupported', 'unavailable/no_source', 'unavailable/too_large', 'unavailable/quota', 'unavailable/bad_reference',
      'local/too_large', 'local/name_conflict', 'local/bad_reference', 'local/suffix',
    ];
    expect(Object.keys(ATTACHMENT_STATE_TEXT).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(ATTACHMENT_STATE_TEXT[k].length, k).toBeGreaterThan(0);
    expect(ATTACHMENT_STATE_TEXT['unavailable/peer_unsupported']).toBe('不可用：对方的版本不支持附件同步');
    expect(attachmentStateText('failed', 'hash_mismatch')).toBe('同步失败：内容校验不通过');
    expect(attachmentStateText('paused')).toBe('未同步：本机已暂停同步');
    expect(attachmentStateText('ready')).toBe('');
    expect(Object.isFrozen(ATTACHMENT_STATE_TEXT)).toBe(true);
  });
});
