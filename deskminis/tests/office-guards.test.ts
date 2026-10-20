/** F10A · T11：Office 代码的边界守卫（去掉注释后扫源码）。
 *
 *  三条边界靠它钉住，口头约定守不住：
 *  1. **格式之间互不相干**：F10B 只改 office/xlsx/*、F10C 只改 office/pptx/*。格式代码不许回流到共享文件
 *     （office/build.ts、office/parse.ts、tools/office.ts），三个格式目录之间不许互相引用。
 *  2. **产品运行时不启动 Office、处理器不碰文件**：office/** 里不出现子进程、PowerShell、Word 的可执行文件名，
 *     不引 node:fs，不带调度声明——所以处理器拿不到落盘与权限的入口，权限调用方名单也不用为它改。
 *  3. **没经真实程序的不能说成已核验**：`status: 'verified'` 的字面量只出现在 shared/office-verification.ts 的构造函数里，
 *     别处伪造不出「已核验」。Word 生成器不读时钟、不取随机数、不读环境（同输入同字节）。 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', 'src');
const OFFICE = join(SRC, 'minisd', 'office');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|vue)$/.test(name)) out.push(p);
  }
  return out;
}
/** 去掉块注释与行注释。`://` 不算行注释（命名空间网址里有）。 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const rel = (file: string): string => relative(SRC, file).split(sep).join('/');
const officeFiles = walk(OFFICE);
const toolFile = join(SRC, 'minisd', 'tools', 'office.ts');

describe('T11 格式代码不回流到共享文件', () => {
  it('office/build.ts、office/parse.ts 只剩转出口与分派：里面没有任何一种格式的 XML 字面量', () => {
    for (const name of ['build.ts', 'parse.ts']) {
      const text = code(join(OFFICE, name));
      for (const needle of ['<w:', '<p:', '<a:', '<sheetData', '<worksheet', '<Types', '<Relationship']) expect(text, `${name} 里出现了 ${needle}`).not.toContain(needle);
    }
  });

  it('三个格式目录互不引用（docx / xlsx / pptx 各自只引共享的 xml、zip、format、parse 与 shared）', () => {
    const dirs = ['docx', 'xlsx', 'pptx'];
    for (const file of officeFiles) {
      const own = dirs.find(d => rel(file).startsWith(`minisd/office/${d}/`));
      if (!own) continue;
      const text = code(file);
      for (const other of dirs.filter(d => d !== own)) {
        expect(text, `${rel(file)} 引用了 ${other}/`).not.toMatch(new RegExp(`from\\s+['"][^'"]*/${other}/`));
      }
    }
    // 每个格式目录都有自己的三件套
    for (const d of dirs) for (const f of ['build.ts', 'parse.ts', 'handler.ts']) expect(officeFiles.map(rel)).toContain(`minisd/office/${d}/${f}`);
  });

  it('tools/office.ts 不认识任何一种格式的输入长什么样（没有 blocks / sheets / slides 字样）', () => {
    const text = code(toolFile);
    for (const word of ['blocks', 'sheets', 'slides']) expect(text, `tools/office.ts 里出现了 ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`));
  });
});

describe('T11 产品运行时不启动 Office；处理器是不碰文件的纯代码', () => {
  it('office/** 与 tools/office.ts：没有子进程、PowerShell、Word 的可执行文件名', () => {
    for (const file of [...officeFiles, toolFile]) {
      const text = code(file);
      expect(text, rel(file)).not.toMatch(/child_process/);
      expect(text, rel(file)).not.toMatch(/powershell/i);
      expect(text, rel(file)).not.toMatch(/WINWORD|EXCEL\.EXE|POWERPNT/i);
      expect(text, rel(file)).not.toMatch(/\bspawn\b|\bexecFile\b|\bexecSync\b/);
    }
  });

  it('office/**：不引 node:fs，不带调度声明（落盘与权限只在 tools/office.ts）', () => {
    for (const file of officeFiles) {
      const text = code(file);
      expect(text, rel(file)).not.toMatch(/['"](?:node:)?fs(?:\/promises)?['"]/);
      expect(text, rel(file)).not.toContain('sideEffects');
      expect(text, rel(file)).not.toMatch(/guardWrite|guardRead|askPermission/);
    }
  });

  it('office/docx/**：不读时钟、不取随机数、不读环境（同输入同字节）', () => {
    const docx = officeFiles.filter(f => rel(f).startsWith('minisd/office/docx/'));
    expect(docx.length).toBeGreaterThanOrEqual(8);
    for (const file of docx) {
      const text = code(file);
      expect(text, rel(file)).not.toMatch(/\bDate\b/);
      expect(text, rel(file)).not.toMatch(/Math\.random/);
      expect(text, rel(file)).not.toMatch(/process\.env/);
    }
  });
});

describe('T11 别处伪造不出「已核验」', () => {
  it("status: 'verified' 的字面量只出现在 shared/office-verification.ts", () => {
    const hits = walk(SRC).filter(f => /status\s*:\s*['"]verified['"]/.test(code(f))).map(rel);
    expect(hits).toEqual(['shared/office-verification.ts']);
  });

  it('版式结论只能来自真实程序：office/** 里没有哪个文件自己拼「版式核验：通过」', () => {
    for (const file of [...officeFiles, toolFile]) expect(code(file), rel(file)).not.toMatch(/版式核验：通过/);
  });
});
