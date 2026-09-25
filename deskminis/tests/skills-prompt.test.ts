import { describe, it, expect, onTestFinished } from 'vitest';
import { buildSkillsBlock, tierSkills, type PromptSkill } from '../src/minisd/skills/prompt';
import { join, resolve, isAbsolute, win32 } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyShellCommand, PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import { dataGate } from '../src/minisd/tools/data-gate';
import { MinisPaths } from '../src/minisd/paths';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { fileReadTool } from '../src/minisd/tools/files';
import { fileGrepTool, fileListTool } from '../src/minisd/tools/search';
import type { PermissionDecision, PermissionRequest, ToolContext } from '../src/minisd/tools/types';

const ROOT = join('C:', 'data', 'skills');
const NOW = 1_800_000_000;
const DAY = 24 * 3600;

function sk(id: string, patch?: Partial<PromptSkill>): PromptSkill {
  return { id, name: id, description: `描述-${id}`, updatedAt: NOW - 30 * DAY, useCount: 0, importSource: 'folder', ...patch };
}

describe('buildSkillsBlock 基本形态', () => {
  it('0 个技能返回空串', () => {
    expect(buildSkillsBlock([], ROOT, NOW)).toBe('');
  });
  it('≤20 个全量披露：名 + 描述 + SKILL.md 绝对路径', () => {
    const out = buildSkillsBlock([sk('a'), sk('b')], ROOT, NOW);
    expect(out).toContain('<available_skills>');
    expect(out).toContain('<name>a</name>');
    expect(out).toContain('<description>描述-a</description>');
    expect(out).toContain(`<path>${join(ROOT, 'a', 'SKILL.md')}</path>`);
    expect(out).not.toContain('overflowed');
  });
  it('描述压缩成单行且 ≤200 字（超出加省略号）', () => {
    const long = '很长\n第二行 '.repeat(40);
    const out = buildSkillsBlock([sk('a', { description: long })], ROOT, NOW);
    const m = /<description>([^<]*)<\/description>/.exec(out);
    expect(m).toBeTruthy();
    expect(m![1].length).toBeLessThanOrEqual(200);
    expect(m![1]).not.toContain('\n');
    expect(m![1].endsWith('…')).toBe(true);
  });
  it('XML 特殊字符转义', () => {
    const out = buildSkillsBlock([sk('a', { name: 'a<b&c' })], ROOT, NOW);
    expect(out).toContain('<name>a&lt;b&amp;c</name>');
    expect(out).not.toContain('a<b&c');
  });
});

describe('tierSkills 分级披露（>20 个时）', () => {
  it('内置 > 7 天内更新(≤10) > use_count 高→低；full 上限 20', () => {
    const skills: PromptSkill[] = [
      sk('builtin-2', { importSource: 'builtin' }),
      sk('builtin-1', { importSource: 'builtin' }),
      // 12 个 7 天内更新 → 只取最新 10 个
      ...Array.from({ length: 12 }, (_, i) => sk(`recent-${String(i).padStart(2, '0')}`, { updatedAt: NOW - i * 1000 })),
      // 13 个普通技能，use_count 区分热度
      ...Array.from({ length: 13 }, (_, i) => sk(`plain-${i}`, { useCount: i })),
    ];
    const { full, rest } = tierSkills(skills, NOW);
    expect(full.length).toBe(20);
    // 第一层：内置全保留（保持原相对顺序）
    expect(full[0].id).toBe('builtin-2');
    expect(full[1].id).toBe('builtin-1');
    // 第二层：7 天内更新至多 10 个，按新→旧
    const recentInFull = full.filter(s => s.id.startsWith('recent-'));
    expect(recentInFull.map(s => s.id)).toEqual(Array.from({ length: 10 }, (_, i) => `recent-${String(i).padStart(2, '0')}`));
    // 第三层：剩余 8 席按 use_count 高→低
    const plainInFull = full.filter(s => s.id.startsWith('plain-'));
    expect(plainInFull.map(s => s.id)).toEqual(['plain-12', 'plain-11', 'plain-10', 'plain-9', 'plain-8', 'plain-7', 'plain-6', 'plain-5']);
    // 溢出：recent-10/11 + plain-0..4 共 7 个
    expect(rest.map(s => s.id).sort()).toEqual(['plain-0', 'plain-1', 'plain-2', 'plain-3', 'plain-4', 'recent-10', 'recent-11']);
  });
  it('恰好 20 个不分级（边界）', () => {
    const skills = Array.from({ length: 20 }, (_, i) => sk(`s${i}`));
    const out = buildSkillsBlock(skills, ROOT, NOW);
    expect(out).not.toContain('overflowed');
  });
});

