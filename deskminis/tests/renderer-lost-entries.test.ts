/**
 * Y 波：换壳遗失的入口成批补回（设计稿 docs/specs/2026-09-10-lost-entries-restore-design.md）。
 *
 * T 波换壳丢掉的六项入口——会话行 ⋮ 菜单 / 会话级禁用 MCP / 同步暂停 / 助手技能绑定 / 消息锚点轨——
 * 逐项从旧实现（dddbbf8^ 的 SessionList / ChatView / SettingsModal / AssistantSettings）核对着搬回来。
 * 本文件钉的是「搬回来的东西长什么样」：调用形态 + 那几句不能再丢的交代。
 * 能力入口的存在性由 tests/mu6-capability-wiring.test.ts 的清单管，这里不重复。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(__dirname, '../src/renderer/src/ui/');
const read = (p: string): string => readFileSync(join(UI, p), 'utf8').replace(/\r\n/g, '\n');
const rail = read('NavRail.vue');
const composer = read('Composer.vue');
const devices = read('StageDevices.vue');
const topbar = read('TopBar.vue');
const assistants = read('StageAssistants.vue');
const chatv = read('StageChat.vue');
/** 取某个 class 的 scoped 样式块（不含嵌套花括号的简单规则）。 */
const rule = (src: string, sel: string): string => src.match(new RegExp(`\\n${sel.replace(/\./g, '\\.')}\\s*\\{[^}]*\\}`))?.[0] ?? '';

