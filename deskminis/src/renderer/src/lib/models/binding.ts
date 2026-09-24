/** Z2：会话 / 助手的模型绑定——归一化与描述（纯函数，单测见 tests/models-binding.test.ts）。
 *
 *  绑定值三种形态（M2b 约定）：'provider:<id>' | 'group:<id>' | 空 = 跟随默认模型。
 *  J2 之前的存量是**裸 provider id**（后端 chat.prompt 的兼容分支按 provider 解），这里同样认。
 *
 *  为什么收成一处：这套判断此前在 NavRail（bindingValue）与 StageAssistants（providerNameOf）各写一份，
 *  J2 修过的「前缀格式分叉」在 T 波换壳时回过一次魂（T6a2）。再加上模型组，第三份就该是这里。 */

export interface ProviderLite { id: string; name: string; modelId?: string }
export interface GroupLite { id: string; name: string; memberIds: string[] }

/** label：胶囊上那几个字；short：列表标签 / 下拉里的短名；title：鼠标停上去的完整交代；
 *  missing：绑定指向的东西已经没了（发送会报错）——界面必须变色，不能照常显示。 */
export interface BindingView {
  kind: 'default' | 'provider' | 'group';
  label: string; short: string; title: string; missing: boolean;
}

/** 空 → ''；带前缀原样；裸 id 补 'provider:'（不补就会被当成「跟随默认」错显）。 */
export function normalizeBinding(b: string | null | undefined): string {
  if (!b) return '';
  if (b.startsWith('provider:') || b.startsWith('group:')) return b;
  return 'provider:' + b;
}

/** 组的成员链：按顺序给名字，已删的成员如实标「（已删除）」；live 只数还在的（后端解析同样跳过已删的）。 */
export function groupChain(g: GroupLite, providers: ProviderLite[]): { names: string[]; live: number } {
  let live = 0;
  const names = g.memberIds.map((id) => {
    const p = providers.find(x => x.id === id);
    if (!p) return '（已删除）';
    live++;
    return p.name;
  });
  return { names, live };
}

const REBIND_HINT = '发送会报错——请重新选择模型';

export function describeBinding(
  binding: string | null | undefined,
  providers: ProviderLite[],
  groups: GroupLite[],
  defaultId: string,
): BindingView {
  const b = normalizeBinding(binding);
  if (b.startsWith('group:')) {
    const g = groups.find(x => x.id === b.slice('group:'.length));
    if (!g) return { kind: 'group', label: '绑定的模型组已删除', short: '已删除的模型组', title: `绑定的模型组已被删除，${REBIND_HINT}`, missing: true };
    const { names, live } = groupChain(g, providers);
    if (live === 0) {
      return {
        kind: 'group', label: `${g.name}（无可用成员）`, short: `组 · ${g.name}`,
        title: `模型组「${g.name}」的成员都已删除，发送会报「模型组无可用成员」`, missing: true,
      };
    }
    return { kind: 'group', label: g.name, short: `组 · ${g.name}`, title: `模型组「${g.name}」：${names.join(' → ')}（按顺序降级）`, missing: false };
  }
  if (b.startsWith('provider:')) {
    const p = providers.find(x => x.id === b.slice('provider:'.length));
    if (!p) return { kind: 'provider', label: '绑定的模型已删除', short: '已删除的模型', title: `绑定的模型已被删除，${REBIND_HINT}`, missing: true };
    return { kind: 'provider', label: p.modelId || p.name, short: p.name, title: `已绑定：${p.name} · ${p.modelId || '未指定模型'}`, missing: false };
  }
  // 跟随默认：后端默认已失效时回落列表第一个——与 store.refreshProviders 同一策略，两处必须一致
  const d = providers.find(x => x.id === defaultId) ?? providers[0];
  if (!d) return { kind: 'default', label: '未配置模型', short: '默认模型', title: '还没有配置任何模型', missing: false };
  // W2b-5：label 带「默认 · 」前缀。裸模型名和「绑到同一个模型」长得一模一样，用户分不清这条消息是跟着默认走
  // （欢迎页 ModelBar 换默认它就跟着换），还是会话 / 助手自己钉死的。label 只有输入卡胶囊在用，前缀只加这里；
  // short 已经是「默认模型」、title 已经写明「跟随默认模型」，都不动。
  return { kind: 'default', label: `默认 · ${d.modelId || d.name}`, short: '默认模型', title: `跟随默认模型：${d.name} · ${d.modelId || '未指定模型'}`, missing: false };
}