/** 21 个技能，use_count 递增：s00 最冷，必定溢出。 */
const skills21 = () => Array.from({ length: 21 }, (_, i) => sk(`s${String(i).padStart(2, '0')}`, { useCount: i }));

function afterOverflow(block: string): string[] {
  const lines = block.split('\n');
  const i = lines.indexOf('</overflowed_skills>');
  expect(i, '块里没有 </overflowed_skills>').toBeGreaterThan(-1);
  return lines.slice(i + 1);
}

/** 溢出提示就是 </overflowed_skills> 之后那一行。对 skillsRoot 只看这一行：块里每条 <path> 都含 skillsRoot，
 *  对整块断言 skillsRoot、「ls」这类子串会被 <path> 行和 skills 这个词本身喂饱。 */
const overflowHint = (block: string): string => afterOverflow(block)[0] ?? '';

/** 技能块里技能数据以外的全部文字：块头、溢出提示、块尾那句说明，以及以后有人往块里加的任何指引行。
 *  认点名的工具要看整块：把模型指回 shell_execute 的那句话放在块里哪一行，模型都会照着对数据根跑 shell。
 *  只看溢出提示那一行时，再 push 一行或在块尾那句里加 shell_execute 就漏网；只看 </overflowed_skills> 之后时，
 *  放在块头或溢出清单之前也漏网（审查的变异实验 M1/M2、M6/M7：漏网时 9 例全绿）。
 *  只去掉两类行：只有 XML 标签的行（available_skills / overflowed_skills 这类标签名也是 snake_case，会被
 *  namedTools 当成工具）；逐字等于某个技能 <name>/<description>/<path> 元素的行（那是技能数据，不是我们写的指引）。
 *  元素行按「逐字等于测试数据」认、不按形状整类去掉：否则另起一行 <description>…shell_execute…</description> 会漏网。 */
function skillsBlockProse(block: string, skills: PromptSkill[], skillsRoot: string): string {
  const data = new Set(skills.flatMap(s => [
    `<name>${s.name}</name>`,
    `<description>${s.description}</description>`,
    `<path>${join(skillsRoot, s.id, 'SKILL.md')}</path>`,
  ]));
  return block.split('\n').filter(l => !/^<\/?[a-z_]+>$/.test(l) && !data.has(l)).join('\n');
}

/** 提示里点名的工具：DeskMinis 的工具名都是 snake_case（file_read、shell_execute…），按调用名认，不认散文。 */
const namedTools = (hint: string): string[] => [...new Set(hint.match(/\b[a-z]+_[a-z]+\b/g) ?? [])];

/** 读 skills 目录免审（dataGate 的 GLOBAL_RULES.skills.read）的文件工具：基准或目标都走 guardRead。 */
const FREE_SKILL_READERS = new Set(['file_list', 'file_glob', 'file_grep', 'file_read']);

describe('buildSkillsBlock 溢出（21 个）', () => {
  it('溢出只列名，并提示用 file_list / file_grep 查找、file_read 读取', () => {
    const skills = skills21();
    const out = buildSkillsBlock(skills, ROOT, NOW);
    expect(out).toContain('<overflowed_skills>');
    expect(out).toContain('<name>s00</name>'); // use_count 最低的被淘汰，只列名
    expect(out).not.toContain('<description>描述-s00</description>');
    const hint = overflowHint(out);
    expect(namedTools(hint)).toEqual(expect.arrayContaining(['file_list', 'file_grep', 'file_read']));
    // arrayContaining 不管多点名的工具：整块（去掉技能数据）点名的每个工具还得都是读 skills 免审的文件工具
    expect(namedTools(skillsBlockProse(out, skills, ROOT)).filter(t => !FREE_SKILL_READERS.has(t))).toEqual([]);
    expect(hint).toContain(ROOT);
    // 正文永不预载：块内不得出现技能正文线索（只有 名/描述/路径 三类字段）
    expect(out).not.toContain('## ');
  });
});

