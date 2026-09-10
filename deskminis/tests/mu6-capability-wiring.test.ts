/** 能力入口清单（T6e-3 改写；前身是 MU6 的「能力接线守卫」）。
 *
 *  **本文件是全库唯一守「后端能力必须有 UI 入口」的地方。**
 *  MU6 立项时数过：`src/minisd` 注册 45 个方法，24 个渲染端零引用，其中 17 个是真缺入口。
 *  MU6 接了三组（会话操作 / 技能管理 / 同步控制），T 波换壳时**又掉了一批**——
 *  1917 例全绿、typecheck 0，没有任何守卫响，因为旧守卫锚在旧组件上、
 *  旧组件还在，红不了。这正是「有守卫 ≠ 有覆盖」。
 *
 *  ## 手法：双向绊线
 *
 *  - **已接的能力** → 断言 `ui/` 下确实有入口。退化（换壳、重构时漏搬）立刻红。
 *  - **已知缺口** → 断言 ① store action 与 minisd 注册项都还在（能力没从后端悄悄消失）、
 *    ② `ui/` 下确实**零引用**。
 *    ②看着别扭，是故意的：谁哪天把入口补上，这条会红，**逼他回来把这一项挪进「已接」组**。
 *    与本项目六处 `user_version` 钉同一手法——用一次强制的红，换一份不会烂掉的账。
 *    今天全绿；两个方向的漂移都会响。
 *
 *  ## 缺口不是 bug，是记在账上的债
 *
 *  用户 2026-09-10 裁定：换壳遗失的入口里**只补工作区**，其余入候选池。
 *  所以下面 GAPS 里的每一条都是**已知且已被接受**的现状，不是新发现的问题。
 *  README 对应行已按 🟡 体例标注（T6c）。
 *
 *  ⚠️ 手法边界（MU5 起反复重申）：源码文本守卫只能证明「调用写出来了」，
 *  证明不了「点下去后端真的收到了」。运行态实测不可被本文件替代。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const store = read('src/renderer/src/stores/chat.ts');
const minisd = read('src/minisd/index.ts');

/** 递归收集 ui/ 下所有源文件正文——入口在哪个组件里无所谓，有没有才是重点。 */
function uiTree(): string {
  const base = path.join(root, 'src/renderer/src/ui');
  const out: string[] = [];
  (function walk(d: string): void {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, 'utf8'));
    }
  })(base);
  return out.join('\n');
}
const ui = uiTree();

/** 「调用了」而不是「提到了」。
 *  ⚠️ 初版写的是 `ui.includes(action)`，自检时（故意把 `chat.setWorkspace` 改名）**没有变红**——
 *  因为同文件的注释里还写着「setWorkspace 会带着空 sessionId 发出去」，裸字符串照样命中。
 *  一个能被注释喂饱的守卫等于没有守卫，这正是本文件开头那句「有守卫 ≠ 有覆盖」。
 *  改成认调用形态 `.action(`：注释里的散文提及不算数。 */
const calls = (src: string, action: string): boolean =>
  new RegExp(`\\.${action}\\s*\\(`).test(src);

interface Cap { name: string; action: string; rpc: string; where?: string; since?: string }

/** 有 UI 入口的能力。`where` 只作说明，断言不锚具体文件——入口搬家不该红。 */
const WIRED: Cap[] = [
  { name: '技能启停', action: 'setSkillEnabled', rpc: 'skills.setEnabled', where: 'settings/SecSkills.vue' },
  { name: '技能删除', action: 'deleteSkill', rpc: 'skills.delete', where: 'settings/SecSkills.vue' },
  { name: '技能目录导入', action: 'importSkillFolder', rpc: 'skills.import', where: 'settings/SecSkills.vue' },
  { name: '工作区绑定', action: 'setWorkspace', rpc: 'workspace.set', where: 'WorkspacePanel.vue' },
  { name: '工作区恢复默认', action: 'resetWorkspace', rpc: 'workspace.reset', where: 'WorkspacePanel.vue' },
  { name: '工作区目录选择器', action: 'pickWorkspaceFolder', rpc: 'workspace.get', where: 'WorkspacePanel.vue' },
  { name: 'MCP 服务器增删改', action: 'upsertMcpServer', rpc: 'mcp.servers.upsert', where: 'settings/SecMcp.vue' },
  { name: 'MCP 试连接', action: 'testMcpServer', rpc: 'mcp.servers.test', where: 'settings/SecMcp.vue' },
];

