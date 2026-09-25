/** MU2b Task 3：产物 tab（ArtifactsPanel）——collect 纯模块单测 + 组件/chat.ts/FilesPanel/App.vue 源文本守卫。
 *  数据源契约：历史 messages parts[].value = { name, input }（toolUse）；实时 toolCards 补 input（chat.ts 增量）。 */
/* T6e-3 集体退场说明：本文件有若干例随实现退场。理由——
   产物面板内部实现（卡片列表内部锚、pendingFilePreview 清空时机、switchRightTab 注入）——新树里产物是 WorkspacePanel 的「改动」tab，点开走 emit('open') 交给外壳，没有跨面板注入。保留的是 lib/artifacts/collect 纯模块 5 例（那才是这条能力的内核）与 store 断言。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { collectArtifacts } from '../src/renderer/src/lib/artifacts/collect';

const root = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const artifactsPanel = fs.readFileSync(path.join(root, 'src/renderer/src/ui/WorkspacePanel.vue'), 'utf8');
const chatTs = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');
const filesPanel = fs.readFileSync(path.join(root, 'src/renderer/src/ui/WorkspacePanel.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/ui/AppShell.vue'), 'utf8');

/* W2b-11d：历史消息照后端落库的形态造——assistant 消息里是 toolUse（带 toolUseId），结果在随后那条只装 toolResult 的 user 消息里
   （loop.ts 等一批工具跑完才写这条）。改动清单从这一步起按结果判：配不到结果、所在回合也不在跑的，不再算改动。
   下面 MU2b / V8 几例原先只给 toolUse、不给结果，测的是路径相对化、增删数、去重、office_write；现在给它们配上成功的结果，测的东西不变。 */
const user = (text: string) => ({ role: 'user', parts: [{ type: 'text', value: text }] });
const use = (toolUseId: string, name: string, input: unknown) =>
  ({ type: 'toolUse', value: { toolUseId, name, input: typeof input === 'string' ? input : JSON.stringify(input) } });
/** 一个工具结果。success 缺省（undefined）时不写这个字段——老库里的结果就是这样。 */
const result = (toolUseId: string, success?: boolean) =>
  ({ type: 'toolResult', value: success === undefined ? { toolUseId, output: 'o' } : { toolUseId, output: 'o', success } });
const asst = (...parts: unknown[]) => ({ role: 'assistant', parts });
/** 结果载体：只装工具结果的 user 消息，不开新回合。 */
const carrier = (...parts: unknown[]) => ({ role: 'user', parts });
/** 做完了、结果成功的一步：toolUse 加它的结果载体。 */
const okStep = (toolUseId: string, name: string, input: unknown) => [asst(use(toolUseId, name, input)), carrier(result(toolUseId, true))];

describe('MU2b Task 3 产物 tab：lib/artifacts/collect 纯模块（5 例）', () => {
  it('空输入（空 messages + 空 toolCards）→ []', () => {
    expect(collectArtifacts([], [], false)).toEqual([]);
  });

  it('历史 messages 的 file_write → write 卡；guest/host 前缀相对化', () => {
    const messages = [
      user('写两个文件'),
      asst(
        use('T1', 'file_write', { path: '/var/minis/workspace/src/a.ts', content: 'x' }),
        use('T2', 'file_write', { path: 'C:\\d\\sessions\\SID1\\workspace\\sub\\b.md', content: 'y' }),
      ),
      carrier(result('T1', true), result('T2', true)),
    ];
    const out = collectArtifacts(messages, [], false);
    expect(out).toEqual([
      { path: 'src/a.ts', kind: 'write', add: undefined, del: undefined },
      { path: 'sub/b.md', kind: 'write', add: undefined, del: undefined },
    ]);
  });

  it('file_edit → edit 卡 + 增删数（extractEditPair + diffLines + countAddDel）', () => {
    const input = { path: '/var/minis/workspace/c.txt', old_string: 'l1\nl2\nl3', new_string: 'l1\nl2x\nl3\nl4' };
    const out = collectArtifacts([user('改一下'), ...okStep('T1', 'file_edit', input)], [], false);
    expect(out).toEqual([{ path: 'c.txt', kind: 'edit', add: 2, del: 1 }]);
  });

  it('同路径 write+edit 去重：edit 优先（增删数保留）；edit 后的 write 不覆盖', () => {
    const editInput = { path: 'd.txt', old_string: 'a', new_string: 'a\nb' };
    const writeInput = { path: 'd.txt', content: 'z' };
    const messages = [user('写再改'), ...okStep('T1', 'file_write', writeInput), ...okStep('T2', 'file_edit', editInput)];
    expect(collectArtifacts(messages, [], false)).toEqual([{ path: 'd.txt', kind: 'edit', add: 1, del: 0 }]);
    // 顺序反过来也一样（write 不覆盖 edit）
    const rev = [user('改再写'), ...okStep('T1', 'file_edit', editInput), ...okStep('T2', 'file_write', writeInput)];
    expect(collectArtifacts(rev, [], false)).toEqual([{ path: 'd.txt', kind: 'edit', add: 1, del: 0 }]);
  });

  it('实时 toolCards 补充（messages 空）；坏 JSON / 缺 path / 非写编工具一律跳过', () => {
    const cards = [
      { name: 'file_write', input: JSON.stringify({ path: '/var/minis/workspace/e.txt', content: '1' }) },
      { name: 'file_write', input: '{bad json' },
      { name: 'file_edit', input: JSON.stringify({ no_path: true }) },
      { name: 'shell_execute', input: JSON.stringify({ command: 'ls' }) },
    ];
    expect(collectArtifacts([], cards, false)).toEqual([{ path: 'e.txt', kind: 'write', add: undefined, del: undefined }]);
  });
});

