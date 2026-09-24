/** W2b-4：欢迎页选助手——发送前要不要给当前会话套用 / 解绑助手，以及胶囊该预告哪个绑定（纯函数，单测见
 *  tests/renderer-welcome-assistant.test.ts）。
 *
 *  为什么需要：有活动会话但它还是空的时候（NavRail「新建会话」最常走到这里），界面显示的也是欢迎页，
 *  副标题承诺「已选 X——直接输入即以该预设开始」。此前发送只在没有会话时才按选择建会话，空会话这条路直接发，
 *  助手从没套上。现在 store 的 welcomeAssistantId 是「当前空会话的助手选择」：open() 时从会话已绑的助手初始化，
 *  用户在卡片上改选后，与会话的绑定不一致，发送前按这里的判断调 chat.sessions.applyAssistant 对齐。
 *
 *  hasMessages 的判据必须与 AppShell.vue 的 inChat（`!!chat.activeId && chat.messages.length > 0`）一致：
 *  inChat 为假才显示欢迎页、才看得见助手卡片，这里也只在同样的条件下才动会话的助手。 */

export interface ApplyState {
  /** 当前会话 id；'' = 还没有会话（欢迎页首发，由「建会话」分支带 assistantId 一步到位）。 */
  activeId: string;
  /** 当前会话是否已有消息（有消息就不是欢迎页；后端 applyAssistant 也会拒）。 */
  hasMessages: boolean;
  /** 会话已绑的助手 id（未绑为 ''）。可能指向已删除的助手——那时它也原样镜像进 selected，两边相等就不动。 */
  boundAssistantId: string;
  /** 欢迎页的选择（store.welcomeAssistantId）；'' = 没选 / 取消了选择。 */
  selected: string;
}

/** null = 不动；'' = 解绑；其它 = 套用这个助手。 */
export function assistantToApply(s: ApplyState): string | null {
  if (!s.activeId) return null;
  if (s.hasMessages) return null;
  if (s.boundAssistantId === s.selected) return null;
  return s.selected;
}

/** 胶囊显示的绑定：发送前就显示发送后真正生效的那一个。
 *  - 没有会话：发送时按所选助手建会话，生效的是所选助手的绑定（没选或助手不绑模型 = 跟随默认，返回 ''）；
 *  - 空会话待套用 / 待解绑：后端会把模型绑定重置成新助手的（或清空）——会话上手动设过的绑定也会被盖掉，这里如实预告；
 *  - 其余（不需要套用）：会话自己的绑定。它可能与助手的不同（接力照抄了原会话的绑定、降级后改绑过），以会话为准。 */
export function previewBinding(
  s: ApplyState & { sessionBinding: string },
  assistants: { id: string; modelBinding?: string }[],
): string {
  const bindingOf = (id: string): string => (id ? (assistants.find(a => a.id === id)?.modelBinding ?? '') : '');
  if (!s.activeId) return bindingOf(s.selected);
  const want = assistantToApply(s);
  return want === null ? s.sessionBinding : bindingOf(want);
}