/** 后端通、store 通、**界面上够不着**。每条都注明是哪一波立的、哪一波弄丢的。 */
const GAPS: Cap[] = [
  { name: '删除会话', action: 'deleteSession', rpc: 'chat.sessions.delete', since: 'MU6 立，T 波换壳丢' },
  { name: '重命名会话', action: 'renameSession', rpc: 'chat.sessions.rename', since: 'B1 立，T 波换壳丢' },
  { name: '会话记忆开关', action: 'setSessionMemory', rpc: 'chat.sessions.setMemoryEnabled', since: 'MU6 立，T 波换壳丢' },
  { name: '会话绑定模型', action: 'setSessionModelBinding', rpc: 'chat.sessions.setModelBinding', since: 'J2 立，T 波换壳丢' },
  { name: '会话级禁用 MCP', action: 'setSessionMcpDisabled', rpc: 'chat.sessions.setMcpDisabled', since: 'L5 立，T 波换壳丢' },
  { name: '同步暂停/恢复', action: 'setSyncPaused', rpc: 'control.pause', since: 'M6 立，T 波换壳丢' },
];

describe('能力入口清单 · 已接的必须还在（退化即红）', () => {
  for (const c of WIRED) {
    it(`${c.name}：store action + RPC + ui/ 入口三者齐全`, () => {
      expect(store, `store 少了 ${c.action}`).toContain(c.action);
      expect(minisd, `minisd 没注册 ${c.rpc}`).toContain(`'${c.rpc}'`);
      // 只问「ui/ 树里有没有人调它」，不问在哪个文件——入口搬家是自由，消失不是
      expect(calls(ui, c.action), `${c.name} 的界面入口没了（原在 ${c.where}）`).toBe(true);
    });
  }
});

describe('能力入口清单 · 已知缺口（补上了就会红，红了请更新本清单）', () => {
  for (const c of GAPS) {
    it(`${c.name}：后端与 store 还在，但 ui/ 下零引用（${c.since}）`, () => {
      // 上半：能力别在补入口之前先被人当死代码清掉了
      expect(store, `store 的 ${c.action} 没了——补入口之前不该先删能力`).toContain(c.action);
      expect(minisd, `minisd 的 ${c.rpc} 没了`).toContain(`'${c.rpc}'`);
      // 下半：绊线。补上入口这条就红——**这是设计意图，不是坏了**。
      // 处理方式：把这一条从 GAPS 挪到 WIRED，顺手把 README 的 🟡 改回 ✅。
      expect(calls(ui, c.action), `${c.name} 已经有界面入口了 → 请把它移进 WIRED 并更新 README`).toBe(false);
    });
  }
});

describe('能力入口清单 · 换壳丢掉的界面能力（非 store action，单独记）', () => {
  it('消息锚点导航轨：L3 立的能力，T 波换壳后 ui/ 下零命中', () => {
    // 右缘一条按回合分布的锚点轨，点一下跳到那一回合。它不走 store action，
    // 是纯渲染侧能力（data-turn-id + 轨道组件），所以上面的清单钉不住它。
    // 同样是绊线：哪天做回来了这条会红，请连同 README「输入与导航」那行一起更新。
    expect(ui, '锚点轨回来了 → 请更新本例与 README').not.toContain('data-turn-id');
  });
});

describe('能力入口清单 · 换壳丢掉的字段级编辑（同样设绊线）', () => {
  it('助手 ↔ 技能绑定：store/后端的 skillIds 都在，新助手编辑器没有这个字段', () => {
    // J 波立的能力：助手可绑定若干技能（assistants.create/update 的 skillIds）。
    // 旧 AssistantSettings 用 allSkills 渲一组勾选框；新 ui/StageAssistants.vue 里「skill」零命中——
    // 字段在 store 接口里原样躺着，界面上填不了。
    expect(store).toMatch(/skillIds\?:\s*string\[\]/);
    expect(minisd).toContain("'assistants.update'");
    // 绊线：编辑器补上 skillIds 这条就红 → 挪进已接组，并把 README 助手那行改回 ✅
    expect(read('src/renderer/src/ui/StageAssistants.vue'), '助手编辑器有技能绑定了 → 请更新本清单').not.toMatch(/skillIds/);
  });
});

describe('本清单自守：别把清单写成一句空话', () => {
  it('两组都非空，且没有同一个 action 同时出现在两边', () => {
    expect(WIRED.length).toBeGreaterThan(0);
    expect(GAPS.length).toBeGreaterThan(0);
    const dup = WIRED.filter(w => GAPS.some(g => g.action === w.action)).map(w => w.action);
    expect(dup, `同一能力不能既算已接又算缺口: ${dup.join(', ')}`).toHaveLength(0);
  });
});
