import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { SkillStore } from '../src/minisd/skills/store';
import { SkillImporter, type ImportProgress } from '../src/minisd/skills/importer';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

const SKILL_MD = '---\nname: demo-skill\ndescription: 演示技能\nversion: 1.0.0\n---\n# Demo\n正文。\n';

let root: string; let skillsRoot: string; let db: Database.Database; let store: SkillStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dm-import-'));
  skillsRoot = join(root, 'skills');
  mkdirSync(skillsRoot, { recursive: true });
  db = openDb(':memory:');
  store = new SkillStore(db);
});

/** 轮询等后台任务脱离 running（比固定 sleep 稳）。 */
async function waitTask(importer: SkillImporter, taskId: string, timeoutMs = 5000): Promise<ImportProgress> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = importer.status(taskId);
    if (t && t.state !== 'running') return t;
    if (Date.now() > deadline) throw new Error('等待导入任务超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

/** store-only（无压缩）ZIP 构造器：只够测试用 —— local headers + central directory + EOCD。 */
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名旗标
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameB, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.data.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameB.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameB);
    offset += 30 + nameB.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** fetch mock：按完整 URL 精确路由；未命中返回 404。 */
function fakeFetch(routes: Record<string, { status?: number; json?: unknown; text?: string }>): typeof fetch {
  return (async (input: unknown, _init?: unknown) => {
    const url = String(input);
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    const body = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? '');
    return new Response(body, { status: r.status ?? 200 });
  }) as typeof fetch;
}

