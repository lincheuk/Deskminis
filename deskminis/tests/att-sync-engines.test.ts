/**
 * F11A · 两个真实 minisd 实例经真实的配对与加密通道同步真实文件（任务卡验收 1–5、阻断 1–3）。
 *
 * 同一进程里 startMinisd 两次，各用一个临时数据根；配对走真实的 remote.pair.begin / join，连接走 ?ch=1 加密通道。
 * 需要中断、扣住、抓包的用例让拨号方经原始 TCP 转发器连过去（tests/att-engines-util.ts 的 tcpRelay）。
 * 断言核对的是磁盘上的文件与它们的 sha256（哈希在测试里独立计算），不是内存里的线格式。
 *
 * 会话甲只放文本与图片（走产品的 chat.prompt 路径）；文档（docx、pdf）放在单独的会话乙里、不在其中发模型请求：
 * 产品没有文档附件入口，现有请求构建会把用户消息里的任何 mediaRef 当图片发出（G03 之前的边界）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocx } from '../src/minisd/office/build';
import { ATTACHMENT_STATE_TEXT } from '../src/shared/attachments';
import { chipOf } from '../src/renderer/src/lib/attach/status';
import { makePdf, makePng, sha256File, sha256Of, waitFor } from './att-util';
import {
  bootEngines, bucketOf, expectNotComplete, imageUrlsOf, itemOf, mockOpenAI, newSession, partsIn, peerFpOf, promptAndWait,
  seedFile, seedImage, seedText, statusOf, wsConnect,
  type Engines, type RpcClient,
} from './att-engines-util';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MiB = 1024 * 1024;
const CHUNK = 256 * 1024;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot(opts: Parameters<typeof bootEngines>[0]): Promise<Engines> {
  const e = await bootEngines(opts);
  cleanups.push(() => e.dispose());
  return e;
}

/** 等 B 的附件桶里出现这个名字且哈希与期望相等。 */
async function arrived(root: string, sid: string, name: string, sha: string, timeoutMs = 9000): Promise<void> {
  await waitFor(`${name} 到达并且哈希相等`, () => {
    const p = join(bucketOf(root, sid), name);
    return existsSync(p) && sha256File(p) === sha;
  }, timeoutMs);
}

async function ready(local: RpcClient, sid: string, name: string, timeoutMs = 9000): Promise<void> {
  await waitFor(`${name} 的状态变成 ready`, async () => (await itemOf(local, sid, name))?.state === 'ready', timeoutMs);
}

interface Seeded { sidA: string; sidDoc: string; png: Buffer; docx: Buffer; pdf: Buffer; docMarker: string }

/** 在持有文件的一端建会话甲（文本 + PNG，产品路径）与会话乙（docx + pdf，注入引用）。 */
async function seedBoth(local: RpcClient, root: string): Promise<Seeded> {
  const png = makePng(300_000, 101).buf;
  const docMarker = '附件同步取证标记 F11A-docx-7c1e';
  const docx = buildDocx({ title: 'F11A', blocks: [{ kind: 'heading', level: 1, text: '同步测试' }, { kind: 'para', text: docMarker }] });
  const pdf = makePdf(102).buf;
  const sidA = await newSession(local, '会话甲');
  await seedImage(local, root, sidA, 'paste-1700000000000-0a1b2c3d.png', png, '文本与图片');
  const sidDoc = await newSession(local, '会话乙');
  await seedFile(local, root, sidDoc, 'report-1.docx', docx, DOCX_MIME);
  await seedFile(local, root, sidDoc, 'paper-1.pdf', pdf, 'application/pdf');
  return { sidA, sidDoc, png, docx, pdf, docMarker };
}

