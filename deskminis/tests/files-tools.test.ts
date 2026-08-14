import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { fileReadTool, fileWriteTool, fileEditTool } from '../src/minisd/tools/files';
import type { ToolContext, PermissionRequest, PermissionDecision } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

class AllowAllGateway { async check(_r: PermissionRequest): Promise<PermissionDecision> { return 'allow'; } hasBridgeGrant(): boolean { return false; } }
class DenyAllGateway { asked: PermissionRequest[] = []; async check(r: PermissionRequest): Promise<PermissionDecision> { this.asked.push(r); return 'deny'; } hasBridgeGrant(): boolean { return false; } }

let root: string; let ctx: ToolContext; let reg: ToolRegistry;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dm-tools-'));
  const paths = new MinisPaths(root);
  paths.ensureSessionDirs('S1');
  ctx = { sessionId: 'S1', paths, permissions: new AllowAllGateway() };
  reg = new ToolRegistry();
  reg.register(fileReadTool); reg.register(fileWriteTool); reg.register(fileEditTool);
});

describe('文件工具', () => {
  it('write→read 往返(工作区相对路径)', async () => {
    const w = await reg.execute('file_write', JSON.stringify({ path: 'a/b.txt', content: '内容', tool_title: '写文件' }), ctx);
    expect(w.success).toBe(true);
    const r = await reg.execute('file_read', JSON.stringify({ path: '/var/minis/workspace/a/b.txt', tool_title: '读文件' }), ctx);
    expect(r.output).toBe('内容');
  });
  it('file_edit 唯一匹配替换; 多处匹配报错', async () => {
    writeFileSync(join(root, 'sessions', 'S1', 'workspace', 'e.txt'), 'aa bb aa');
    const multi = await reg.execute('file_edit', JSON.stringify({ path: 'e.txt', old_string: 'aa', new_string: 'x', tool_title: '改' }), ctx);
    expect(multi.success).toBe(false);
    expect(multi.output).toContain('2');
    const ok = await reg.execute('file_edit', JSON.stringify({ path: 'e.txt', old_string: 'bb', new_string: 'cc', tool_title: '改' }), ctx);
    expect(ok.success).toBe(true);
    expect(readFileSync(join(root, 'sessions', 'S1', 'workspace', 'e.txt'), 'utf8')).toBe('aa cc aa');
  });
  it('数据根之外的绝对路径写入要过权限, deny 则拒绝', async () => {
    const deny = new DenyAllGateway();
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-out-')), 'x.txt');
    const r = await reg.execute('file_write', JSON.stringify({ path: outside, content: 'x', tool_title: '写' }), { ...ctx, permissions: deny });
    expect(r.success).toBe(false);
    expect(deny.asked[0].kind).toBe('file-write');
  });
  it('穿越式绝对路径(字符串前缀像在根内)仍要过权限门', async () => {
    const deny = new DenyAllGateway();
    // 故意不归一化: 字面量以 root 开头, 但实际解析到数据根之外
    const escape = `${root}${sep}..${sep}${basename(root)}-escape-probe.txt`;
    const r = await reg.execute('file_write', JSON.stringify({ path: escape, content: 'x', tool_title: '写' }), { ...ctx, permissions: deny });
    expect(r.success).toBe(false);
    expect(deny.asked.length).toBe(1);
    expect(deny.asked[0].kind).toBe('file-write');
    expect(existsSync(resolve(escape))).toBe(false);
  });
  it('registry 对非对象 JSON 参数返回错误 outcome 而非抛异常', async () => {
    const nullInput = await reg.execute('file_write', 'null', ctx);
    expect(nullInput.success).toBe(false);
    expect(nullInput.output).toContain('JSON 对象');
    const arrInput = await reg.execute('file_write', '[1,2]', ctx);
    expect(arrInput.success).toBe(false);
    expect(arrInput.output).toContain('JSON 对象');
  });
  it('数据根之内的路径不触发权限门', async () => {
    const deny = new DenyAllGateway();
    const r = await reg.execute('file_write', JSON.stringify({ path: 'inside.txt', content: 'x', tool_title: '写' }), { ...ctx, permissions: deny });
    expect(r.success).toBe(true);
    expect(deny.asked).toEqual([]);
  });
  it('数据根之外的绝对路径读取要过权限, deny 则拒绝且不泄露内容', async () => {
    const deny = new DenyAllGateway();
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-out-')), 'id_rsa');
    writeFileSync(outside, 'PRIVATE-KEY-MATERIAL');
    const r = await reg.execute('file_read', JSON.stringify({ path: outside, tool_title: '读' }), { ...ctx, permissions: deny });
    expect(r.success).toBe(false);
    expect(deny.asked).toHaveLength(1);
    expect(deny.asked[0].kind).toBe('file-read');
    expect(deny.asked[0].detail).toBe(resolve(outside));
    expect(r.output).not.toContain('PRIVATE-KEY-MATERIAL');
  });
  it('数据根之内的读取不触发权限门', async () => {
    const deny = new DenyAllGateway();
    writeFileSync(join(root, 'sessions', 'S1', 'workspace', 'inside.txt'), '工作区内容');
    const r = await reg.execute('file_read', JSON.stringify({ path: 'inside.txt', tool_title: '读' }), { ...ctx, permissions: deny });
    expect(r.success).toBe(true);
    expect(r.output).toBe('工作区内容');
    expect(deny.asked).toEqual([]);
  });
  it('preflight: 缺 required 参数/未知工具返回错误 outcome 而非抛异常', async () => {
    const missing = await reg.execute('file_read', JSON.stringify({ tool_title: '读' }), ctx);
    expect(missing.success).toBe(false);
    expect(missing.output).toContain('path');
    const unknown = await reg.execute('nope', '{}', ctx);
    expect(unknown.success).toBe(false);
  });
  it('file_read 成功后触发 onFileRead 钩子（归一化绝对路径）', async () => {
    const seen: string[] = [];
    writeFileSync(join(root, 'sessions', 'S1', 'workspace', 'h.txt'), 'x');
    const r = await reg.execute('file_read', JSON.stringify({ path: 'h.txt', tool_title: '读' }), { ...ctx, onFileRead: (p) => seen.push(p) });
    expect(r.success).toBe(true);
    expect(seen).toEqual([join(root, 'sessions', 'S1', 'workspace', 'h.txt')]);
  });
  it('file_read 失败（文件不存在）不触发 onFileRead', async () => {
    const seen: string[] = [];
    const r = await reg.execute('file_read', JSON.stringify({ path: 'nope.txt', tool_title: '读' }), { ...ctx, onFileRead: (p) => seen.push(p) });
    expect(r.success).toBe(false);
    expect(seen).toEqual([]);
  });
  it('file_read 被权限拒绝时不触发 onFileRead', async () => {
    const seen: string[] = [];
    const deny = new DenyAllGateway();
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-out-')), 's.txt');
    writeFileSync(outside, 'secret');
    const r = await reg.execute('file_read', JSON.stringify({ path: outside, tool_title: '读' }), { ...ctx, permissions: deny, onFileRead: (p) => seen.push(p) });
    expect(r.success).toBe(false);
    expect(seen).toEqual([]);
  });
  // 绑定真实项目目录后，工作区内文件应同数据根内一样免询问：
  // 绑定动作本身就是授权语义，无需每次路径都过权限门。
  it('绑定自定义工作区后 file_read 工作区内文件不需过权限门', async () => {
    const deny = new DenyAllGateway();
    const ws = mkdtempSync(join(tmpdir(), 'dm-ws-'));
    writeFileSync(join(ws, 'proj.txt'), '项目源码');
    ctx.paths.setWorkspaceResolver(() => ws);
    const r = await reg.execute('file_read', JSON.stringify({ path: 'proj.txt', tool_title: '读' }), { ...ctx, permissions: deny });
    expect(r.success).toBe(true);
    expect(r.output).toBe('项目源码');
    expect(deny.asked).toEqual([]);
  });
  it('绑定自定义工作区后 file_write 工作区内文件不需过权限门', async () => {
    const deny = new DenyAllGateway();
    const ws = mkdtempSync(join(tmpdir(), 'dm-ws-'));
    const target = join(ws, 'out.txt');
    ctx.paths.setWorkspaceResolver(() => ws);
    const r = await reg.execute('file_write', JSON.stringify({ path: target, content: '新内容', tool_title: '写' }), { ...ctx, permissions: deny });
    expect(r.success).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('新内容');
    expect(deny.asked).toEqual([]);
  });
  it('绑定自定义工作区后读取工作区之外路径仍触发权限门', async () => {
    const deny = new DenyAllGateway();
    const ws = mkdtempSync(join(tmpdir(), 'dm-ws-'));
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-out-')), 'secret.txt');
    writeFileSync(outside, '外部机密');
    ctx.paths.setWorkspaceResolver(() => ws);
    const r = await reg.execute('file_read', JSON.stringify({ path: outside, tool_title: '读' }), { ...ctx, permissions: deny });
    expect(r.success).toBe(false);
    expect(deny.asked).toHaveLength(1);
    expect(deny.asked[0].kind).toBe('file-read');
  });
  it('已 abort 的 signal → file_write 返回取消结果且未写盘', async () => {
    const controller = new AbortController();
    controller.abort();
    const target = join(root, 'sessions', 'S1', 'workspace', 'cancelled.txt');
    const r = await reg.execute('file_write', JSON.stringify({ path: 'cancelled.txt', content: 'x', tool_title: '写' }), { ...ctx, signal: controller.signal });
    expect(r.success).toBe(false);
    expect(r.output).toContain('已取消');
    expect(existsSync(target)).toBe(false);
  });
  it('权限等待期间取消（批准晚于取消）→ 仍返回取消且未写盘', async () => {
    // 开头的 aborted 检查过闸后，权限询问可挂最长 90 秒；期间用户点停止，之后卡片才被批准。
    // 已 abort 的 signal 不会补发 abort 事件——若闸后不重查，这次写入会照常落盘。
    const controller = new AbortController();
    const lateAllowGateway = {
      async check(): Promise<PermissionDecision> { controller.abort(); return 'allow'; },
      hasBridgeGrant: () => false,
    };
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-late-')), 'late.txt'); // 工作区外才会触发权限询问
    const r = await reg.execute('file_write', JSON.stringify({ path: outside, content: 'x', tool_title: '写' }), { ...ctx, permissions: lateAllowGateway, signal: controller.signal });
    expect(r.success).toBe(false);
    expect(r.output).toContain('已取消');
    expect(existsSync(outside)).toBe(false);
  });
});
