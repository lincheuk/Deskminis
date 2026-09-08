/**
 * T6b · 工作区绑定入口（新壳）。
 *
 * 换壳时这条能力的界面入口整个丢了：后端 `workspace.get/set/reset` 通、
 * store 四个 action 通，但 `ui/` 下对写侧三个 action **零引用**——
 * 每个会话只能在沙箱桶里干活，而 README 写着「每会话绑定真实项目目录 ✅」。
 * 这是 V 波权限卡的同一病根（从新设计出发补全，而不是从旧实现逐项核对）。
 *
 * 旧实现（components/ChatView.vue，即将删）踩出来的几条规矩，逐条守住。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string): string =>
  readFileSync(join(__dirname, '../src/renderer/src/', p), 'utf8').replace(/\r\n/g, '\n');
const ws = read('ui/WorkspacePanel.vue');

describe('T6b — 工作区绑定入口接回新壳', () => {
  it('写侧三个 action 都接线（此前 ui/ 下零引用）', () => {
    for (const fn of ['setWorkspace', 'resetWorkspace', 'pickWorkspaceFolder']) {
      expect(ws, `缺 ${fn}`).toContain(fn);
    }
  });

  it('两条入口都在：原生选择器 + 粘贴路径', () => {
    // 粘贴路径不是可选项——原生对话框在 xvfb 里没法自动化，
    // 没有它这条链就验不了；README 原文写的也是「原生选择器或粘贴路径」两条
    expect(ws).toContain('pickWorkspaceFolder');
    expect(ws).toMatch(/v-model="wsPath"/);
  });

  it('取消选择返回 null 不是空串——空串会被当成「清空工作区」', () => {
    expect(ws).toMatch(/=== null/);
  });

  it('没有活动会话时先建会话，且按钮文案把这个副作用说出来', () => {
    // 工作区是**每会话**的：没有活动会话时 setWorkspace 带着空 sessionId 发出去，
    // 后端 UPDATE 匹配不到任何行——静默什么也不发生（旧实现实测撞过）
    expect(ws).toMatch(/ensureSession|chat\.newSession\(\)/);
    expect(ws).toMatch(/新建会话并/);
  });

  it('后端错误照实显示，不吞', () => {
    // workspace.set 的三道校验（空/不存在/不是目录）错误文案已经是中文人话，直接显示
    expect(ws).toMatch(/wsErr/);
    expect(ws).toMatch(/e instanceof Error \? e\.message : String\(e\)/);
  });

  it('默认态与绑定态可区分，且绑定后才给「恢复默认」', () => {
    expect(ws).toContain('workspaceIsDefault');
    expect(ws).toMatch(/恢复默认/);
  });

  it('说清影响面——shell / 终端 / 相对路径都以它为基准', () => {
    expect(ws).toMatch(/shell|终端|相对路径/);
  });

  it('说清新建会话会继承这个目录（后端存了 workspace.lastUsed）', () => {
    // 锚「继承」这个语义词，不锚具体措辞
    expect(ws).toMatch(/继承/);
  });
});

describe('T6b — 换了目录，文件树要跟着换', () => {
  it('watch 工作区根路径触发重取（实拍逮到：绑定后树还是空的）', () => {
    // watch 根路径而不是在每个处理器里手调：绑定 / 恢复默认 / 换会话继承，
    // 任何一条改动路径都被这一处接住
    expect(ws).toMatch(/watch\(\(\) => chat\.workspaceRoot/);
  });
});