/** 正式版与开发态的数据根（W1a-9 起开发态是 DeskMinis-dev），skillsRoot 就是 index.ts 传进来的 paths.globalDir('skills')。 */
const WIN_ROOTS = ['DeskMinis', 'DeskMinis-dev'].map(dir => {
  const dataRoot = win32.join('C:\\', 'Users', 'me', 'AppData', 'Roaming', dir);
  return { dataRoot, skillsRoot: win32.join(dataRoot, 'skills') };
});

describe('W1b-2b：溢出提示给的查找方式在默认档下零卡', () => {
  // 为什么：数据根路径里含 DeskMinis，W1b-2 起 shell 只读命令点到它就回落 gated（默认档 askOnce）。
  // 旧提示叫模型 shell_execute ls "<skillsRoot>"，装了 20 个以上技能的用户每次照提示找技能都会弹卡，
  // 与设计稿 §2「skills 读取免审」相悖。
  it('提示点名的每个工具，照提示去找技能都不弹卡（正式版与开发态数据根）', async () => {
    for (const { dataRoot, skillsRoot } of WIN_ROOTS) {
      const skills = skills21();
      const block = buildSkillsBlock(skills, skillsRoot, NOW);
      const hint = overflowHint(block);
      expect(namedTools(hint).length, `溢出提示没有点名任何工具：${hint}`).toBeGreaterThan(0);
      // 认工具、抽 shell 命令都看整块（去掉技能数据），不只看提示那一行或溢出之后（理由见 skillsBlockProse）
      const prose = skillsBlockProse(block, skills, skillsRoot);
      expect(prose, '去掉技能数据后没留下溢出提示，下面的判定会落空').toContain(hint);
      const tools = namedTools(prose);
      const asked: PermissionRequest[] = [];
      const gw = new PermissionGatewayImpl(async r => { asked.push(r); return 'allow-once'; });
      const scope = { root: dataRoot, sessionId: 'S1', workspace: win32.join(dataRoot, 'sessions', 'S1', 'workspace') };
      for (const tool of tools) {
        if (tool === 'shell_execute') {
          // 点名 shell_execute 的每一行都要判：「执行」之后、「并」或句读之前就是让模型跑的命令，抽不出来就整行交出去。
          // 先看真实分类器怎么判，再交给默认档网关
          for (const line of prose.split('\n').filter(l => /\bshell_execute\b/.test(l))) {
            const cmd = /shell_execute\s*执行\s*(.+?)\s*(?:并|[，。；]|$)/.exec(line)?.[1] ?? line;
            expect.soft(classifyShellCommand(cmd), `${tool}: ${cmd}`).toBe('readonly');
            await gw.check({ kind: 'shell', detail: cmd, sessionId: 'S1', toolTitle: '找技能' });
          }
        } else {
          expect.soft(FREE_SKILL_READERS.has(tool), `${tool} 不是读 skills 目录免审的文件工具`).toBe(true);
          // 零卡由「工具 + 路径」两样决定：提示里实际给出的每个盘符路径都要按 win32 语义判免审（三审 M16w / M17：
          // 只判写死的 skillsRoot 时，提示改叫 file_grep 去搜整个数据根、或 file_read 读 mcp-servers\servers.json，照样全绿，
          // 默认档却每次弹卡）。命中后读的 SKILL.md 提示里不写全路径，另外判一条
          const given = [...prose.matchAll(/[A-Za-z]:\\[^"\s，。；、（）()]*/g)].map(m => m[0]);
          expect.soft(given.length, `${tool}: 提示里一个盘符路径都没抽到，下面的判定会落空`).toBeGreaterThan(0);
          for (const p of [...given, win32.join(skillsRoot, 's00', 'SKILL.md')]) {
            expect.soft(dataGate(p, scope, 'read', { platform: 'win32' }), `${tool}: ${p}`).toEqual({ verdict: 'free' });
          }
        }
      }
      // 上面只管点了名的工具。点到技能目录却不点名工具的句子（如「也可以在命令行里执行 dir "<skillsRoot>"」）同样会把
      // 模型引到 shell 上，而且逃过上面的判定：凡提到 skillsRoot 的分句都得点名至少一个工具（点名的都已在上面判过免审）。
      // 按分句切而不是按行：同一行前半句点名了文件工具，后半句「也可在命令行执行 dir …」按行判就蒙混过去了（三审 M11）
      for (const clause of prose.split(/[\n，。；]/).filter(c => c.includes(skillsRoot))) {
        expect.soft(namedTools(clause).length, `这一句点到技能目录却没说用哪个工具：${clause}`).toBeGreaterThan(0);
      }
      // 两个数据根都判完再报：soft 断言让正式版与开发态的结果一起出现在失败输出里
      expect.soft(asked.map(r => `${r.kind}: ${r.detail}`), `照 ${skillsRoot} 的提示去找技能弹了卡`).toEqual([]);
      expect.soft(tools, skillsRoot).not.toContain('shell_execute');
    }
  });

  it('走真工具：对技能目录 file_list、file_grep，再 file_read 命中的 SKILL.md，全程零卡', async () => {
    // 正式版的 skillsRoot 是盘符绝对路径，文件工具经 paths.ts 的盘符分支原样 resolve；Linux 没有盘符，
    // POSIX 绝对路径在那里会被当成 guest 路径拒掉。这里只把盘符那一支搬到 POSIX，其余解析照旧
    class HostAbsPaths extends MinisPaths {
      override resolveGuestPath(sessionId: string, guestPath: string): string {
        if (isAbsolute(guestPath) && !guestPath.startsWith('/var/minis/')) return resolve(guestPath);
        return super.resolveGuestPath(sessionId, guestPath);
      }
    }
    const root = mkdtempSync(join(tmpdir(), 'dm-skill-hint-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const paths = new HostAbsPaths(root);
    paths.ensureSessionDirs('S1');
    const skillsRoot = paths.globalDir('skills');
    for (const s of skills21()) {
      mkdirSync(join(skillsRoot, s.id));
      writeFileSync(join(skillsRoot, s.id, 'SKILL.md'), `---\nname: ${s.id}\ndescription: ${s.id === 's00' ? '开具发票' : '别的事'}\n---\n正文\n`);
    }
    const hint = overflowHint(buildSkillsBlock(skills21(), skillsRoot, NOW));
    expect(hint).toContain(skillsRoot);

    const asked: PermissionRequest[] = [];
    const deny = { async check(r: PermissionRequest): Promise<PermissionDecision> { asked.push(r); return 'deny'; }, hasBridgeGrant: () => false };
    const ctx: ToolContext = { sessionId: 'S1', paths, permissions: deny };
    const reg = new ToolRegistry();
    for (const t of [fileListTool, fileGrepTool, fileReadTool]) reg.register(t);
    const run = (name: string, args: Record<string, unknown>) => reg.execute(name, JSON.stringify({ ...args, tool_title: '找技能' }), ctx);

    const list = await run('file_list', { path: skillsRoot });
    expect(list.success, list.output).toBe(true);
    expect(list.output).toContain('s00/');
    const grep = await run('file_grep', { pattern: '发票', path: skillsRoot });
    expect(grep.success, grep.output).toBe(true);
    expect(grep.output).toMatch(/^s00\/SKILL\.md:3:/m);
    const read = await run('file_read', { path: join(skillsRoot, 's00', 'SKILL.md') });
    expect(read.success, read.output).toBe(true);
    expect(read.output).toContain('开具发票');
    expect(asked).toEqual([]);
  });
});
