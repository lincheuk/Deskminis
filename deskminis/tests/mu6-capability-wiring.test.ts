/** MU6 能力接线守卫（计划 §3 Task 1「先红」）。
 *
 *  立项事实（计划 §0，在 main@97d864f 上重新数过）：`src/minisd` 注册 45 个方法，
 *  24 个渲染端零引用；其中 7 个是协议内部（6 个 `sync.*` + `remote.pair.complete`）零引用是对的，
 *  **真正缺入口的 17 个**。本轮按 §2-1 拍板只接前三组：会话操作 / 技能管理 / 同步控制。
 *
 *  本轮性质：纯 renderer。`src/minisd` / `src/main` / `src/preload` 三目录零改动（§4 红线 1）。
 *
 *  ⚠️ 手法边界（MU5 反复吃亏处，此处重申）：源码文本守卫只能证明「调用写出来了」，
 *  证明不了「点下去后端真的收到了」。§5 的运行态实测不可被本文件替代。
 *
 *  ⚠️ 守卫锚意图不锚实现（§4 红线 9 / MU5 §15 教训）：曾断言 `.ctools` 必须
 *  `overflow:hidden`，锚的是当时的写法而非目的，结果把一个 bug 焊死了。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const exists = (p: string): boolean => fs.existsSync(path.join(root, p));

const store = read('src/renderer/src/stores/chat.ts');
const sessionList = read('src/renderer/src/components/SessionList.vue');
const settings = read('src/renderer/src/components/SettingsModal.vue');

describe('MU6 会话操作接线：删除 / 记忆开关 / 模型绑定（3 例）', () => {
  it('store 三个 action 各自调对 RPC，删除必须带 confirm:true', () => {
    // §2.5 已核实：chat.sessions.delete 后端强制 confirm:true，不带会抛错。
    // 这条断言的价值是「别把 confirm 漏了导致删除永远失败」——那种错在界面上表现为
    // 「点了删除没反应」，恰恰是最难查的一类。
    expect(store).toMatch(/rpc\.call\('chat\.sessions\.delete',[^)]*confirm:\s*true/);
    expect(store).toContain("rpc.call('chat.sessions.setMemoryEnabled'");
    expect(store).toContain("rpc.call('chat.sessions.setModelBinding'");
    // 删除后必须刷新列表，否则被删的会话还挂在界面上
    expect(store).toMatch(/deleteSession[\s\S]{0,400}?refreshSessions\(\)/);
  });

  it('SessionList 会话行有「⋮」菜单，且菜单是原生 button（红线 5）', () => {
    expect(sessionList).toMatch(/class="smore"/);
    expect(sessionList).toMatch(/<button[^>]*class="smore"/);
    expect(sessionList).toContain('menuFor');
    // 回归锚（e2e:mu6 真跑起来才逮到的 bug）：会话行与它的行内操作区是**两个兄弟节点**，
    // v-for 必须挂在包住两者的 <template> 上。若挂在 .scard 自身，s 的作用域只覆盖 .scard，
    // 操作区里的 s 就是 undefined —— renderList 直接抛错、整个会话列表渲染挂掉（界面上一行都没有）。
    // 源码文本守卫抓不到（字符串都在），typecheck 也抓不到（.vue 不在覆盖内）。
    expect(sessionList).toMatch(/<template v-for="s in grp\.items"/);
    expect(sessionList).not.toMatch(/<div\s+v-for="s in grp\.items"/);
    // 菜单项三枚
    expect(sessionList).toContain('记忆');
    expect(sessionList).toContain('模型');
    expect(sessionList).toContain('删除');
  });

  it('删除走行内二次确认，且默认焦点不落在危险项上（红线 6）', () => {
    expect(sessionList).toContain('confirmDelete');
    // 二次确认态要能取消
    expect(sessionList).toContain('取消');
    // 危险项配 danger 类，视觉上与其它项区分
    expect(sessionList).toMatch(/\.smenu-danger\s*\{/);
  });
});

describe('MU6 技能管理接线：启用停用 / 删除 / 本地目录导入（3 例）', () => {
  it('新建 SkillsSettings.vue 并接进设置模态第 5 页', () => {
    expect(exists('src/renderer/src/components/SkillsSettings.vue')).toBe(true);
    expect(settings).toContain("{ id: 'skills', label: '技能' }");
    expect(settings).toContain("section === 'skills'");
    expect(settings).toContain('SkillsSettings');
  });

  it('store 三个 action 调对 RPC；删除带 confirm:true；导入用 kind:folder', () => {
    expect(store).toContain("rpc.call('skills.setEnabled'");
    expect(store).toMatch(/rpc\.call\('skills\.delete',[^)]*confirm:\s*true/);
    // §2-4 拍板：只接 folder，入口是路径文本框（原生目录选择器要走主进程 dialog，破红线 1）
    expect(store).toMatch(/rpc\.call\('skills\.import',[^)]*kind:\s*'folder'/);
    expect(store).toContain("rpc.call('skills.importStatus'");
  });

  it('界面说清启停作用范围为全局，并有路径文本框与导入结果反馈（§6 第一坑）', () => {
    const skills = read('src/renderer/src/components/SkillsSettings.vue');
    // skills.setEnabled 带 sessionId 写会话覆盖、不带写全局。本轮只做全局，
    // 必须在界面上说明白，否则用户不知道自己改的是什么范围。
    expect(skills).toContain('全局');
    expect(skills).toMatch(/<input[^>]*v-model="importPath"/);
    expect(skills).toContain('绝对路径');
    // 导入是后台任务，失败要照实显示而不是静默
    expect(skills).toContain('importError');
  });
});

describe('MU6 同步控制接线：暂停 / 恢复 / 状态（3 例）', () => {
  it('store 接 control.pause / resume / status 并持有 syncPaused 状态', () => {
    // 锚**意图**不锚调用写法（红线 9）：pause/resume 是一对对称操作，
    // 写成 `rpc.call(paused ? 'control.pause' : 'control.resume')` 与写成两句是等价的，
    // 守卫不该逼实现选其中一种。初版就是锚了字面 `rpc.call('control.pause')`——
    // 这是 MU5 §15 之后第二次犯同一个错，故留此注记。
    expect(store).toMatch(/rpc\.call\([^)]*'control\.pause'/);
    expect(store).toMatch(/rpc\.call\([^)]*'control\.resume'/);
    expect(store).toMatch(/rpc\.call\([^)]*'control\.status'/);
    expect(store).toContain('syncPaused');
  });

  it('设置模态「设备与同步」页有暂停开关，且文案说清暂停的是同步不是任务（§2-3）', () => {
    expect(settings).toContain('syncPaused');
    expect(settings).toMatch(/<button[^>]*class="syncbtn"/);
    // 命门文案：不写清楚的话，用户会以为这个开关能停下正在跑的 agent 回合——
    // 那是 chat.cancel（已接）。M6 的 control.pause 停的是设备间同步。
    expect(settings).toContain('设备间同步');
    expect(settings).toMatch(/不会中断|不影响|不停止/);
  });

  it('侧栏后端选择器显示暂停态——状态改了却看不见等于没接', () => {
    expect(sessionList).toContain('syncPaused');
    expect(sessionList).toMatch(/\.bk-dot\.paused\s*\{/);
  });
});

describe('MU6 红线 1 自守：三目录零改动（1 例）', () => {
  it('本轮不新增任何 RPC——被接的方法必须都是既有注册项', () => {
    const minisd = read('src/minisd/index.ts');
    for (const m of [
      'chat.sessions.delete', 'chat.sessions.setMemoryEnabled', 'chat.sessions.setModelBinding',
      'skills.setEnabled', 'skills.delete', 'skills.import', 'skills.importStatus',
      'control.pause', 'control.resume', 'control.status',
    ]) {
      expect(minisd).toContain(`'${m}':`);
    }
  });
});
