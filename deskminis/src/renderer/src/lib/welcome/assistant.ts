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

/** applyStateOf 从 store 读的那几样（字段名与 stores/chat.ts 的 state 一致，输入卡直接把 store 实例传进来）。
 *  会话的 assistantId / modelBinding 也收 null：后端 getSession 把 NULL 列映射成 undefined、经 JSON 到这里是缺字段，
 *  但这份数据跨进程来、store 的声明管不到运行时，null 也得当作未绑——绝不能被当成「绑了卡片上选的那个」。 */
export interface ApplyStoreView {
  activeId: string;
  messages: readonly unknown[];
  sessions: readonly { id: string; assistantId?: string | null; modelBinding?: string | null }[];
  welcomeAssistantId: string;
}

/** W2b-4b：输入卡的 send() 与模型胶囊共用的入参，一处组装。
 *  为什么挪进纯模块：此前在 Composer 里就地拼，.vue 不在 typecheck 覆盖内、源码守卫只认得调用头——
 *  boundAssistantId 错取成 welcomeAssistantId（bound 恒等于 selected，永不套用，原来的谎回来）、
 *  sessionBinding 错取成 ''（胶囊永远说默认，Z5 的谎回来）都能一路全绿。在这里可以用仿 store 的夹具逐字段单测。
 *  - 当前会话按 activeId 在列表里找；找不到（没有会话，或刚建好、列表还没重拉）就当作未绑、没有会话绑定；
 *  - hasMessages 与 AppShell.vue 的 inChat 同一判据（见文件头）。 */
export function applyStateOf(chat: ApplyStoreView): ApplyState & { sessionBinding: string } {
  const session = chat.sessions.find(s => s.id === chat.activeId);
  return {
    activeId: chat.activeId,
    hasMessages: chat.messages.length > 0,
    boundAssistantId: session?.assistantId ?? '',
    selected: chat.welcomeAssistantId,
    sessionBinding: session?.modelBinding ?? '',
  };
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
