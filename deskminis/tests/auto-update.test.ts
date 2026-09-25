/** 自动更新守卫（用户 2026-08-11 拍板：GitHub Releases 全自动 + 启动检查可关）。
 *
 *  立项理由：桌面应用没有自动更新，用户装了 0.1.1 就永远停在 0.1.1——
 *  每次发版等于要求所有人手动重装。这是「装完能跑但用起来会撞墙」那一类里最贵的一条。
 *
 *  三处刻意的设计，守卫逐条锚住：
 *  ① **dev 下不许检查**：electron-updater 在未打包的应用里会抛
 *     「Skip checkForUpdates because application is not packed」，
 *     不拦的话每次 npm run dev 都吐一条错误噪音，久了就没人看错误日志了。
 *  ② **可关，且开关归主进程管**：做检查的是主进程，配置若只存在渲染端的 localStorage，
 *     主进程启动时读不到——开关会形同虚设。
 *  ③ **默认不静默安装**：下载完只提示，重启时才装。Agent 应用可能正跑着长任务，
 *     自动重启会把用户的活干掉一半。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './strip-comments';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const main = read('src/main/index.ts');
const preload = read('src/preload/index.ts');
const builder = read('electron-builder.yml');
const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; version: string };
// T6e-3 重指：设置从模态变成舞台视图，「关于」独立成一节
const settings = read('src/renderer/src/ui/StageSettings.vue');
const about = read('src/renderer/src/ui/settings/SecAbout.vue');

describe('自动更新 · 装配（3 例）', () => {
  it('electron-updater 是运行时依赖，不是 devDependency', () => {
    // 它在主进程运行，进 devDependencies 的话打包产物里就没有，线上直接崩。
    expect(pkg.dependencies['electron-updater']).toBeTruthy();
  });

  it('electron-builder 配 publish: github——没有它 electron-updater 不知道去哪查', () => {
    expect(builder).toMatch(/publish:/);
    expect(builder).toMatch(/provider:\s*github/);
    expect(builder).toMatch(/owner:/);
    expect(builder).toMatch(/repo:/);
  });

  it('主进程接 autoUpdater，且**dev 下不检查**（app.isPackaged 守门）', () => {
    expect(main).toMatch(/from 'electron-updater'/);
    expect(main).toMatch(/autoUpdater/);
    // 命门：不拦的话 dev 每次启动都抛「application is not packed」，
    // 错误日志被噪音淹没后，真错误也就没人看了。
    expect(main).toMatch(/app\.isPackaged/);
  });
});

describe('自动更新 · 不打断正在跑的任务（2 例）', () => {
  it('关掉自动安装：下载完只提示，重启时才装', () => {
    // Agent 应用可能正跑着长任务，自动重启会把用户的活干掉一半。
    expect(main).toMatch(/autoUpdater\.autoInstallOnAppQuit\s*=|autoInstallOnAppQuit:/);
    expect(main).not.toMatch(/quitAndInstall\(\)\s*;?\s*\n(?![\s\S]{0,200}?(响应|用户|click|confirm))/);
  });

  it('检查失败必须吞掉而不是弹窗——没网/GitHub 挂了不该打扰用户', () => {
    // 更新检查是后台便利功能，失败是常态（离线、公司网、GitHub 限流）。
    expect(main).toMatch(/autoUpdater\.on\(\s*'error'/);
  });
});

describe('自动更新 · 开关归主进程（3 例）', () => {
  it('开关持久化在主进程侧，不是只存渲染端 localStorage', () => {
    // 做检查的是主进程，启动时渲染端可能还没挂载。配置只存 localStorage 的话
    // 主进程读不到，「关掉自动检查」这个开关就是摆设。
    expect(main).toMatch(/update-prefs\.json|updatePrefs/);
    expect(main).toMatch(/ipcMain\.handle\(\s*'update:/);
  });

  it('preload 对称暴露读写与手动检查三个通道', () => {
    expect(preload).toMatch(/update:getPrefs|getUpdatePrefs/);
    expect(preload).toMatch(/update:setEnabled|setUpdateEnabled/);
    expect(preload).toMatch(/update:check|checkForUpdates/);
  });

  it('设置里有「关于与更新」页：显示版本号 + 开关 + 手动检查', () => {
    // 顺带补上「看不到自己在跑哪个版本」这个缺口——用户报 bug 时第一句就是版本号。
    // 锚「有这一节且能进去」，不锚节的字面标签——叫「关于」还是「关于与更新」是文案自由
    expect(settings).toMatch(/k:\s*'about'/);
    expect(settings).toMatch(/'about'/);
    // 版本号要真的显示出来：用户报 bug 时第一句就是版本号
    expect(about).toMatch(/version/);
  });
});

// ── W2b-9：更新源改公开发布仓库、错误给人话、便携版不检查、托盘手动检查有回音 ──────────────
// 设计稿 §2「自动更新源」落定 github provider 指向公开仓库 lincheuk/deskminis-releases；
// 侦察 release.md「W2b-update」与 open_questions 第 1、10、12 条；cross.md S27。
// 源码守卫一律先剥注释再认调用形态（交接 §2 第 10 条）：注释里留着旧写法或散文不能把断言喂饱。
const mainCode = stripComments(main);
/** electron-builder.yml 去掉 # 注释：注释里写「以前是 Deskminis」不能让 repo 断言红，写「改成 deskminis-releases」也不能让它绿。 */
const builderCode = builder.replace(/(^|\s)#.*$/gm, '$1');
const aboutTpl = about.slice(about.indexOf('<template>'), about.lastIndexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '');
/** 用共用的 stripComments：它连行尾 // 也剥（整行注释之外，`disabled: '…', // portable: '…'` 这种行尾注释同样喂不饱断言），且保留 ://。 */
const aboutScript = stripComments(about.slice(about.indexOf('<script'), about.indexOf('</script>')));
/** SecAbout 的 STATUS_TEXT 对象字面量本身（类型注解 Record<string, string> 没有花括号，之后第一个「{」就是它）。 */
const statusText = balanced(aboutScript, aboutScript.search(/const STATUS_TEXT\b/), '{', '}');

/** 从 from 处之后第一个 open 字符起，按括号配平取到对应的 close 为止（含两端）。 */
function balanced(src: string, from: number, open: string, close: string): string {
  const s = src.indexOf(open, from);
  if (from < 0 || s < 0) return '';
  let depth = 0;
  for (let i = s; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(s, i + 1);
  }
  return '';
}
/** 函数体：签名之后第一个「{ 换行」才是函数体的开括号——返回类型里的 Promise<{ status: string; … }> 也有花括号，不能取第一个。 */
function fnBody(name: string): string {
  const at = mainCode.search(new RegExp(`function ${name}\\(`));
  if (at < 0) return '';
  const open = mainCode.slice(at).search(/\{[ \t]*\n/);
  return open < 0 ? '' : balanced(mainCode, at + open, '{', '}');
}

describe('W2b-9 · 更新源是公开发布仓库', () => {
  it('publish 段：github provider，owner lincheuk，repo deskminis-releases（不再是私仓 Deskminis）', () => {
    const pub = builderCode.slice(builderCode.search(/^publish:/m));
    expect(pub).toMatch(/^\s+provider:\s*github\s*$/m);
    expect(/^\s+owner:\s*(\S+)/m.exec(pub)?.[1]).toBe('lincheuk');
    expect(/^\s+repo:\s*(\S+)/m.exec(pub)?.[1]).toBe('deskminis-releases');
    // 私仓的 Release 资产要 token 才能下，装进用户机器的 feed 永远 404——0.1.1 就是这样一次更新都没收到
    expect(builderCode).not.toMatch(/^\s+repo:\s*Deskminis\s*$/m);
  });
});

describe('W2b-9 · 错误态给人话，原文只进 stderr', () => {
  it("autoUpdater.on('error') 的回调经 describeUpdateError( 转成中文，不再把 String(e.message) 塞进状态", () => {
    const cb = balanced(mainCode, mainCode.search(/autoUpdater\.on\(\s*'error'/), '(', ')');
    expect(cb, "找不到 autoUpdater.on('error' 调用").not.toBe('');
    expect(cb).toMatch(/error:\s*describeUpdateError\(/);
    expect(cb).toMatch(/process\.stderr\.write\(/);   // 原文不丢：写进 stderr，排查时还找得到
    expect(cb).not.toMatch(/error:\s*String\(/);
  });

  it('checkUpdates 的 catch 同样走 describeUpdateError(，不再 String(e)', () => {
    const body = fnBody('checkUpdates');
    expect(body, '找不到 function checkUpdates(').not.toBe('');
    const c = balanced(body, body.search(/catch\s*\(/), '{', '}');
    expect(c).toMatch(/error:\s*describeUpdateError\(/);
    expect(body).not.toMatch(/error:\s*String\(e\)/);
  });
});

describe('W2b-9 · 便携版不检查、不下载，状态为 portable', () => {
  it('checkUpdates 在 isPackaged 之后、「关掉自动检查」与真正 checkForUpdates 之前短路成 portable', () => {
    const body = fnBody('checkUpdates');
    const iPacked = body.search(/app\.isPackaged/);
    const iPortable = body.search(/if \(\s*isPortableBuild\(\s*process\.env\s*\)\s*\)/);
    const iDisabled = body.search(/readUpdatePrefs\(\)\.autoCheck/);
    const iCheck = body.search(/autoUpdater\.checkForUpdates\(/);
    expect(iPacked).toBeGreaterThan(-1);
    expect(iPortable).toBeGreaterThan(iPacked);
    expect(iDisabled).toBeGreaterThan(iPortable);
    expect(iCheck).toBeGreaterThan(iDisabled);
  });

  it('便携版那个 if 块自己就置 portable 并 return——只看这一块，别处的 return 不算数', () => {
    // 少了这个 return，便携版会落下去照样检查、照样下载 100MB 的安装包。
    // 第一版断言看的是「portable 赋值到 checkForUpdates 之间有没有 return updateState;」，
    // 中间 disabled 分支自己的 return 就把它喂饱了：删掉便携版的 return 测试照样全绿（W2b-9 审查变异 A）。
    const body = fnBody('checkUpdates');
    const iPortable = body.search(/if \(\s*isPortableBuild\(\s*process\.env\s*\)\s*\)/);
    expect(iPortable, '找不到 if (isPortableBuild(process.env))').toBeGreaterThan(-1);
    const block = balanced(body, iPortable, '{', '}');
    expect(block).toMatch(/^\{\s*updateState = \{\s*status:\s*'portable'\s*\};\s*return updateState;\s*\}$/);
  });
});

describe('W2b-9 · 托盘手动「检查更新…」给回执，自动检查维持静默', () => {
  it('托盘项调的函数先 checkUpdates(true)，再用非模态对话框（不挂父窗口）报告结果', () => {
    const item = /label:\s*'检查更新…',\s*click:\s*\(\)\s*=>\s*\{\s*void\s+(\w+)\(/.exec(mainCode);
    expect(item, '托盘「检查更新…」的 click 形态变了').not.toBeNull();
    const body = fnBody(item![1]);
    expect(body).toMatch(/await checkUpdates\(true\)/);
    // 第一个参数就是选项对象 → 不挂窗口 → 非模态：主窗口可能藏在托盘里，挂上去会把它拽出来还挡住对话
    expect(body).toMatch(/dialog\.showMessageBox\(manualCheckDialog\(/);
    expect(body.search(/await checkUpdates\(true\)/)).toBeLessThan(body.search(/dialog\.showMessageBox\(/));
  });

  it('checkUpdates 本身不弹框；启动时的自动检查仍是 checkUpdates(false)', () => {
    expect(fnBody('checkUpdates')).not.toMatch(/dialog\./);
    expect(mainCode).toMatch(/setTimeout\(\(\) => \{ void checkUpdates\(false\); \}/);
  });
});

describe('W2b-9 · 设置→关于的文案跟上新更新源', () => {
  it('删掉「仓库私有、检查会 404 是预期的」——feed 已经是公开仓库，这句话会让用户对真故障视而不见', () => {
    expect(about).not.toContain('私有');
    expect(about).not.toContain('404');
  });

  it('提示写明去哪查：GitHub 上的 lincheuk/deskminis-releases', () => {
    expect(aboutTpl).toMatch(/<span class="f-hint">[^<]*lincheuk\/deskminis-releases[^<]*<\/span>/);
  });

  // 下面两例只在 STATUS_TEXT 对象字面量里找（W2b-9 第二轮审查变异 M-A）：整段脚本里 checkNow 的 catch
  // 就写着 `{ status: 'error', error: … }`，在整段里认 `error:` 等于没认。
  it('portable 状态有文案：便携版不自动更新，去发布页下载', () => {
    expect(statusText, '找不到 const STATUS_TEXT = { … }').not.toBe('');
    expect(statusText).toMatch(/^\s*portable:\s*'便携版不自动更新[^'\n]*发布页[^'\n]*'/m);
  });

  it('error 状态的文案是「更新失败」，不是「检查失败」——下载阶段的失败（如校验不符）也落在 error', () => {
    expect(statusText).toMatch(/^\s*error:\s*'更新失败'/m);
    expect(statusText).not.toContain('检查失败');
  });
});