describe('W2b-11d：改动清单按工具结果判（与对话流给步骤定状态同一判据：lib/steps/status）', () => {
  // 立项事实：collectArtifacts 原先只看工具调用本身——失败的、历史回合里中断没结果的 file_write / file_edit / office_write
  // 也列成改动，file_edit 还带着增删数。与 W2b-11a 修掉的「没结果的工具显示成功」是同一类界面假话（设计稿 §4.1 W2b-11d）。
  // 规则：成功（含老库无 success 字段）的照旧列；失败的不列；没有结果、所在回合已不在跑（已中断 · 结果未知）的不列；
  // 所在回合还在跑、结果还没到的照旧列。
  const WRITES = [
    ['file_write', { path: 'w.txt', content: 'x' }],
    ['file_edit', { path: 'e.txt', old_string: 'a', new_string: 'a\nb' }],
    ['office_write', { path: '周报.docx', content: '{}' }],
  ] as const;

  it('失败的写工具（success === false）不算改动：file_write / file_edit / office_write 都一样，file_edit 也不带出增删数', () => {
    for (const [name, input] of WRITES) {
      const messages = [user('做一下'), asst(use('T1', name, input)), carrier(result('T1', false))];
      expect(collectArtifacts(messages, [], false), name).toEqual([]);
      // 回合还在跑也一样：已经有结果的步骤不看回合
      expect(collectArtifacts(messages, [], true), `${name}（回合在跑）`).toEqual([]);
    }
  });

  it('历史回合里没有结果的写工具（回合已不在跑：已中断 · 结果未知）不算改动', () => {
    for (const [name, input] of WRITES) {
      expect(collectArtifacts([user('做一下'), asst(use('T1', name, input))], [], false), name).toEqual([]);
    }
    // 没有 toolUseId 的老载荷配不到任何结果，按没有结果处理
    const noId = { type: 'toolUse', value: { name: 'file_write', input: JSON.stringify({ path: 'n.txt' }) } };
    expect(collectArtifacts([user('做一下'), asst(noId)], [], false)).toEqual([]);
  });

  it('最后一个回合还在跑：它里面还没有结果的写工具照旧列（结果还没到是正常的）；更早回合里悬空的仍不列', () => {
    const messages = [
      user('第一回合'), asst(use('T1', 'file_write', { path: '崩溃时在写.txt' })),
      user('第二回合'), ...okStep('T2', 'file_write', { path: '写完了.txt' }),
      // 结果载体不开新回合：T3 与 T2 同在第二回合（与 StageChat 切回合同一判据，lastTurnStart）
      asst(use('T3', 'file_edit', { path: '还在改.txt', old_string: 'a', new_string: 'b' })),
    ];
    expect(collectArtifacts(messages, [], true).map(a => a.path)).toEqual(['写完了.txt', '还在改.txt']);
    // 同一段历史，回合不在跑了：T3 也成了中断，只剩成功的那个
    expect(collectArtifacts(messages, [], false).map(a => a.path)).toEqual(['写完了.txt']);
  });

  it('本窗口刚发出新的一条（乐观消息在末尾）：上一个回合里悬空的写工具不在正在跑的回合里，不列', () => {
    const messages = [user('第一回合'), asst(use('T1', 'file_write', { path: '悬空.txt' })), user('第二回合')];
    expect(collectArtifacts(messages, [], true)).toEqual([]);
  });

  it('老库里没有 success 字段的结果照旧算改动（只有 success === false 才是失败，与 stepStatus 同一判据）', () => {
    const messages = [user('写'), asst(use('T1', 'file_write', { path: '老库.txt' })), carrier(result('T1'))];
    expect(collectArtifacts(messages, [], false).map(a => a.path)).toEqual(['老库.txt']);
  });

  it('结果按 toolUseId 配：别的步骤的成功结果不算这一步的', () => {
    const messages = [
      user('写两个'),
      asst(use('T1', 'file_write', { path: 'a.txt' }), use('T2', 'file_write', { path: 'b.txt' })),
      carrier(result('T1', true)),
    ];
    expect(collectArtifacts(messages, [], false).map(a => a.path)).toEqual(['a.txt']);
  });

  it('实时 toolCards：还没到 toolEnd 的照旧列，成功的列，失败的（success === false）不列', () => {
    const cards = [
      { name: 'file_write', input: JSON.stringify({ path: '还在写.txt' }) },
      { name: 'file_edit', input: JSON.stringify({ path: '改好了.txt', old_string: 'a', new_string: 'b' }), success: true },
      { name: 'office_write', input: JSON.stringify({ path: '写坏了.xlsx' }), success: false },
      { name: 'file_edit', input: JSON.stringify({ path: '改坏了.txt', old_string: 'a', new_string: 'b' }), success: false },
    ];
    // 实时卡片就是正在跑的那个回合的，lastTurnLive 管不到它们（与 StageChat 的 liveSteps 一样绝不判中断）
    for (const live of [true, false]) {
      expect(collectArtifacts([], cards, live).map(a => a.path), `lastTurnLive=${live}`).toEqual(['还在写.txt', '改好了.txt']);
    }
  });

  it('同一路径：失败的改不顶掉成功的写，也不带出增删数；成功的改照旧优先于写', () => {
    const write = { path: 'd.txt', content: 'z' };
    const badEdit = { path: 'd.txt', old_string: 'a', new_string: 'a\nb\nc' };
    const goodEdit = { path: 'd.txt', old_string: 'a', new_string: 'a\nb' };
    const failedAfter = [user('写再改'), ...okStep('T1', 'file_write', write), asst(use('T2', 'file_edit', badEdit)), carrier(result('T2', false))];
    expect(collectArtifacts(failedAfter, [], false)).toEqual([{ path: 'd.txt', kind: 'write', add: undefined, del: undefined }]);
    const goodAfterBad = [user('改两次'), asst(use('T1', 'file_edit', badEdit)), carrier(result('T1', false)), ...okStep('T2', 'file_edit', goodEdit)];
    expect(collectArtifacts(goodAfterBad, [], false)).toEqual([{ path: 'd.txt', kind: 'edit', add: 1, del: 0 }]);
  });
});

