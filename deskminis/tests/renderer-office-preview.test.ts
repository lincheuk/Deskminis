/**
 * U2 · Office 内容预览守卫（读 .vue 源码文本，与 renderer-* 先例一致）
 *
 * 守两件事，都是 OfficeCLI 那份源码里写着的教训：
 * ① **格式边界要诚实**——OOXML（.docx/.xlsx/.pptx）我们能解，legacy .doc/.xls/.ppt
 *    和 .pdf 是另一套二进制，不能路由给解析器假装能读（AionUi 曾把它们误路由给
 *    OfficeCLI，提示"装 officecli"但装了也没用）。
 * ② **能力边界要写在界面上**——我们做的是内容预览不是版式还原，不能让用户以为
 *    看到的就是最终版式。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string): string =>
  readFileSync(join(__dirname, '../src/renderer/src/ui/', p), 'utf8').replace(/\r\n/g, '\n');

const pane = read('PreviewPane.vue');
const view = read('OfficeView.vue');

describe('U2 — PreviewPane 路由', () => {
  it('OOXML 三格式走 office.read，不再落到「暂不内嵌渲染」卡', () => {
    expect(pane).toContain("rpc.call('office.read'");
    for (const e of ['docx', 'xlsx', 'xlsm', 'pptx']) expect(pane).toMatch(new RegExp(`isOoxml[\\s\\S]*'${e}'`));
    expect(pane).not.toContain('暂不内嵌渲染');
  });

  it('legacy .doc/.xls/.ppt 与 .pdf 仍走「明说不支持」分支，不路由给解析器', () => {
    // isLegacy 与 isOoxml 必须是两个独立判定——合成一个就会把老格式喂给解析器
    expect(pane).toMatch(/isLegacy\s*=\s*computed/);
    for (const e of ['doc', 'xls', 'ppt', 'pdf']) expect(pane).toMatch(new RegExp(`isLegacy[\\s\\S]*'${e}'`));
    // 且 legacy 名单里不能混进 OOXML——混进去就等于把能读的格式也说成读不了
    const legacyLine = /const isLegacy[\s\S]*?\n/.exec(pane)?.[0] ?? '';
    expect(legacyLine).not.toContain('docx');
    expect(legacyLine).not.toContain('pptx');
  });

  it('OOXML 读失败时给出错误文案，不是空白', () => {
    expect(pane).toContain('officeFailed');
  });
});

describe('U2 — OfficeView 渲染', () => {
  it('三种 kind 各有渲染分支', () => {
    expect(view).toMatch(/kind\s*===\s*'docx'/);
    expect(view).toMatch(/kind\s*===\s*'xlsx'/);
    expect(view).toMatch(/kind\s*===\s*'pptx'/);
  });

  it('docx 分支区分 heading / para / table 三种块', () => {
    expect(view).toMatch(/'heading'/);
    expect(view).toMatch(/'para'/);
    expect(view).toMatch(/'table'/);
  });

  it('界面上写明「内容预览 ≠ 版式还原」的边界', () => {
    expect(view).toContain('内容预览');
    expect(view).toMatch(/版式/);
    // 并给出出路：要看最终版式就用系统 Office 打开
    expect(view).toMatch(/Office\s*(应用|打开)|系统 Office/);
  });

  it('不用 v-html 渲染文档文本（文本来自任意文件，XSS 红线）', () => {
    // 只禁真正的绑定语法（注释里写「禁 v-html」不算违规）
    expect(view).not.toMatch(/v-html\s*=/);
  });
});