async function expectAllArrived(e: Engines, from: 'A' | 'B', s: Seeded): Promise<void> {
  const [srcRoot, dstRoot, dst] = from === 'A' ? [e.dirA, e.dirB, e.localB] as const : [e.dirB, e.dirA, e.localA] as const;
  expect(srcRoot).not.toBe(dstRoot);
  const files: Array<[string, string, Buffer]> = [
    [s.sidA, 'paste-1700000000000-0a1b2c3d.png', s.png], [s.sidDoc, 'report-1.docx', s.docx], [s.sidDoc, 'paper-1.pdf', s.pdf],
  ];
  for (const [sid, name, bytes] of files) {
    await arrived(dstRoot, sid, name, sha256Of(bytes));
    const srcSha = sha256File(join(bucketOf(srcRoot, sid), name));
    const dstSha = sha256File(join(bucketOf(dstRoot, sid), name));
    // 两端真实文件的 sha256 打进测试日志（验收 5 的证据）
    console.log(`[F11A hash] ${name} 源端=${srcSha} 接收端=${dstSha} 长度=${statSync(join(bucketOf(dstRoot, sid), name)).size}`);
    expect(dstSha).toBe(srcSha);
    expect(dstSha).toBe(sha256Of(bytes));
    await ready(dst, sid, name);
  }
  for (const sid of [s.sidA, s.sidDoc]) {
    const st = await statusOf(dst, sid);
    expect(st.items.map(i => i.state), JSON.stringify(st.items)).toEqual(st.items.map(() => 'ready'));
    expect(st.items.every(i => i.localAvailable && i.localPath!.startsWith(dstRoot))).toBe(true);
    // 接收端库里的引用与源端相同，仍是逻辑路径，不含盘符
    const msgs = await dst.call('chat.messages.list', { sessionId: sid });
    const refs = msgs.flatMap((m: any) => m.parts.filter((p: any) => p.type === 'mediaRef').map((p: any) => p.value.relativePath as string));
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) { expect(r).toMatch(/^attachments\/[A-Za-z0-9._-]+$/); expect(r).not.toMatch(/[A-Za-z]:[\\/]/); }
  }
  expect(partsIn(dstRoot)).toEqual([]);
}