describe('MU2b Task 3 产物 tab：组件与接线守卫（4 例）', () => {
  it('chat.ts 纯增量：state 追加 pendingFilePreview；toolCards 元素补 input（产物路径数据源）', () => {
    expect(chatTs).toContain("pendingFilePreview: null as string | null");
    expect(chatTs).toContain("input?: string");
  });

  it('改动视图接进外壳（T6e-3 重指：三个面板合成 WorkspacePanel 的三个 tab）', () => {
    expect(app).toMatch(/import WorkspacePanel from '\.\/WorkspacePanel\.vue'/);
    expect(artifactsPanel).toMatch(/tab === 'changes'/);
    // 「惰性挂载 + provide('switchRightTab')」那套随旧外壳退场：
    // 工作区面板现在常驻，切 tab 是面板自己的事，不必外壳注入切换函数。
  });
});

describe('V8 · office_write 也是产物', () => {
  /** U 波加了 office_write（产出 .docx/.xlsx/.pptx）。收集器不认它，
   *  agent 做出来的文档在「改动」清单里就凭空消失了——数据在、界面看不见。 */
  it('office_write 计入产物，kind 为 write', () => {
    const out = collectArtifacts([user('做周报'), ...okStep('T1', 'office_write', { path: '周报.docx', content: '{}' })], [], false);
    expect(out).toEqual([{ path: '周报.docx', kind: 'write', add: undefined, del: undefined }]);
  });

  it('实时 toolCards 侧同样认（回合跑到一半就该看得见）', () => {
    const out = collectArtifacts([], [{ name: 'office_write', input: JSON.stringify({ path: 'a/b/表.xlsx' }) }], true);
    expect(out.map(a => a.path)).toEqual(['a/b/表.xlsx']);
  });
});