describe('Y1 — 会话行 ⋮ 菜单（NavRail）', () => {
  it('⋮ 是与会话行并列的独立按钮，不嵌在行按钮里（按钮里不能再嵌按钮）', () => {
    expect(rail).toMatch(/<div class="srw"[^>]*>\s*<button[^>]*class="srow"/);
    expect(rail).toMatch(/<button[^>]*class="smore"[^>]*:title="`\$\{s\.title \|\| '新会话'\} 的更多操作`"[^>]*@click\.stop="toggleMenu\(s\.id\)"/);
  });

  it('菜单行内展开，不浮层（.list 是 overflow:auto，浮层会被裁掉）', () => {
    expect(rail).toMatch(/<div v-if="menuFor === s\.id" class="smenu">/);
    expect(rule(rail, '.smenu')).not.toMatch(/position:\s*absolute|z-index/);
  });

  it('记忆开关按当前态翻转；模型绑定写 provider: 前缀并按前缀归一化回显', () => {
    expect(rail).toMatch(/@click="chat\.setSessionMemory\(s\.id, s\.memoryEnabled === false\)"/);
    expect(rail).toMatch(/@change="chat\.setSessionModelBinding\(s\.id, \(\$event\.target as HTMLSelectElement\)\.value \|\| undefined\)"/);
    expect(rail).toMatch(/:value="'provider:' \+ p\.id"/);
    expect(rail).not.toMatch(/:value="p\.id"/);
    // 旧库存量裸 id：显示时补前缀，否则错显成「跟随全局默认」
    expect(rail).toMatch(/function bindingValue\([^)]*\)[^{]*\{[\s\S]*?startsWith\('provider:'\)[\s\S]*?startsWith\('group:'\)/);
    expect(rail).toMatch(/:value="bindingValue\(s\)"/);
  });

  it('重命名：行内输入预填现标题，后端拒绝原因落在菜单里', () => {
    expect(rail).toMatch(/function startRename\([^)]*\)[^{]*\{[\s\S]*?renameText\.value = s\.title \|\| ''/);
    expect(rail).toMatch(/await chat\.renameSession\(id, renameText\.value\)/);
    expect(rail).toMatch(/catch \(e\) \{\s*renameErr\.value = /);
    expect(rail).toMatch(/<div v-if="renameErr" class="smenu-err">\{\{ renameErr \}\}<\/div>/);
  });

  it('删除走二次确认，且明说不可撤销', () => {
    expect(rail).toMatch(/@click\.stop="confirmDelete = s\.id"/);
    expect(rail).toContain('确认删除？此操作不可撤销。');
    expect(rail).toMatch(/await chat\.deleteSession\(id\)/);
  });
});

describe('Y2 — 会话级禁用 MCP（Composer）', () => {
  it('pill 只在有会话且存在已启用 server 时出现；计数只数已启用 ∩ 已禁用', () => {
    expect(composer).toMatch(/const mcpPillVisible = computed\(\(\) => !!chat\.activeId && enabledMcpServers\.value\.length > 0\)/);
    expect(composer).toMatch(/enabledMcpServers\.value\.filter\(s => sessionMcpDisabled\.value\.includes\(s\.name\)\)\.length/);
    expect(composer).toMatch(/`MCP · 禁 \$\{mcpDisabledCount\.value\}`/);
    expect(composer).toMatch(/<button\s+v-if="mcpPillVisible" class="mcpbtn"/);  // 属性换行是排版自由
  });

  it('面板行内展开，逐台勾「本会话禁用」，整表覆写调 setSessionMcpDisabled，并交代下一回合生效', () => {
    expect(composer).toMatch(/<div v-if="mcpOpen" class="mcpanel">/);
    expect(composer).toMatch(/@change="toggleSessionMcp\(s\.name\)"/);
    expect(composer).toMatch(/await chat\.setSessionMcpDisabled\(chat\.activeId, next\)/);
    expect(composer).toContain('下一回合生效');
  });

  it('名单在有会话后才拉（rpc 此刻必已就绪），空名单才重拉', () => {
    expect(composer).toMatch(/watch\(\(\) => chat\.activeId, \(\) => \{\s*if \(chat\.activeId && chat\.mcpServers\.servers\.length === 0\) void chat\.fetchMcpServers\(\)\.catch\(\(\) => \{\}\);\s*\}, \{ immediate: true \}\)/);
  });
});

describe('Y3 — 同步暂停 / 恢复（StageDevices + TopBar）', () => {
  it('设备页有开关，按当前态翻转，文案分暂停 / 恢复', () => {
    expect(devices).toMatch(/@click="chat\.setSyncPaused\(!chat\.syncPaused\)"/);
    expect(devices).toMatch(/\{\{ chat\.syncPaused \? '恢复同步' : '暂停同步' \}\}/);
    expect(devices).toMatch(/onMounted\(\(\) => \{[^}]*chat\.refreshSyncPaused\(\)/);
  });

  it('那句「暂停的只是设备间同步，不会中断正在执行的任务」不能再丢', () => {
    expect(devices).toContain('不会中断');
    expect(devices).toContain('停止');
    expect(devices).toContain('保留到下次启动');
  });

  it('标题栏状态点认 paused：橙点 + title', () => {
    expect(topbar).toMatch(/if \(chat\.syncPaused\) return \{ c: 'var\(--c-warn\)', t: '已暂停设备间同步' \};/);
  });
});

describe('Y4 — 助手 ↔ 技能绑定（StageAssistants）', () => {
  it('表单有 allSkills 复选，保存带 skillIds', () => {
    expect(assistants).toMatch(/const fSkills = ref<string\[\]>\(\[\]\)/);
    expect(assistants).toMatch(/<label v-for="s in chat\.allSkills" :key="s\.id" class="skl"/);
    expect(assistants).toMatch(/:checked="fSkills\.includes\(s\.id\)" @change="toggleSkill\(s\.id\)"/);
    expect(assistants).toMatch(/skillIds: fSkills\.value/);
    expect(assistants).toMatch(/fSkills\.value = \[\.\.\.a\.skillIds\]/);
  });

  it('提示句与空态都在；列表卡标出技能数；进页刷新 allSkills', () => {
    expect(assistants).toContain('不勾任何项 = 跟随全局启用集');
    expect(assistants).toContain('（全局已停用）');
    expect(assistants).toContain('尚未安装任何技能');
    expect(assistants).toMatch(/\{\{ a\.skillIds\.length \}\} 项技能/);
    expect(assistants).toMatch(/onMounted\(\(\) => \{[^}]*chat\.refreshAllSkills\(\)/);
  });
});

describe('Y5 — 消息锚点导航轨（StageChat）', () => {
  it('turn 节带 data-turn-id，实时回合是 live', () => {
    expect(chatv).toMatch(/<section v-for="t in turns" :key="t\.id" class="turn" :data-turn-id="t\.id">/);
    expect(chatv).toMatch(/<section v-if="hasLive" class="turn" data-turn-id="live">/);
  });

  it('≥3 回合才显示；每回合一个原生按钮点，title 是首 24 字；点击平滑滚到块首', () => {
    expect(chatv).toMatch(/const railVisible = computed\(\(\) => turns\.value\.length >= 3\)/);
    expect(chatv).toMatch(/<nav v-if="railVisible" class="trail" aria-label="回合导航">/);
    expect(chatv).toMatch(/<button\s+v-for="t in turns" :key="t\.id" type="button" class="tdot"\s+:title="railTitle\(t\)" :aria-label="railTitle\(t\)"\s+@click="jumpTurn\(t\.id\)"/);
    expect(chatv).toMatch(/\.slice\(0, 24\)/);
    expect(chatv).toMatch(/scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
    expect(chatv).toMatch(/<button\s+v-if="hasLive" type="button" class="tdot live"/);
  });

  it('轨道 z-index 低于标题栏槽位，且不自己写焦点环（环收在 theme.css）', () => {
    const z = Number(rule(chatv, '.trail').match(/z-index:\s*(\d+)/)?.[1] ?? 999);
    expect(z).toBeLessThan(50);
    expect(chatv).not.toMatch(/\.tdot:focus-visible/);
  });
});