describe('F11A 真引擎 × 真引擎：文本 + 图像 + 文档', () => {
  it('文件在拨号方（A 拨 B，走 put）：B 的数据根里三个文件哈希逐个相等、状态全是 ready', async () => {
    const e = await boot({ dialer: 'A' });
    const s = await seedBoth(e.localA, e.dirA);
    await expectAllArrived(e, 'A', s);
  });

  it('文件在监听方（B 拨 A，走 get）：同样到达', async () => {
    const e = await boot({ dialer: 'B' });
    const s = await seedBoth(e.localA, e.dirA);
    await expectAllArrived(e, 'A', s);
  });

  it('接收端能打开：attachments.read 的字节哈希相等、路径在接收端自己的数据根里；office.read 读到文档里的标记', async () => {
    const e = await boot({ dialer: 'A' });
    const s = await seedBoth(e.localA, e.dirA);
    await expectAllArrived(e, 'A', s);
    const cases: Array<[string, string, Buffer]> = [
      [s.sidA, 'paste-1700000000000-0a1b2c3d.png', s.png], [s.sidDoc, 'report-1.docx', s.docx], [s.sidDoc, 'paper-1.pdf', s.pdf],
    ];
    for (const [sid, name, bytes] of cases) {
      const r = await e.localB.call('attachments.read', { sessionId: sid, name });
      expect(sha256Of(Buffer.from(r.base64, 'base64'))).toBe(sha256Of(bytes));
      expect(r.size).toBe(bytes.length);
      expect(String(r.localPath).startsWith(e.dirB)).toBe(true);
    }
    const doc = await e.localB.call('office.read', { sessionId: s.sidDoc, path: '/var/minis/attachments/report-1.docx' });
    expect(JSON.stringify(doc)).toContain(s.docMarker);
  });

  it('接收端继续模型请求（只在会话甲）：发给模型的请求体里恰有一张图，字节哈希等于源端的 PNG', async () => {
    // 本地假 OpenAI 端点记录请求体；B 配一个目录里确认收图片的实例指向它
    const mock = await mockOpenAI();
    cleanups.push(() => mock.close());
    const e = await boot({ dialer: 'A', prepareB: dir => mock.seedCatalog(dir) });
    // 会话甲只有文本与图片（产品路径）；文档引用不进这个会话
    const png = makePng(300_000, 111).buf;
    const name = 'paste-1700000000010-1a2b3c4d.png';
    const sid = await newSession(e.localA, '会话甲');
    await seedImage(e.localA, e.dirA, sid, name, png, '文本与图片');
    await arrived(e.dirB, sid, name, sha256Of(png));
    await ready(e.localB, sid, name);
    expect(mock.hits).toEqual([]);                                             // 源端用的是假 provider，到这里假端点没被碰过

    const inst = await e.localB.call('provider.instances.create', { name: '收图片', kind: 'openai-compat', baseUrl: mock.api('vendor-a'), modelId: 'shared-model', apiKey: 'test-key' });
    const events = await promptAndWait(e.localB, { sessionId: sid, text: '继续', providerId: inst.id });
    expect(events.filter(ev => ev.kind === 'error'), JSON.stringify(events.filter(ev => ev.kind === 'error'))).toEqual([]);

    const requests = mock.hits.filter(h => h.url === '/vendor-a/v1/chat/completions');
    expect(requests.length).toBeGreaterThan(0);
    const images = imageUrlsOf(requests[0].body);
    expect(images).toHaveLength(1);
    const prefix = 'data:image/png;base64,';
    expect(images[0].startsWith(prefix)).toBe(true);
    const sent = Buffer.from(images[0].slice(prefix.length), 'base64');
    console.log(`[F11A model] 接收端发给模型的图片 sha256=${sha256Of(sent)} 源端=${sha256Of(png)} 长度=${sent.length}`);
    expect(sha256Of(sent)).toBe(sha256Of(png));
    expect(sha256Of(sent)).toBe(sha256File(join(bucketOf(e.dirA, sid), name)));
    const text = JSON.stringify(requests.map(r => r.body));
    expect(text).toContain('文本与图片');                                       // 同步来的文本也在请求里
    for (const bad of ['data:application/', '附件已丢失', '已随上下文省略', '图片未发送']) expect(text.includes(bad), bad).toBe(false);
  });

  it('前缀大小写不同的引用（Attachments/…，chat.prompt 照收）：来源端文件在本机、模型读得到，状态照实说本机有并能打开；这一份不同步，同一条消息里合规的那张照常同步', async () => {
    const mock = await mockOpenAI();
    cleanups.push(() => mock.close());
    // 来源端放在 B：它要配一个指向假端点的真 provider，夹具只给 B 留了启动前布置模型目录的口子。A 拨 B
    const e = await boot({ dialer: 'A', prepareB: dir => mock.seedCatalog(dir) });
    const odd = makePng(120_000, 141).buf;
    const plain = makePng(130_000, 142).buf;
    // 名字按升序 odd 在前：真要同步它的话，它会先于合规的那张到达
    const oddName = 'paste-1700000000020-2b3c4d5e.png';
    const plainName = 'paste-1700000000021-3c4d5e6f.png';
    const oddRel = `Attachments/${oddName}`;
    const plainRel = `attachments/${plainName}`;
    const sid = await newSession(e.localB, '前缀大小写');
    mkdirSync(bucketOf(e.dirB, sid), { recursive: true });
    writeFileSync(join(bucketOf(e.dirB, sid), oddName), odd);
    writeFileSync(join(bucketOf(e.dirB, sid), plainName), plain);
    const refsOf = async (local: RpcClient): Promise<string[]> => {
      const msgs = await local.call('chat.messages.list', { sessionId: sid });
      return msgs.flatMap((m: any) => m.parts.filter((p: any) => p.type === 'mediaRef').map((p: any) => p.value.relativePath as string));
    };

    // 产品的 chat.prompt（不是注入）：白名单整条带 /i，这种前缀它照收，并原样写进 mediaRef.relativePath
    const inst = await e.localB.call('provider.instances.create', { name: '收图片', kind: 'openai-compat', baseUrl: mock.api('vendor-a'), modelId: 'shared-model', apiKey: 'test-key' });
    const events = await promptAndWait(e.localB, { sessionId: sid, text: '两张图', providerId: inst.id, attachments: [oddRel, plainRel] });
    expect(events.filter(ev => ev.kind === 'error'), JSON.stringify(events.filter(ev => ev.kind === 'error'))).toEqual([]);
    expect(await refsOf(e.localB)).toEqual([oddRel, plainRel]);

    // 模型两张都收到了：请求构建按 basename 读的是桶里的文件，不看前缀怎么写
    const requests = mock.hits.filter(h => h.url === '/vendor-a/v1/chat/completions');
    expect(requests.length).toBeGreaterThan(0);
    const prefix = 'data:image/png;base64,';
    const images = imageUrlsOf(requests[0].body);
    expect(images.every(u => u.startsWith(prefix))).toBe(true);
    expect(images.map(u => sha256Of(Buffer.from(u.slice(prefix.length), 'base64')))).toEqual([sha256Of(odd), sha256Of(plain)]);
    expect(JSON.stringify(requests.map(r => r.body)).includes('附件已丢失')).toBe(false);

    // 来源端的状态与模型看到的一致：本机有、点得开；只是这一份不同步
    const stB = await statusOf(e.localB, sid);
    const oddB = stB.items.find(i => i.relativePath === oddRel);
    expect(oddB, JSON.stringify(stB.items)).toMatchObject({
      name: oddName, state: 'unavailable', reason: 'bad_reference', localAvailable: true,
      localPath: join(bucketOf(e.dirB, sid), oddName), canRetry: false, canCancel: false,
    });
    expect(chipOf(oddB)).toMatchObject({ open: true, tone: 'warn', label: ATTACHMENT_STATE_TEXT['local/bad_reference'] });
    // StageChat 提示「未同步到本机的附件，模型暂时看不到」的判据是「有一项 localAvailable 为假」
    expect(stB.items.filter(i => !i.localAvailable)).toEqual([]);
    const opened = await e.localB.call('attachments.read', { sessionId: sid, name: oddB!.name });
    expect(sha256Of(Buffer.from(opened.base64, 'base64'))).toBe(sha256Of(odd));
    expect(String(opened.localPath)).toBe(join(bucketOf(e.dirB, sid), oddName));

    // 对端 A：消息原样到达；合规的那张照常同步；前缀不合规的那张不同步，状态如实是「本机没有」
    await arrived(e.dirA, sid, plainName, sha256Of(plain));
    await ready(e.localA, sid, plainName);
    expect(await refsOf(e.localA)).toEqual([oddRel, plainRel]);
    const stA = await statusOf(e.localA, sid);
    const oddA = stA.items.find(i => i.relativePath === oddRel);
    expect(oddA, JSON.stringify(stA.items)).toMatchObject({ state: 'unavailable', reason: 'bad_reference', localAvailable: false });
    expect(oddA!.localPath).toBeUndefined();
    expect(chipOf(oddA)).toMatchObject({ open: false, tone: 'err', label: ATTACHMENT_STATE_TEXT['unavailable/bad_reference'] });
    expect(existsSync(join(bucketOf(e.dirA, sid), oddName))).toBe(false);
    await waitFor('A 的暂存目录清空', () => partsIn(e.dirA).length === 0, 5000);
    expect(existsSync(join(bucketOf(e.dirA, sid), oddName))).toBe(false);
  });
});