describe('folder 导入', () => {
  it('根外文件夹：整目录复制进 skillsRoot 并入库（SKILL.md 原样不改写）', async () => {
    const src = join(root, '外部技能');
    mkdirSync(join(src, 'scripts'), { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), SKILL_MD);
    writeFileSync(join(src, 'scripts', 'run.ps1'), 'echo hi');
    const importer = new SkillImporter(skillsRoot, store);
    const { taskId } = importer.startImport('folder', src);
    const t = await waitTask(importer, taskId);
    expect(t.state).toBe('done');
    expect(t.succeeded).toEqual(['demo-skill']);
    // 原样落盘：字节级一致，子文件跟随
    expect(readFileSync(join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect(readFileSync(join(skillsRoot, 'demo-skill', 'scripts', 'run.ps1'), 'utf8')).toBe('echo hi');
    const row = store.get('demo-skill')!;
    expect(row.description).toBe('演示技能');
    expect(row.importSource).toContain('folder');
  });
  it('根内文件夹（agent 直写）：原地入库不复制', async () => {
    mkdirSync(join(skillsRoot, 'agent-wrote'), { recursive: true });
    writeFileSync(join(skillsRoot, 'agent-wrote', 'SKILL.md'), SKILL_MD.replace('demo-skill', 'agent-skill'));
    const importer = new SkillImporter(skillsRoot, store);
    const { taskId } = importer.startImport('folder', join(skillsRoot, 'agent-wrote'));
    const t = await waitTask(importer, taskId);
    expect(t.state).toBe('done');
    expect(t.succeeded).toEqual(['agent-wrote']);
    expect(store.get('agent-wrote')!.name).toBe('agent-skill');
  });
  it('文件夹缺 SKILL.md → 任务整体 failed', async () => {
    const src = join(root, 'empty');
    mkdirSync(src, { recursive: true });
    const importer = new SkillImporter(skillsRoot, store);
    const t = await waitTask(importer, importer.startImport('folder', src).taskId);
    expect(t.state).toBe('failed');
    expect(t.error).toContain('SKILL.md');
  });
});

describe('adoptOrphans 孤儿回收', () => {
  it('skillsRoot 下不在表里的含 SKILL.md 目录入库；无 SKILL.md 的目录与已入库的跳过', () => {
    mkdirSync(join(skillsRoot, 'orphan-a'), { recursive: true });
    writeFileSync(join(skillsRoot, 'orphan-a', 'SKILL.md'), SKILL_MD.replace('demo-skill', 'skill-a'));
    mkdirSync(join(skillsRoot, 'not-a-skill'), { recursive: true });
    writeFileSync(join(skillsRoot, 'not-a-skill', 'README.md'), 'x');
    store.upsert({ id: 'orphan-a', meta: {}, fallbackName: '占位', importSource: 'orphan' }); // 已入库 → 不重复
    mkdirSync(join(skillsRoot, 'orphan-b'), { recursive: true });
    writeFileSync(join(skillsRoot, 'orphan-b', 'SKILL.md'), SKILL_MD.replace('demo-skill', 'skill-b'));
    const importer = new SkillImporter(skillsRoot, store);
    const adopted = importer.adoptOrphans();
    expect(adopted).toEqual(['orphan-b']);
    expect(store.get('orphan-b')!.name).toBe('skill-b');
    expect(store.get('orphan-b')!.importSource).toBe('orphan');
    expect(store.get('not-a-skill')).toBeUndefined();
    expect(store.get('orphan-a')!.name).toBe('占位'); // 已入库的保持原样
  });
});

describe('GitHub URL 导入（mock fetch）', () => {
  it('subpath 本身是技能目录：Contents API 递归下载同级文件', async () => {
    const routes = {
      'https://api.github.com/repos/o/r/contents/skills/one?ref=main': { json: [
        { name: 'SKILL.md', path: 'skills/one/SKILL.md', type: 'file', download_url: 'https://raw/one/SKILL.md' },
        { name: 'scripts', path: 'skills/one/scripts', type: 'dir', download_url: null },
      ] },
      'https://api.github.com/repos/o/r/contents/skills/one/scripts?ref=main': { json: [
        { name: 'run.sh', path: 'skills/one/scripts/run.sh', type: 'file', download_url: 'https://raw/one/scripts/run.sh' },
      ] },
      'https://raw/one/SKILL.md': { text: SKILL_MD },
      'https://raw/one/scripts/run.sh': { text: '#!/bin/sh\necho ok\n' },
    };
    const importer = new SkillImporter(skillsRoot, store, fakeFetch(routes));
    const t = await waitTask(importer, importer.startImport('github-url', 'https://github.com/o/r/tree/main/skills/one').taskId);
    expect(t.state).toBe('done');
    expect(t.succeeded).toEqual(['demo-skill']);
    expect(readFileSync(join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect(readFileSync(join(skillsRoot, 'demo-skill', 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho ok\n');
    expect(store.get('demo-skill')!.importSource).toBe('github:o/r');
  });
  it('subpath 是集合目录：每个含 SKILL.md 的一级子目录各成一个技能；单个失败不拖死整批（部分成功报告）', async () => {
    const routes = {
      'https://api.github.com/repos/o/r/contents/skills?ref=main': { json: [
        { name: 'a', path: 'skills/a', type: 'dir', download_url: null },
        { name: 'b', path: 'skills/b', type: 'dir', download_url: null },
        { name: 'README.md', path: 'skills/README.md', type: 'file', download_url: 'https://raw/README.md' },
      ] },
      'https://api.github.com/repos/o/r/contents/skills/a?ref=main': { json: [
        { name: 'SKILL.md', path: 'skills/a/SKILL.md', type: 'file', download_url: 'https://raw/a/SKILL.md' },
      ] },
      'https://api.github.com/repos/o/r/contents/skills/b?ref=main': { json: [
        { name: 'SKILL.md', path: 'skills/b/SKILL.md', type: 'file', download_url: 'https://raw/b/SKILL.md' },
      ] },
      'https://raw/a/SKILL.md': { text: SKILL_MD.replace('demo-skill', 'skill-a') },
      // 'https://raw/b/SKILL.md' 故意不注册 → 404 → b 失败
    };
    const importer = new SkillImporter(skillsRoot, store, fakeFetch(routes));
    const t = await waitTask(importer, importer.startImport('github-url', 'https://github.com/o/r/tree/main/skills').taskId);
    expect(t.state).toBe('done'); // 部分成功整体仍 done
    expect(t.total).toBe(2);
    expect(t.completed).toBe(2);
    expect(t.succeeded).toEqual(['skill-a']);
    expect(t.failures).toHaveLength(1);
    expect(t.failures[0].name).toBe('b');
    expect(store.get('skill-a')).toBeTruthy();
  });
  it('非 GitHub URL / 找不到技能目录 → 整体 failed', async () => {
    const importer = new SkillImporter(skillsRoot, store, fakeFetch({}));
    const t1 = await waitTask(importer, importer.startImport('github-url', 'https://example.com/o/r').taskId);
    expect(t1.state).toBe('failed');
    const t2 = await waitTask(importer, importer.startImport('github-url', 'https://github.com/o/r/tree/main/none').taskId);
    expect(t2.state).toBe('failed');
    expect(t2.error).toContain('SKILL.md');
  });
  it('任务进度可查：startImport 立即返回、status 反映终态、listTasks 含全部任务', async () => {
    const routes = {
      'https://api.github.com/repos/o/r/contents/one?ref=main': { json: [
        { name: 'SKILL.md', path: 'one/SKILL.md', type: 'file', download_url: 'https://raw/one/SKILL.md' },
      ] },
      'https://raw/one/SKILL.md': { text: SKILL_MD },
    };
    const importer = new SkillImporter(skillsRoot, store, fakeFetch(routes));
    const { taskId } = importer.startImport('github-url', 'https://github.com/o/r/tree/main/one');
    expect(taskId).toMatch(/^[0-9A-F-]{36}$/);
    const t = await waitTask(importer, taskId);
    expect(t.state).toBe('done');
    expect(importer.status('不存在')).toBeUndefined();
    expect(importer.listTasks().map(x => x.taskId)).toContain(taskId);
  });
});

describe('ZIP 导入（测试内现造 zip 字节）', () => {
  it('一层包装目录被剥离，SKILL.md 落到技能根', async () => {
    const zipPath = join(root, 'pack.zip');
    writeFileSync(zipPath, buildZip([
      { name: 'wrapper/SKILL.md', data: Buffer.from(SKILL_MD) },
      { name: 'wrapper/extra/note.txt', data: Buffer.from('备注') },
    ]));
    const importer = new SkillImporter(skillsRoot, store);
    const t = await waitTask(importer, importer.startImport('zip', zipPath).taskId);
    expect(t.state).toBe('done');
    expect(t.succeeded).toEqual(['demo-skill']);
    expect(readFileSync(join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect(readFileSync(join(skillsRoot, 'demo-skill', 'extra', 'note.txt'), 'utf8')).toBe('备注');
  });
  it('无包装目录（SKILL.md 在根层）同样可导入', async () => {
    const zipPath = join(root, 'flat.zip');
    writeFileSync(zipPath, buildZip([
      { name: 'SKILL.md', data: Buffer.from(SKILL_MD) },
      { name: 'ref.txt', data: Buffer.from('x') },
    ]));
    const importer = new SkillImporter(skillsRoot, store);
    const t = await waitTask(importer, importer.startImport('zip', zipPath).taskId);
    expect(t.state).toBe('done');
    expect(existsSync(join(skillsRoot, 'demo-skill', 'ref.txt'))).toBe(true);
  });
  it('根层没有 SKILL.md → 整体 failed；路径穿越项被丢弃', async () => {
    const bad = join(root, 'bad.zip');
    writeFileSync(bad, buildZip([{ name: 'README.md', data: Buffer.from('x') }]));
    const importer = new SkillImporter(skillsRoot, store);
    const t1 = await waitTask(importer, importer.startImport('zip', bad).taskId);
    expect(t1.state).toBe('failed');
    expect(t1.error).toContain('SKILL.md');
    const evil = join(root, 'evil.zip');
    writeFileSync(evil, buildZip([
      { name: 'SKILL.md', data: Buffer.from(SKILL_MD) },
      { name: '../escape.txt', data: Buffer.from('逃出') },
    ]));
    const t2 = await waitTask(importer, importer.startImport('zip', evil).taskId);
    expect(t2.state).toBe('done');
    expect(existsSync(join(skillsRoot, 'escape.txt'))).toBe(false);
    expect(existsSync(join(root, 'escape.txt'))).toBe(false);
  });
});
