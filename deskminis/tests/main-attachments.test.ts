/** MU2b Task 6：main 侧附件落盘纯函数（src/main/attachments.ts）——node 直测不启动 Electron。
 *  attachmentPath：sessionId UUID 正则校验（minisd 同款）防路径逃逸；
 *  decodeImageDataUrl：data:image/*;base64 解码，坏 dataUrl 拒绝。 */
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { attachmentPath, contentTag, decodeImageDataUrl, extFromDataUrl } from '../src/main/attachments';
import { validateAttachmentName } from '../src/shared/attachments';

const VALID_ID = 'A47184C8-77FA-4D88-9981-6BDE73C87C4E';

describe('MU2b Task 6 main 附件：attachmentPath + decodeImageDataUrl（3 例）', () => {
  it('attachmentPath：合法 UUID → <root>/sessions/<id>/attachments/paste-<ts>.png', () => {
    const p = attachmentPath('/data/root', VALID_ID, 1722440000000);
    expect(p).toBe(join('/data/root', 'sessions', VALID_ID, 'attachments', 'paste-1722440000000.png'));
    // 小写 UUID 同样放行（正则 i 旗标，与 minisd 同款）
    expect(attachmentPath('/r', VALID_ID.toLowerCase(), 1)).toContain('paste-1.png');
  });

  it('attachmentPath：非法 sessionId（路径穿越/非 UUID/空）一律拒绝', () => {
    expect(() => attachmentPath('/r', '../../Windows', 1)).toThrow('非法 sessionId');
    expect(() => attachmentPath('/r', 'not-a-uuid', 1)).toThrow('非法 sessionId');
    expect(() => attachmentPath('/r', '', 1)).toThrow('非法 sessionId');
    expect(() => attachmentPath('/r', VALID_ID + '/../../etc', 1)).toThrow('非法 sessionId');
  });

  it('decodeImageDataUrl：合法 png/jpg 解码出字节；坏 dataUrl 拒绝', () => {
    // 'PNGDATA' 的 base64
    expect(decodeImageDataUrl('data:image/png;base64,UE5HREFUQQ==').toString()).toBe('PNGDATA');
    expect(decodeImageDataUrl('data:image/jpeg;base64,UE5HREFUQQ==').toString()).toBe('PNGDATA');
    // 非 data: 前缀 / 非图片类型 / 空内容 → 拒绝
    expect(() => decodeImageDataUrl('hello world')).toThrow();
    expect(() => decodeImageDataUrl('data:text/html;base64,PGI+')).toThrow();
    expect(() => decodeImageDataUrl('')).toThrow();
  });
});

/** F2a：降采样后 jpeg/webp 导出的字节不能再一律落 .png——mimeFromPath 会把
 *  image/png 报给 provider 而实际字节是 jpeg（Anthropic 对 media_type 与字节
 *  不符会 400）。扩展名必须随 dataUrl 的 mime 走。 */
describe('F2a main 附件：扩展名随导出格式', () => {
  it('extFromDataUrl：四类 mime → png/jpg/gif/webp；未知 mime 拒绝（undefined）', () => {
    expect(extFromDataUrl('data:image/png;base64,UE5H')).toBe('png');
    expect(extFromDataUrl('data:image/jpeg;base64,UE5H')).toBe('jpg');
    expect(extFromDataUrl('data:image/gif;base64,UE5H')).toBe('gif');
    expect(extFromDataUrl('data:image/webp;base64,UE5H')).toBe('webp');
    expect(extFromDataUrl('data:image/bmp;base64,UE5H')).toBeUndefined();
    expect(extFromDataUrl('garbage')).toBeUndefined();
  });

  it('attachmentPath 带 ext：jpeg 导出落 paste-<ts>.jpg；缺省仍 .png（向后兼容）', () => {
    expect(attachmentPath('/r', VALID_ID, 1722440000000, 'jpg'))
      .toBe(join('/r', 'sessions', VALID_ID, 'attachments', 'paste-1722440000000.jpg'));
    expect(attachmentPath('/r', VALID_ID, 1)).toContain('paste-1.png');
    // ext 白名单外一律拒绝（防 'jpg/../../x' 之类借 ext 逃逸桶）
    expect(() => attachmentPath('/r', VALID_ID, 1, 'txt')).toThrow('非法扩展名');
    expect(() => attachmentPath('/r', VALID_ID, 1, '../png')).toThrow('非法扩展名');
    expect(() => attachmentPath('/r', VALID_ID, 1, '')).toThrow('非法扩展名');
  });
});