/** 等 B 的暂存文件出现并且长度不再变化（转发器扣住数据之后，已转发的帧处理完的那一刻），返回这个长度。 */
async function stablePart(root: string): Promise<number> {
  let last = -1; let same = 0;
  return waitFor('暂存文件长度稳定下来', () => {
    const size = partsIn(root).find(p => p.name.endsWith('.part'))?.size ?? 0;
    if (size > 0 && size === last) same++; else same = 0;
    last = size;
    return same >= 3 ? size : undefined;
  }, 8000, 40);
}

const BIG_NAME = 'paste-1700000000001-aaaaaaaa.png';

/** A 经转发器拨 B，A 上有一个 3 MiB 的图片；上传到约 1 MiB 时转发器把 A→B 方向扣住。 */
async function uploadHeld(seed: number): Promise<{ e: Engines; sid: string; big: Buffer; sha: string; partSize: number }> {
  const e = await boot({ dialer: 'A', relay: true });
  const sid = await newSession(e.localA, '大文件');
  const big = makePng(3 * MiB, seed).buf;
  const held = e.relay!.holdAfter('c2s', e.relay!.bytes('c2s') + MiB);
  await seedImage(e.localA, e.dirA, sid, BIG_NAME, big);
  await held;
  const partSize = await stablePart(e.dirB);
  expect(partSize % CHUNK).toBe(0);
  expect(partSize).toBeLessThan(big.length);
  return { e, sid, big, sha: sha256Of(big), partSize };
}

