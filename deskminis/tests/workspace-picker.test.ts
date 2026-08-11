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
    expect(chatView).toMatch(/pickFolder/);
    expect(chatView).toMatch(/<input[^>]*v-model="wsPath"/);
    // 还要能回到默认沙箱桶，否则改错了没路回
    expect(chatView).toMatch(/恢复默认|回到默认|默认沙箱/);
  });

  it('store 接三个 RPC，且设置后要刷新——工作区变了终端与文件树都得跟着变', () => {
    expect(store).toMatch(/rpc\.call\('workspace\.get'/);
    expect(store).toMatch(/rpc\.call\('workspace\.set'/);
    expect(store).toMatch(/rpc\.call\('workspace\.reset'/);
    expect(store).toContain('workspaceRoot');
  });
});
