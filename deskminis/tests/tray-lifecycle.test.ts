import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 静态托盘生命周期守卫：不启动 Electron，只读源文本 + 图标文件。
// 背景：托盘常驻是「关窗不杀 minisd」的载体（设计 §7）。M1 的 window-all-closed 直接
// minisd.kill() + app.quit()——改成托盘常驻时漏掉任何一环（close 未拦截 / 菜单没有真退出
// 路径 / 旧的 window-all-closed 杀进程逻辑被留下），typecheck 和 build 都不会红，只在用户
// 手上表现为「关窗后 agent 死了」或「托盘退不出」。这类漂移只有源文本守卫挡得住。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8');

describe('托盘生命周期（源文本守卫）', () => {
  it('拦截 close：默认关窗改为隐藏（关窗不杀 minisd 的根基）', () => {
    expect(/\.on\(\s*['"]close['"]/.test(mainSrc),
      '主窗口必须注册 close 处理器——不拦截的话 × 直接销毁窗口并触发 window-all-closed').toBe(true);
    expect(/preventDefault\(\)/.test(mainSrc),
      'close 处理器必须 preventDefault()  veto 默认关闭，否则窗口照样销毁').toBe(true);
    expect(/\.hide\(\)/.test(mainSrc),
      'close 处理器必须 hide() 窗口——「关窗 = 隐藏到托盘」').toBe(true);
  });

  it('创建托盘与菜单：显示主窗口 + 切换右栏 + 打开设置 + 退出四项', () => {
    expect(/new Tray\(/.test(mainSrc)).toBe(true);
    expect(/Menu\.buildFromTemplate\(/.test(mainSrc)).toBe(true);
    expect(mainSrc).toContain('显示主窗口');
    expect(mainSrc).toContain('切换右栏');
    expect(mainSrc).toContain('打开设置');
    expect(mainSrc).toContain('退出 DeskMinis');
  });

  it('存在真退出路径：quitting 标志 + before-quit 杀 minisd（close 拦截不能变成永远退不出）', () => {
    expect(/quitting\s*=\s*true/.test(mainSrc),
      '必须有 quitting 标志：托盘菜单退出时置真，close 处理器对它放行默认关闭').toBe(true);
    expect(/before-quit/.test(mainSrc),
      '必须在 before-quit 里回收 minisd——托盘菜单只 app.quit() 时，子进程靠这里杀掉').toBe(true);
    const bStart = mainSrc.indexOf("before-quit'");
    expect(bStart).toBeGreaterThan(-1);
    const bOpener = mainSrc.indexOf('{', bStart);
    let bDepth = 1; let bEnd = bOpener + 1;
    for (; bEnd < mainSrc.length && bDepth > 0; bEnd++) {
      if (mainSrc[bEnd] === '{') bDepth++;
      else if (mainSrc[bEnd] === '}') bDepth--;
    }
    const bBody = mainSrc.slice(bOpener + 1, bEnd - 1);
    expect(/minisd\?\.kill\(\)/.test(bBody),
      'before-quit 必须 minisd?.kill()——否则托盘退出后 minisd 成孤儿进程，还占着 minis.db').toBe(true);
  });

  it('window-all-closed 不再杀 minisd / 退出（M1 行为必须移除）', () => {
    // 精确范围：取 app.on('window-all-closed', () => { 到对应的闭合 });
    const start = mainSrc.indexOf("window-all-closed'");
    expect(start).toBeGreaterThan(-1);
    const opener = mainSrc.indexOf('{', start);
    let depth = 1; let end = opener + 1;
    for (; end < mainSrc.length && depth > 0; end++) {
      if (mainSrc[end] === '{') depth++;
      else if (mainSrc[end] === '}') depth--;
    }
    const body = mainSrc.slice(opener + 1, end - 1);
    expect(/app\.quit|minisd\?\.kill|minisd\.kill/.test(body),
      'window-all-closed 里仍有 quit/kill——托盘常驻下关窗不销毁窗口，但 darwin 上 Cmd+Q 之外' +
      '的路径（如多窗口场景全部关闭）会走这里把 agent 杀掉；它必须空转，退出只走托盘菜单').toBe(false);
  });

  it('托盘图标资源存在且有生成脚本（32×32 PNG 进 git，可复现可审查）', () => {
    const icon = join(repoRoot, 'resources', 'tray.png');
    expect(existsSync(icon), 'resources/tray.png 缺失——先跑 npm run gen:tray-icon 并把它提交进 git').toBe(true);
    expect(statSync(icon).size).toBeGreaterThan(0);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['gen:tray-icon'],
      'package.json 必须有 "gen:tray-icon" 脚本——图标要能一键复现，不能是某台机器上的手工产物').toContain('gen-tray-icon');
  });
});