describe('F11A 真引擎 × 真引擎：中断、暂停、取消配对、关停都不留下可当作完整附件的文件', () => {
  it('传输中断与续传：掐断后接收端只有暂存；重连后从断点续传，哈希相等', async () => {
    const { e, sid, big, sha, partSize } = await uploadHeld(201);
    e.relay!.cut();
    await expectNotComplete(e.dirB, e.localB, sid, BIG_NAME, big.length);
    expect(partSize).toBeGreaterThan(0);
    const before = e.relay!.bytes('c2s');
    await arrived(e.dirB, sid, BIG_NAME, sha, 20000);
    await ready(e.localB, sid, BIG_NAME);
    expect(partsIn(e.dirB)).toEqual([]);
    // 续传：重连后 A→B 的字节数只够传剩下的部分（base64 约 1.34 倍），不是整份重传
    const resent = e.relay!.bytes('c2s') - before;
    console.log(`[F11A resume] 已收 ${partSize} / ${big.length}，重连后 A→B ${resent} 字节`);
    expect(resent).toBeLessThan((big.length - partSize) * 1.4 + 64 * 1024);
  });

  it('传输中途暂停发端：暂停之后发端不再送块；恢复后续传完成', async () => {
    const { e, sid, big, sha } = await uploadHeld(202);
    await e.localA.call('control.pause');
    const frames = e.relay!.frames('c2s').length;
    e.relay!.release();
    await e.relay!.quiet(500);
    expect(e.relay!.frames('c2s').length - frames).toBeLessThanOrEqual(2);
    await expectNotComplete(e.dirB, e.localB, sid, BIG_NAME, big.length);
    expect((await itemOf(e.localA, sid, BIG_NAME))?.state).toBe('ready');     // 发端自己的文件不受影响
    await e.localA.call('control.resume');
    await arrived(e.dirB, sid, BIG_NAME, sha, 15000);
    await ready(e.localB, sid, BIG_NAME);
  });

  it('传输中途暂停收端：收端不再收块、状态是「本机已暂停同步」；恢复后续传完成', async () => {
    const { e, sid, big, sha, partSize } = await uploadHeld(203);
    await e.localB.call('control.pause');
    e.relay!.release();
    await e.relay!.quiet(500);
    expect(partsIn(e.dirB).find(p => p.name.endsWith('.part'))?.size ?? 0).toBeLessThanOrEqual(partSize + CHUNK);
    await expectNotComplete(e.dirB, e.localB, sid, BIG_NAME, big.length);
    const st = await statusOf(e.localB, sid);
    expect(st.syncPaused).toBe(true);
    expect(st.items.find(i => i.name === BIG_NAME)?.state).toBe('paused');
    await e.localB.call('control.resume');
    await arrived(e.dirB, sid, BIG_NAME, sha, 15000);
    await ready(e.localB, sid, BIG_NAME);
  });

  it('文件在监听方、监听方暂停：拨号方的状态是「对方暂停了同步」，没有完整文件；对方恢复后收敛', async () => {
    const e = await boot({ dialer: 'A', relay: true });
    const sid = await newSession(e.localB, '文件在监听方');
    const big = makePng(3 * MiB, 204).buf;
    const held = e.relay!.holdAfter('s2c', e.relay!.bytes('s2c') + MiB);
    await seedImage(e.localB, e.dirB, sid, BIG_NAME, big);
    await held;
    await e.localB.call('control.pause');
    e.relay!.release();
    await waitFor('拨号方显示对方暂停', async () => {
      const i = await itemOf(e.localA, sid, BIG_NAME);
      return i?.state === 'pending' && i.reason === 'peer_paused';
    }, 8000);
    await expectNotComplete(e.dirA, e.localA, sid, BIG_NAME, big.length);
    await e.localB.call('control.resume');
    await arrived(e.dirA, sid, BIG_NAME, sha256Of(big), 15000);
    await ready(e.localA, sid, BIG_NAME);
  });

  it('传输中途取消配对（收端取消）：被扣住的那一块不被写下，没有完整文件；重新配对后续传完成', async () => {
    const { e, sid, big, sha, partSize } = await uploadHeld(205);
    await e.localB.call('remote.unpair', { peerFingerprint: await peerFpOf(e.localB) });
    e.relay!.release();
    await e.relay!.quiet(500);
    expect(partsIn(e.dirB).filter(p => p.name.endsWith('.part')).map(p => p.size)).toEqual([partSize]);
    await expectNotComplete(e.dirB, e.localB, sid, BIG_NAME, big.length);
    expect(sha256File(join(bucketOf(e.dirA, sid), BIG_NAME))).toBe(sha);       // 发端的桶不受影响
    await e.pair();
    await arrived(e.dirB, sid, BIG_NAME, sha, 20000);
    await ready(e.localB, sid, BIG_NAME);
  });

  it('传输中途取消配对（发端取消）：取消之后发端不再发出任何帧、不再重连；收端至多多一块，没有完整文件', async () => {
    const { e, sid, big, sha, partSize } = await uploadHeld(206);
    await e.localA.call('remote.unpair', { peerFingerprint: await peerFpOf(e.localA) });
    const frames = e.relay!.frames('c2s').length;
    const accepted = e.relay!.accepted();
    e.relay!.release();
    await e.relay!.quiet(500);
    // 被扣住的那一帧是发端取消之前发出的；收端没有取消配对、不会被通知，会照常写下它
    const after = partsIn(e.dirB).find(p => p.name.endsWith('.part'))?.size ?? 0;
    expect(after).toBeLessThanOrEqual(partSize + CHUNK);
    await e.relay!.quiet(700);
    expect(partsIn(e.dirB).find(p => p.name.endsWith('.part'))?.size ?? 0).toBe(after);
    await expectNotComplete(e.dirB, e.localB, sid, BIG_NAME, big.length);
    expect(e.relay!.frames('c2s').length).toBe(frames);
    expect(e.relay!.accepted()).toBe(accepted);
    expect(sha256File(join(bucketOf(e.dirA, sid), BIG_NAME))).toBe(sha);
    await e.pair();
    await arrived(e.dirB, sid, BIG_NAME, sha, 20000);
    await ready(e.localB, sid, BIG_NAME);
  });

  it('传输中关停再启动：重启后半截仍只是暂存，不被当成成品；重连后续传完成', async () => {
    const { e, sid, big, sha } = await uploadHeld(207);
    await e.closeB();
    // 转发器仍扣着 A→B：重启后的断言不与 A 的重连抢
    const localB = await e.restartB();
    await expectNotComplete(e.dirB, localB, sid, BIG_NAME, big.length);
    e.relay!.release();
    await arrived(e.dirB, sid, BIG_NAME, sha, 25000);
    await ready(e.localB, sid, BIG_NAME);
    expect(partsIn(e.dirB)).toEqual([]);
  });
});