describe('F11A：来源侧文件名带内容哈希前缀', () => {
  it('带 tag 的名字是 paste-<ts>-<tag>.<ext>；不带时与以前逐字相同', () => {
    expect(attachmentPath('/r', VALID_ID, 1722440000000, 'png', '0a1b2c3d'))
      .toBe(join('/r', 'sessions', VALID_ID, 'attachments', 'paste-1722440000000-0a1b2c3d.png'));
    expect(attachmentPath('/r', VALID_ID, 1722440000000, 'jpg', 'ffffffff'))
      .toBe(join('/r', 'sessions', VALID_ID, 'attachments', 'paste-1722440000000-ffffffff.jpg'));
    expect(attachmentPath('/r', VALID_ID, 1722440000000, 'png'))
      .toBe(join('/r', 'sessions', VALID_ID, 'attachments', 'paste-1722440000000.png'));
    expect(attachmentPath('/r', VALID_ID, 1722440000000, 'png', undefined))
      .toBe(join('/r', 'sessions', VALID_ID, 'attachments', 'paste-1722440000000.png'));
  });

  it('非法 tag 抛错（不是 8 位小写十六进制的一律拒，防借 tag 逃出附件桶）', () => {
    for (const bad of ['', 'ABCDEF12', '1234567', '123456789', '../../ab', 'zzzzzzzz', '0a1b2c3/']) {
      expect(() => attachmentPath('/r', VALID_ID, 1, 'png', bad), bad).toThrow('非法标签');
    }
  });

  it('contentTag 是字节 sha256 的前 8 位；同内容同标签、不同内容不同标签；新旧名字都过附件名校验与 chat.prompt 的白名单', () => {
    const a = Buffer.from('同一份内容'); const b = Buffer.from('另一份内容');
    expect(contentTag(a)).toBe(createHash('sha256').update(a).digest('hex').slice(0, 8));
    expect(contentTag(a)).toBe(contentTag(Buffer.from('同一份内容')));
    expect(contentTag(a)).not.toBe(contentTag(b));
    // 与 minisd/index.ts 的 ATTACHMENT_REL_RE 同一个式子（那边没有导出）
    const REL_RE = /^attachments\/[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp)$/i;
    for (const name of [`paste-1722440000000-${contentTag(a)}.png`, 'paste-1722440000000.png', `paste-1-${contentTag(b)}.webp`]) {
      expect(validateAttachmentName(name)).toBe(name);
      expect(REL_RE.test(`attachments/${name}`)).toBe(true);
    }
  });
});

/** 变异核对补的一组（work/logs/F11A-mutation.json 的 M70）：上面钉的是两个纯函数；处理体不把标签传给 attachmentPath、
 *  照旧返回 paste-<ts>.<ext>，这些用例与 main-app-dirs-wiring 的守卫全都照样是绿的——名字又回到「不带内容」，
 *  两台设备在同一会话里就能各出一个同名异内容的文件。
 *  main/index.ts 一 import 就要 Electron，没法整个加载；处理体只依赖下面几样东西，按源码取出来、喂真实现真跑。 */
describe('F11A：attachments:save 把内容标签接进落盘的文件名（取出 main/index.ts 的处理体真跑）', () => {
  // typescript 是 export = 形态，tsconfig 没开 esModuleInterop，用 require 取（同 tests/sfc-setup.ts）
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

  function loadSaveHandler(dataRoot: string): (e: unknown, sessionId: unknown, dataUrl: unknown) => string {
    const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const anchor = "ipcMain.handle('attachments:save',";
    const at = main.indexOf(anchor);
    expect(at, 'main/index.ts 里找不到 attachments:save 处理器').toBeGreaterThanOrEqual(0);
    // 处理器是第二个实参：从形参表起，到函数体配对的右花括号止
    const open = main.indexOf('{', main.indexOf('=>', at));
    let depth = 1; let i = open + 1;
    for (; i < main.length && depth > 0; i++) {
      if (main[i] === '{') depth++;
      else if (main[i] === '}') depth--;
    }
    const js = ts.transpileModule(`module.exports = ${main.slice(at + anchor.length, i)};`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod: { exports: unknown } = { exports: undefined };
    // 处理体用到的自由标识符就是这几个；以后多用一个，这里会以 ReferenceError 红，补进来即可
    new Function('module', 'attachmentPath', 'contentTag', 'decodeImageDataUrl', 'extFromDataUrl', 'mkdirSync', 'writeFileSync', 'dirname', 'dirs', js)(
      mod, attachmentPath, contentTag, decodeImageDataUrl, extFromDataUrl, mkdirSync, writeFileSync, dirname, { dataRoot },
    );
    return mod.exports as (e: unknown, sessionId: unknown, dataUrl: unknown) => string;
  }

  it('返回的相对路径与落盘的文件是同一个名字 paste-<ts>-<字节 sha256 前 8 位>.<ext>，内容就是解码出的字节', () => {
    const root = mkdtempSync(join(tmpdir(), 'f11a-save-'));
    try {
      const save = loadSaveHandler(root);
      const bucket = join(root, 'sessions', VALID_ID, 'attachments');
      const png = Buffer.from('一张图的字节');
      const rel = save(undefined, VALID_ID, `data:image/png;base64,${png.toString('base64')}`);
      const tag = createHash('sha256').update(png).digest('hex').slice(0, 8);
      expect(rel).toMatch(new RegExp(`^attachments/paste-\\d+-${tag}\\.png$`));
      const name = rel.slice('attachments/'.length);
      expect(validateAttachmentName(name)).toBe(name);
      expect(readdirSync(bucket)).toEqual([name]);
      expect(readFileSync(join(bucket, name)).equals(png)).toBe(true);

      // 另一份内容、另一种格式：标签随内容变，扩展名随 dataUrl 的 mime 走
      const jpg = Buffer.from('另一张图的字节');
      const rel2 = save(undefined, VALID_ID, `data:image/jpeg;base64,${jpg.toString('base64')}`);
      const tag2 = createHash('sha256').update(jpg).digest('hex').slice(0, 8);
      expect(tag2).not.toBe(tag);
      expect(rel2).toMatch(new RegExp(`^attachments/paste-\\d+-${tag2}\\.jpg$`));
      expect(readFileSync(join(bucket, rel2.slice('attachments/'.length))).equals(jpg)).toBe(true);
      expect(readdirSync(bucket).sort()).toEqual([name, rel2.slice('attachments/'.length)].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('非法入参照旧拒绝，什么都不落盘', () => {
    const root = mkdtempSync(join(tmpdir(), 'f11a-save-'));
    try {
      const save = loadSaveHandler(root);
      expect(() => save(undefined, 1, 2)).toThrow('非法参数');
      expect(() => save(undefined, '../../Windows', 'data:image/png;base64,UE5H')).toThrow('非法 sessionId');
      expect(() => save(undefined, VALID_ID, 'data:text/html;base64,PGI+')).toThrow('非法图片 dataUrl');
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
