/** I2 守卫：平面壳层（T6e-3 改写为反向锚，3 例）。
 *
 *  沿革：E2 把 taskbar/rail/wtabs 三处壳层玻璃化（--glass-thin + blur）；
 *  I 波按用户 2026-08-20 指令换向 AionUi 平面语言，玻璃/极光退场——那是对
 *  2026-08-10「苹果磨砂」要求的**覆盖性偏离**，当时已申报。本文件原有 6 例逐条
 *  锚那套令牌，钉的是「换向确实落到位了」。
 *
 *  T 波换掉了整套设计系统之后，那 6 条字面锚在新树里**全部零命中**——不是被违反，
 *  是它们描述的词汇整个不存在了。逐条重指没有对应物可指；静默退场又会把
 *  「壳层是平的」这条**裁定**一起丢掉（玻璃是做过、评估过、才拆掉的）。
 *  故改成反向锚：这套东西不许回来。反向锚是本文件的既有手法（原例 6 就是）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const UI_DIR = 'src/renderer/src/ui';

/** 取某个 class 选择器的规则块正文（守的是样式声明本身，不是渲染结果） */
function ruleBlock(src: string, selector: string): string {
  const m = src.match(new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\}`));
  if (!m) throw new Error(`找不到 ${selector} 规则块`);
  return m[1];
}
const count = (src: string, needle: string): number => src.split(needle).length - 1;

/** T6e-3 改写。原本六例逐条锚 I2「平面壳层」那套令牌——
 *  `--surface-1` / `--glass-thin|thick|ground` / `--aurora-ground` / `--glass-edge` /
 *  `--glow-accent`——在新树里**全部零命中**，`backdrop-filter` 同样零命中：
 *  T 波换掉了整套设计系统，这套词汇整个不存在了。
 *
 *  逐条重指没有意义（没有对应物），静默退场又会把「壳层是平的」这条裁定丢掉——
 *  当年是先做了玻璃拟物、再判定它不合适才拆掉的。所以改成**一条反向锚**：
 *  这套东西不许回来。反向锚本来就是本文件的既有手法（原例 6 锚的是旧 Appica 色值清零）。 */
describe('I2 平面壳层：玻璃拟物不许回魂（反向锚）', () => {
  const files = fs.readdirSync(path.join(root, UI_DIR), { withFileTypes: true })
    .flatMap(e => e.isDirectory()
      ? fs.readdirSync(path.join(root, UI_DIR, e.name)).map(n => path.join(UI_DIR, e.name, n))
      : [path.join(UI_DIR, e.name)]);
  const all = files.map(f => read(f)).join('\n');

  it('ui/ 全树无 backdrop-filter——磨砂是当年拆掉的东西，不是没做', () => {
    expect(all).not.toMatch(/backdrop-filter/);
  });

  it('玻璃/极光那套令牌一个都不许再出现', () => {
    for (const t of ['--glass-thin', '--glass-thick', '--glass-ground', '--glass-edge',
                     '--aurora-ground', '--glow-accent', '--surface-1']) {
      expect(all, `${t} 回魂了`).not.toContain(t);
    }
  });

  it('壳层底色走新令牌的实色通道，不靠半透明叠色', () => {
    const shell = read(`${UI_DIR}/AppShell.vue`);
    expect(shell).toMatch(/var\(--c-bg/);
    expect(shell).not.toMatch(/rgba\(255,\s*255,\s*255,\s*0\.\d/);
  });
});