describe('F11A 真引擎 × 真引擎：去重、重名、催促', () => {
  it('相同内容去重：两个会话引用同一份 2 MiB 内容，线路上只传一遍', async () => {
    const e = await boot({ dialer: 'A', relay: true });
    const data = makePng(2 * MiB, 301).buf; const sha = sha256Of(data);
    const s1 = await newSession(e.localA, '去重一'); const s2 = await newSession(e.localA, '去重二');
    const base = e.relay!.bytes('c2s');
    await seedImage(e.localA, e.dirA, s1, 'paste-1700000000002-bbbbbbbb.png', data);
    await arrived(e.dirB, s1, 'paste-1700000000002-bbbbbbbb.png', sha);
    await seedImage(e.localA, e.dirA, s2, 'paste-1700000000003-cccccccc.png', data);
    await arrived(e.dirB, s2, 'paste-1700000000003-cccccccc.png', sha);
    await ready(e.localB, s2, 'paste-1700000000003-cccccccc.png');
    for (const [root, sid, name] of [[e.dirA, s1, 'paste-1700000000002-bbbbbbbb.png'], [e.dirA, s2, 'paste-1700000000003-cccccccc.png'], [e.dirB, s1, 'paste-1700000000002-bbbbbbbb.png'], [e.dirB, s2, 'paste-1700000000003-cccccccc.png']] as const) {
      expect(sha256File(join(bucketOf(root, sid), name))).toBe(sha);
    }
    await e.relay!.quiet(300);
    const sent = e.relay!.bytes('c2s') - base;
    console.log(`[F11A dedupe] 两个会话各引用 ${data.length} 字节，A→B 共 ${sent} 字节`);
    expect(sent).toBeLessThan(2 * MiB * 1.4 * 1.25);
  });

  it('重名：两个会话各有一个同名、内容不同的附件，各自落在各自的桶里', async () => {
    const e = await boot({ dialer: 'A' });
    const one = makePng(200_000, 302).buf; const two = makePng(210_000, 303).buf;
    const s1 = await newSession(e.localA, '重名一'); const s2 = await newSession(e.localA, '重名二');
    const name = 'paste-1700000000004-dddddddd.png';
    await seedImage(e.localA, e.dirA, s1, name, one);
    await seedImage(e.localA, e.dirA, s2, name, two);
    await arrived(e.dirB, s1, name, sha256Of(one));
    await arrived(e.dirB, s2, name, sha256Of(two));
    expect(sha256File(join(bucketOf(e.dirB, s1), name))).not.toBe(sha256File(join(bucketOf(e.dirB, s2), name)));
  });

  it('监听方取消后重试：不经重连，拨号方在同一条连接上重发清单并传完', async () => {
    const { e, sid, big, sha } = await uploadHeld(304);
    await e.localB.call('attachments.cancel', { sessionId: sid, name: BIG_NAME });
    expect((await itemOf(e.localB, sid, BIG_NAME))?.state).toBe('held');
    e.relay!.release();
    // 让拨号方再发一轮清单并得到 rejected / held（这一轮不得被记成已收敛）
    await seedText(e.localA, sid, '再推一轮');
    await waitFor('监听方收到这条文本', async () =>
      JSON.stringify(await e.localB.call('chat.messages.list', { sessionId: sid })).includes('再推一轮'), 8000);
    await e.relay!.quiet(500);
    expect((await itemOf(e.localB, sid, BIG_NAME))?.state).toBe('held');
    expect(partsIn(e.dirB)).toEqual([]);                                       // 取消时暂存已删
    const accepted = e.relay!.accepted();
    expect(await e.localB.call('attachments.retry', { sessionId: sid, name: BIG_NAME })).toEqual({ ok: true, started: true });
    await arrived(e.dirB, sid, BIG_NAME, sha, 5000);
    await ready(e.localB, sid, BIG_NAME, 5000);
    expect(e.relay!.accepted()).toBe(accepted);                                // 没有经过重连
    expect(big.length).toBe(3 * MiB);
  });

  it('监听方的文件丢了：登记发现后自动催拨号方重传，不等重连', async () => {
    const e = await boot({ dialer: 'A', relay: true });
    const sid = await newSession(e.localA, '文件丢失');
    const data = makePng(300_000, 305).buf; const name = 'paste-1700000000005-eeeeeeee.png';
    await seedImage(e.localA, e.dirA, sid, name, data);
    await arrived(e.dirB, sid, name, sha256Of(data));
    await ready(e.localB, sid, name);
    await e.relay!.quiet(500);                                                 // 拨号方对这个会话已记收敛
    const accepted = e.relay!.accepted();
    rmSync(join(bucketOf(e.dirB, sid), name));
    await statusOf(e.localB, sid);                                             // 登记发现已登记的文件没了
    await arrived(e.dirB, sid, name, sha256Of(data), 5000);
    await ready(e.localB, sid, name, 5000);
    expect(e.relay!.accepted()).toBe(accepted);
  });
});

