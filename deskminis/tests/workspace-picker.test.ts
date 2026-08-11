/** 工作区可选（用户 2026-08-11：「这个点不开，无法使用」）。
 *
 *  立项事实（动手前查实，不是听说）：
 *  ① 输入框那枚「工作区」chip 是 `<div class="cpill static">`——**纯装饰**，
 *     没有点击处理，连当前是哪个目录都不显示；
 *  ② `src/minisd` 里**没有任何 workspace.* RPC**，渲染端零引用；
 *  ③ 工作区 = `paths.sessionBucket(sessionId, 'workspace')`，即数据根里按 sessionId 分的桶，
 *     shell 的 cwd、终端启动目录、相对路径解析三处都指向它——**锁死，指不到真实项目目录**。
 *
 *  关键前提（决定这件事的性质）：`resolveGuestPath` 里**绝对 Windows 路径本就直接放行**，
 *  agent 早就能读写宿主任意路径、由权限系统把关。所以沙箱桶是「默认工作目录」而非硬边界，
 *  让工作区可改**不是动安全模型**，是改默认 cwd。
 *
 *  用户 2026-08-11 两处拍板：作用范围 = **每会话各自设**（新会话继承上次用过的）；
 *  选目录 = **原生选择器 + 可粘贴路径框，两者都要**。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/minisd/store/db';
import { MinisPaths } from '../src/minisd/paths';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const db = read('src/minisd/store/db.ts');
const paths = read('src/minisd/paths.ts');
const minisd = read('src/minisd/index.ts');
const chatStore = read('src/minisd/store/chat-store.ts');
const shell = read('src/minisd/tools/shell.ts');
const terminal = read('src/minisd/terminal.ts');
const main = read('src/main/index.ts');
const preload = read('src/preload/index.ts');
const chatView = read('src/renderer/src/components/ChatView.vue');
const store = read('src/renderer/src/stores/chat.ts');

describe('工作区可选 · 存储层（3 例）', () => {
  it('迁移追加为新条目，绝不改动已发布的 MIGRATIONS[0..4]', () => {
    // db.ts 自己写着「迁移一经发布不可改、不可重排」——runner 只对 user_version < N 的库
    // 跑 MIGRATIONS[0..N-1]，改旧条目等于老库永远拿不到这次变更。
    expect(db).toMatch(/ALTER TABLE sessions ADD COLUMN workspace_root TEXT/);
    // 必须落在第 6 条（下标 5）：前五条是 M1/M2/M3b/M3c/M6 已发布的
    const idx = db.indexOf('ALTER TABLE sessions ADD COLUMN workspace_root');
    const before = db.slice(0, idx);
    expect(before).toContain('origin_device_id');   // [3] 仍在它前面
    expect(before).toContain('CREATE TABLE settings'); // [4] 仍在它前面
  });

  it('SessionMeta 带出 workspaceRoot；新建会话继承 settings 里「上次用过的」', () => {
    expect(chatStore).toContain('workspaceRoot');
    expect(chatStore).toMatch(/workspace_root/);
    // 新会话继承：createSession 时读全局「上次用过的」，没有则留空（= 回落沙箱桶）
    expect(minisd).toContain('workspace.lastUsed');
  });

  it('三个 RPC 注册齐全，且 set 会校验目录真实存在', () => {
    expect(minisd).toMatch(/'workspace\.get':/);
    expect(minisd).toMatch(/'workspace\.set':/);
    expect(minisd).toMatch(/'workspace\.reset':/);
    // 命门：目录不存在时必须抛错而不是静默存下——否则 shell 会在一个不存在的 cwd 里起，
    // 报错形态是「命令莫名其妙失败」，比「设置时就告诉你路径不对」难查十倍。
    expect(minisd).toMatch(/workspace\.set[\s\S]{0,600}?(existsSync|statSync)/);
  });
});

describe('工作区可选 · 消费点（2 例）', () => {
  it('paths 提供 workspaceOf，且相对路径与 /var/minis/workspace 两条分支都走它', () => {
    expect(paths).toMatch(/workspaceOf\s*\(/);
    // 相对路径分支（原来直接写 sessionBucket(...,'workspace')）
    expect(paths).toMatch(/base = this\.workspaceOf\(sessionId\)/);
    // 穿越保护不能因此失效：override 指向真实项目目录时，仍须限制在该目录内
    expect(paths).toContain('路径穿越被拒绝');
  });

  it('shell 的 cwd 与终端启动目录都改用 workspaceOf——只改一处等于半接', () => {
    // 只改 paths 而不改这两处的话，文件工具听话了但命令还在沙箱桶里跑，
    // 表现为「agent 说找不到文件」，而用户以为工作区已经切过去了。
    expect(shell).toMatch(/workspaceOf\(/);
    expect(terminal).toMatch(/workspaceOf\(/);
    expect(shell).not.toMatch(/sessionBucket\([^)]*'workspace'\)/);
    expect(terminal).not.toMatch(/sessionBucket\([^)]*'workspace'\)/);
  });
});

describe('工作区可选 · 原生目录选择器（2 例）', () => {
  it('主进程开 dialog:pickFolder 通道，preload 对称暴露', () => {
    expect(main).toMatch(/ipcMain\.handle\(\s*'dialog:pickFolder'/);
    expect(main).toMatch(/showOpenDialog/);
    expect(main).toMatch(/openDirectory/);
    expect(preload).toContain('pickFolder');
    expect(preload).toMatch(/ipcRenderer\.invoke\('dialog:pickFolder'\)/);
  });

  it('取消选择必须回 null 而不是空串——空串会被当成「清空工作区」', () => {
    // canceled 时 filePaths 是空数组。若返回 '' 并被 set 当作合法值，
    // 用户点「取消」反而把工作区清了——最难查的那类误操作。
    expect(main).toMatch(/canceled[\s\S]{0,120}?null/);
  });
});

describe('工作区可选 · 界面（3 例）', () => {
  it('chip 从纯装饰 div 改为原生 button，且显示当前目录而不是死字「工作区」', () => {
    expect(chatView).not.toMatch(/<div class="cpill static"><Icon name="folder"/);
    expect(chatView).toMatch(/<button[^>]*class="cpill[^"]*"[^>]*>[\s\S]{0,200}?name="folder"/);
    // 显示当前目录名（不是死字）：绑定到 store 的工作区状态
    expect(chatView).toContain('workspaceLabel');
  });

  it('两种选法都在：原生选择器 + 可粘贴路径框（用户拍板「两者都要」）', () => {
    // 锚**意图**不锚函数名（红线 9 同类）：要证的是「原生选择器从界面可达」，
    // 叫 pickFolder 还是 pickWorkspaceFolder 是实现自由。
    expect(chatView).toMatch(/pick(Workspace)?Folder/);
    expect(chatView).toMatch(/<input[^>]*v-model="wsPath"/);
    // 还要能回到默认沙箱桶，否则改错了没路回
    expect(chatView).toMatch(/恢复默认|回到默认|默认沙箱/);
  });

  it('空态不许静默失败：没有活动会话时先建会话，且按钮文案说明这一点', () => {
    // 用户 2026-08-11 实测撞到的真 bug：工作区是**每会话**的，空态下 setWorkspace 会带着
    // 空 sessionId 发出去，后端 UPDATE 匹配不到任何行——**点了什么也不发生，还不报错**。
    // 这正是最难查的一类：界面看着好好的、按钮也能点。
    expect(chatView).toMatch(/ensureSession/);
    expect(chatView).toMatch(/if \(!chat\.activeId\) await chat\.newSession\(\)/);
    // 不做无声的副作用：没会话时按钮文案必须写明它会新建
    expect(chatView).toMatch(/新建会话并/);
    // 占位符里的反斜杠是 HTML 属性字面量：写两个就显示两个（用户截图里看到的正是 D:\projects）。
    // 断言刻意**不数反斜杠**——用 fromCharCode 拼，免疫多层转义（这轮已在转义上栽过两次）。
    const BS = String.fromCharCode(92);
    expect(chatView).toContain(`D:${BS}projects`);
    expect(chatView).not.toContain(`D:${BS}${BS}projects`);
  });

  it('store 接三个 RPC，且设置后要刷新——工作区变了终端与文件树都得跟着变', () => {
    expect(store).toMatch(/rpc\.call\('workspace\.get'/);
    expect(store).toMatch(/rpc\.call\('workspace\.set'/);
    expect(store).toMatch(/rpc\.call\('workspace\.reset'/);
    expect(store).toContain('workspaceRoot');
  });
});

describe('工作区可选 · 迁移 [5] 真实升级路径（2 例）', () => {
  it('新建库：sessions 带 workspace_root，默认 NULL（= 回落沙箱桶）', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('workspace_root');
    const now = Date.now() / 1000;
    db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)').run('S1', 'x', now, now);
    const r = db.prepare('SELECT workspace_root FROM sessions WHERE id=?').get('S1') as { workspace_root: string | null };
    expect(r.workspace_root).toBeNull();   // 未设置 = 沙箱桶，老会话与新会话同一默认
    db.close();
  });

  it('**M6 用户的库停在 v5**：重开只补跑 [5] 到 6，存量会话不丢、且幂等', () => {
    // 这条是这次真正的新增路径。上面那个 v4 用例覆盖的是更老的库；
    // 现网绝大多数库是 v5（M6 之后），它们首次启动才补跑 [5]——不单独覆盖等于没测。
    const dir = mkdtempSync(path.join(tmpdir(), 'dm-ws-mig-'));
    const file = path.join(dir, 'test.db');
    try {
      let db = openDb(file);
      // 造出「工作区之前」的库形态：撤掉 [5] 的列并把版本退回 5
      db.exec('ALTER TABLE sessions DROP COLUMN workspace_root;');
      db.pragma('user_version = 5');
      const now = Date.now() / 1000;
      db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)')
        .run('S_OLD', '升级前的会话', now, now);
      db.close();

      db = openDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(6);
      const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name);
      expect(cols).toContain('workspace_root');
      // 存量会话完好，且新列对老行是 NULL —— 老会话升级后仍用沙箱桶，行为一字不变
      const row = db.prepare('SELECT title, workspace_root FROM sessions WHERE id=?').get('S_OLD') as
        { title: string; workspace_root: string | null };
      expect(row.title).toBe('升级前的会话');
      expect(row.workspace_root).toBeNull();
      db.close();

      // 幂等：再开一次不重跑（重跑会报 duplicate column name）
      db = openDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(6);
      expect((db.prepare('SELECT title FROM sessions WHERE id=?').get('S_OLD') as { title: string }).title)
        .toBe('升级前的会话');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('工作区可选 · MinisPaths 真实解析行为（4 例）', () => {
  // 期望值一律用 path.join/resolve 推导，不写字面路径——Windows 反斜杠在多层转义里极易被吃掉，
  // 初版就栽在这上面（断言里的 'C:\projects\my-app' 被 JS 解成 'C:projectsmy-app'）。
  const ROOT = path.resolve('C:/dm-test-root');
  const SID = 'S1';
  const PROJ = path.resolve('C:/projects/my-app');

  it('未注入解析器 / 解析器返回空 → 回落沙箱桶（老会话行为一字不变）', () => {
    const a = new MinisPaths(ROOT);
    expect(a.workspaceOf(SID)).toBe(a.sessionBucket(SID, 'workspace'));
    const b = new MinisPaths(ROOT);
    b.setWorkspaceResolver(() => undefined);
    expect(b.workspaceOf(SID)).toBe(b.sessionBucket(SID, 'workspace'));
    const c = new MinisPaths(ROOT);
    c.setWorkspaceResolver(() => '   ');   // 空白串也算没设，否则会把 cwd 指到一个空路径
    expect(c.workspaceOf(SID)).toBe(c.sessionBucket(SID, 'workspace'));
  });

  it('设了覆盖值：相对路径与 /var/minis/workspace 都落到项目目录', () => {
    const p = new MinisPaths(ROOT);
    p.setWorkspaceResolver(() => PROJ);
    expect(p.workspaceOf(SID)).toBe(PROJ);
    const want = path.join(PROJ, 'src', 'main.ts');
    expect(p.resolveGuestPath(SID, 'src/main.ts')).toBe(want);                       // 相对路径分支
    expect(p.resolveGuestPath(SID, '/var/minis/workspace/src/main.ts')).toBe(want);  // guest 名分支
  });

  it('穿越保护不因覆盖而失效——限制面只是从沙箱桶换成了项目目录', () => {
    const p = new MinisPaths(ROOT);
    p.setWorkspaceResolver(() => PROJ);
    expect(() => p.resolveGuestPath(SID, '../../../Windows/System32/x')).toThrow(/路径穿越被拒绝/);
    expect(() => p.resolveGuestPath(SID, '/var/minis/workspace/../../etc')).toThrow(/路径穿越被拒绝/);
  });

  it('只有 workspace 桶受影响，attachments / offloads / browser 与全局目录不动', () => {
    const p = new MinisPaths(ROOT);
    p.setWorkspaceResolver(() => PROJ);
    // 附件仍落数据根——否则用户换工作区会把历史附件「弄丢」（其实是找错了地方）
    expect(p.resolveGuestPath(SID, '/var/minis/attachments/a.png'))
      .toBe(path.join(p.sessionBucket(SID, 'attachments'), 'a.png'));
    expect(p.resolveGuestPath(SID, '/var/minis/memory/m.md'))
      .toBe(path.join(p.globalDir('memory'), 'm.md'));
  });
});
