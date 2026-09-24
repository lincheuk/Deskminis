/**
 * Z2 · 会话 / 助手模型绑定的归一化与描述（纯模块 lib/models/binding）。
 *
 * 绑定值三种形态（M2b 约定）：'provider:<id>' | 'group:<id>' | 空 = 跟随默认；
 * J2 之前的存量是裸 provider id（后端兼容分支按 provider 解）。
 * 这套判断此前在 NavRail（bindingValue）与 StageAssistants（providerNameOf）各写一份——
 * J2 修过的格式分叉在 T 波换壳时回过一次魂，所以收成一处、单测钉死。
 *
 * describeBinding 是输入卡模型胶囊的数据源：立项探针实测胶囊**无视会话绑定**、永远显示默认模型，
 * 绑到组或绑到别的模型时界面在撒谎（教训 §7-3）。
 */
import { describe, it, expect } from 'vitest';
import { normalizeBinding, describeBinding, groupChain } from '../src/renderer/src/lib/models/binding';

const P = [
  { id: 'P1', name: '工作号', modelId: 'gpt-4o' },
  { id: 'P2', name: '本地', modelId: 'qwen3' },
  { id: 'P3', name: '无模型名' },
];
const G = [
  { id: 'G1', name: '主备', memberIds: ['P1', 'P2'] },
  { id: 'G2', name: '全删了', memberIds: ['GONE'] },
];

describe('normalizeBinding', () => {
  it('空 / undefined / null → 空串（跟随默认）', () => {
    expect(normalizeBinding('')).toBe('');
    expect(normalizeBinding(undefined)).toBe('');
    expect(normalizeBinding(null)).toBe('');
  });
  it('带前缀的原样返回', () => {
    expect(normalizeBinding('provider:P1')).toBe('provider:P1');
    expect(normalizeBinding('group:G1')).toBe('group:G1');
  });
  it('裸 id（J2 之前的存量）补 provider: 前缀——不补就会错显成「跟随默认」', () => {
    expect(normalizeBinding('P2')).toBe('provider:P2');
  });
});

describe('describeBinding', () => {
  // W2b-5 重指（止血设计稿 §2「胶囊『默认 · X』改在纯模块 binding.ts」、renderer.md W2b-modelbar）：
  // 未绑定时胶囊原先只显示裸模型名，和「绑定到同一个模型」长得一模一样——用户分不清这条消息是跟着默认走
  // （换默认就跟着换），还是会话自己钉死的。label 只有输入卡胶囊在消费，前缀加在这一处；short / title 不变。
  it('未绑定 → 「默认 · 」+ 默认 provider 的模型 id', () => {
    expect(describeBinding('', P, G, 'P2')).toEqual({
      kind: 'default', label: '默认 · qwen3', short: '默认模型', title: '跟随默认模型：本地 · qwen3', missing: false,
    });
  });
  it('后端默认已失效 → 回落列表第一个（与 store.refreshProviders 同一策略），同样带「默认 · 」', () => {
    expect(describeBinding(undefined, P, G, 'GONE').label).toBe('默认 · gpt-4o');
  });
  it('默认 provider 没有模型 id → 「默认 · 」+ 名称', () => {
    expect(describeBinding(null, P, G, 'P3').label).toBe('默认 · 无模型名');
  });
  it('绑定了具体模型或模型组（含已删除）→ label 不带「默认 · 」：那不是跟随默认', () => {
    for (const b of ['provider:P2', 'P2', 'group:G1', 'group:G2', 'provider:GONE', 'group:NOPE']) {
      expect(describeBinding(b, P, G, 'P2').label.startsWith('默认 · '), b).toBe(false);
    }
  });
  it('一个 provider 都没配 → 「未配置模型」，这不是绑定失效', () => {
    expect(describeBinding('', [], [], '')).toEqual({
      kind: 'default', label: '未配置模型', short: '默认模型', title: '还没有配置任何模型', missing: false,
    });
  });
  it('provider: 绑定 → 模型 id 作 label、名称作 short；没有模型 id 时 label 退回名称', () => {
    expect(describeBinding('provider:P1', P, G, 'P2')).toEqual({
      kind: 'provider', label: 'gpt-4o', short: '工作号', title: '已绑定：工作号 · gpt-4o', missing: false,
    });
    expect(describeBinding('provider:P3', P, G, 'P2').label).toBe('无模型名');
  });
  it('裸 id 绑定按 provider 解', () => {
    expect(describeBinding('P1', P, G, 'P2').kind).toBe('provider');
    expect(describeBinding('P1', P, G, 'P2').label).toBe('gpt-4o');
  });
  it('绑定的 provider 已删 → missing，如实说「已删除」（发送会报 provider 不存在）', () => {
    const v = describeBinding('provider:GONE', P, G, 'P2');
    expect(v.missing).toBe(true);
    expect(v.kind).toBe('provider');
    expect(v.label).toBe('绑定的模型已删除');
    expect(v.short).toBe('已删除的模型');
  });
  it('group: 绑定 → label 是组名、short 带「组 ·」、title 给出整条降级链', () => {
    expect(describeBinding('group:G1', P, G, 'P2')).toEqual({
      kind: 'group', label: '主备', short: '组 · 主备', title: '模型组「主备」：工作号 → 本地（按顺序降级）', missing: false,
    });
  });
  it('绑定的组已删 → missing', () => {
    const v = describeBinding('group:NOPE', P, G, 'P2');
    expect(v).toMatchObject({ kind: 'group', missing: true, label: '绑定的模型组已删除', short: '已删除的模型组' });
  });
  it('组还在但成员全删 → missing（后端会报「模型组无可用成员」）', () => {
    const v = describeBinding('group:G2', P, G, 'P2');
    expect(v.missing).toBe(true);
    expect(v.label).toBe('全删了（无可用成员）');
    expect(v.title).toContain('模型组无可用成员');
  });
});

describe('groupChain', () => {
  it('按成员顺序给名字，已删成员如实标出，live 只数还在的', () => {
    expect(groupChain(G[0], P)).toEqual({ names: ['工作号', '本地'], live: 2 });
    expect(groupChain({ id: 'X', name: 'x', memberIds: ['P2', 'GONE', 'P1'] }, P)).toEqual({ names: ['本地', '（已删除）', '工作号'], live: 2 });
  });
});