describe('F11A 真引擎 × 真引擎：链路上只有密文，没有别的连接', () => {
  /** 一段字节在 base64 里可能出现的三种对齐。 */
  function needles(marker: string, name: string): Buffer[] {
    const raw = Buffer.from(marker, 'latin1');
    const out = [raw, Buffer.from(name, 'latin1')];
    for (let k = 0; k < 3; k++) {
      const cut = raw.subarray(k);
      out.push(Buffer.from(cut.subarray(0, Math.floor(cut.length / 3) * 3).toString('base64'), 'latin1'));
    }
    return out;
  }
  const hit = (hay: Buffer, ns: Buffer[]): boolean => ns.some(n => hay.includes(n));

  it('上传与下载都搜不到文件的标记、标记的 base64、文件名；监听端口数不变；同一种搜法在明文连接上搜得到', async () => {
    const listening = (): number => ((process as any)._getActiveHandles() as any[])
      .filter(h => h?.constructor?.name === 'Server' && h.listening === true).length;
    const e = await boot({ dialer: 'A', relay: true });
    const before = listening();
    // 上传：文件在 A
    const up = makePng(600_000, 401); const upName = 'paste-1700000000006-ffffffff.png';
    const s1 = await newSession(e.localA, '抓包上传');
    await seedImage(e.localA, e.dirA, s1, upName, up.buf);
    await arrived(e.dirB, s1, upName, sha256Of(up.buf));
    // 下载：文件在 B
    const down = makePng(600_000, 402); const downName = 'paste-1700000000007-abababab.png';
    const s2 = await newSession(e.localB, '抓包下载');
    await seedImage(e.localB, e.dirB, s2, downName, down.buf);
    await arrived(e.dirA, s2, downName, sha256Of(down.buf));
    await e.relay!.quiet(300);

    const upNeedles = needles(up.marker, upName); const downNeedles = needles(down.marker, downName);
    // A→B：WebSocket 客户端的帧带随机掩码，先按 RFC 6455 解掩码再搜（否则搜不到只是掩码的结果，不是加密的证明）
    const c2s = e.relay!.frames('c2s');
    expect(c2s.length).toBeGreaterThan(3);
    for (const f of c2s) {
      expect(hit(f.payload, upNeedles)).toBe(false);
      if (f.payload.length > 4096) expect(f.opcode, '大帧必须是二进制的密文帧').toBe(2);
    }
    // B→A：服务端的帧不带掩码，直接在原始字节里搜
    expect(hit(e.relay!.raw('s2c'), downNeedles)).toBe(false);
    expect(hit(e.relay!.raw('s2c'), upNeedles)).toBe(false);
    expect(hit(e.relay!.raw('c2s'), downNeedles)).toBe(false);
    // 传输前后处于监听状态的服务器数量不变：没有另开下载端口
    expect(listening()).toBe(before);

    // 正向对照：经同一个转发器开一条明文的本机连接读同一个附件，同一种搜法搜得到
    const plain = await wsConnect(`ws://${e.relay!.host}:${e.relay!.port}/?token=${e.tokenB}`);
    cleanups.push(async () => plain.close());
    const r = await plain.call('attachments.read', { sessionId: s1, name: upName });
    expect(sha256Of(Buffer.from(r.base64, 'base64'))).toBe(sha256Of(up.buf));
    expect(hit(e.relay!.raw('s2c'), upNeedles)).toBe(true);
    expect(readFileSync(join(bucketOf(e.dirB, s1), upName)).includes(Buffer.from(up.marker, 'latin1'))).toBe(true);
  });
});
