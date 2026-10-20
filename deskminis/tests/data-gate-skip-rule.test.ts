/** Q15：搜索跳过数据根的规则有了数据形态（遍历放进 worker，函数过不去）。
 *
 *  钉两件事：
 *  - dataRootSkipRule + matchesSkipRule 与原来的 dataRootSkipper 是同一个判定（后者现在就是前两者拼的）；
 *  - win32 规则下比较之前怎么折叠名字：小写、剥 ':' 起的流名、剥尾部的点和空格、剥完为空的段丢掉。
 *    这几步以前只在 dataRootSkipper 的闭包里，大小写以外的没有用例。 */
import { describe, it, expect } from 'vitest';
import { dataRootSkipRule, dataRootSkipper, matchesSkipRule, stripWin32Segment } from '../src/minisd/tools/data-gate';

const WIN = { platform: 'win32' as const, realpath: (p: string) => p };
const LIN = { platform: 'linux' as const, realpath: (p: string) => p };

describe('Q15 dataRootSkipRule：规则里有什么', () => {
  it('win32：target 是数据根相对基准的路径，已经小写；win 为真', () => {
    expect(dataRootSkipRule('C:\\Users\\me', 'C:\\Users\\me\\AppData\\Roaming\\DeskMinis', WIN)).toEqual({ target: 'appdata/roaming/deskminis', win: true });
    expect(dataRootSkipRule('c:\\users\\ME', 'C:\\Users\\me\\AppData\\Roaming\\DeskMinis', WIN)).toEqual({ target: 'appdata/roaming/deskminis', win: true });
  });
  it('其它平台：target 原样，win 为假', () => {
    expect(dataRootSkipRule('/home/me', '/home/me/.config/DeskMinis', LIN)).toEqual({ target: '.config/DeskMinis', win: false });
  });
  it('数据根不在基准之下、或基准就是数据根：没有规则', () => {
    expect(dataRootSkipRule('/r/sessions/S1/workspace', '/r', LIN)).toBeUndefined();
    expect(dataRootSkipRule('/r', '/r', LIN)).toBeUndefined();
    expect(dataRootSkipRule('/elsewhere', '/r', LIN)).toBeUndefined();
    expect(dataRootSkipRule('D:\\work', 'C:\\Users\\me\\AppData\\Roaming\\DeskMinis', WIN)).toBeUndefined();
  });
});

describe('Q15 matchesSkipRule：win32 规则下名字折叠之后再比', () => {
  const rule = { target: 'appdata/roaming/deskminis', win: true };
  const hit = (rel: string): boolean => matchesSkipRule(rule, rel, stripWin32Segment);

  it('大小写不影响', () => {
    expect(hit('AppData/Roaming/DeskMinis')).toBe(true);
    expect(hit('APPDATA/ROAMING/DESKMINIS')).toBe(true);
  });
  it('尾部的点和空格不影响（Win32 打开 DeskMinis. 得到的就是 DeskMinis）', () => {
    expect(hit('AppData/Roaming/DeskMinis.')).toBe(true);
    expect(hit('AppData/Roaming/DeskMinis ')).toBe(true);
    expect(hit('AppData./Roaming . /DeskMinis...')).toBe(true);
  });
  it('流名不影响（DeskMinis::$DATA 就是 DeskMinis 本体）', () => {
    expect(hit('AppData/Roaming/DeskMinis::$DATA')).toBe(true);
    expect(hit('AppData:x/Roaming/DeskMinis')).toBe(true);
  });
  it('剥完为空的段丢掉（全是点或空格的一段不改变指向）', () => {
    expect(hit('AppData/. ./Roaming/DeskMinis')).toBe(true);
    expect(hit('AppData//Roaming/DeskMinis')).toBe(true);
    expect(hit('.../AppData/Roaming/DeskMinis')).toBe(true);
  });
  it('近似名、上一级、下一级都不是', () => {
    for (const rel of ['AppData/Roaming', 'AppData/Roaming/DeskMinis-dev', 'AppData/Roaming/DeskMinis/skills', 'AppData/Roaming/XDeskMinis', 'Roaming/DeskMinis', '']) expect(hit(rel), rel).toBe(false);
  });
});

describe('Q15 matchesSkipRule：非 win32 规则逐字比', () => {
  const rule = { target: '.config/DeskMinis', win: false };
  const hit = (rel: string): boolean => matchesSkipRule(rule, rel, stripWin32Segment);
  it('只有一模一样才算', () => {
    expect(hit('.config/DeskMinis')).toBe(true);
    for (const rel of ['.config/deskminis', '.config/DeskMinis.', '.config/DeskMinis ', '.config//DeskMinis', '.config/DeskMinis:x', '.config']) expect(hit(rel), rel).toBe(false);
  });
});

describe('Q15 dataRootSkipper 就是「规则 + 判定」', () => {
  it.each([
    ['win32', 'C:\\Users\\me', 'C:\\Users\\me\\AppData\\Roaming\\DeskMinis', WIN],
    ['linux', '/home/me', '/home/me/.config/DeskMinis', LIN],
  ] as const)('%s：对一批相对路径，两种写法的结论逐个相同', (_name, base, root, opts) => {
    const skip = dataRootSkipper(base, root, opts)!;
    const rule = dataRootSkipRule(base, root, opts)!;
    const rels = ['AppData/Roaming/DeskMinis', 'appdata/roaming/deskminis', 'AppData/Roaming/DeskMinis.', 'AppData/Roaming/DeskMinis::$DATA', 'AppData/. /Roaming/DeskMinis',
      'AppData/Roaming', 'AppData/Roaming/DeskMinis-dev', '.config/DeskMinis', '.config/deskminis', '.config/DeskMinis.', '.config', 'x', ''];
    expect(rels.map(r => skip(r))).toEqual(rels.map(r => matchesSkipRule(rule, r, stripWin32Segment)));
    // 这批里确实两种结论都有，不然上面那行什么都没钉住
    expect(new Set(rels.map(r => skip(r))).size).toBe(2);
  });
});
