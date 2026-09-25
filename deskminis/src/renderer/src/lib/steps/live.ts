/** 最后一个回合是不是还可能在跑（W2b-11a 写在 StageChat 里，W2b-11d 挪到这里，单测见 tests/renderer-step-status.test.ts）。
 *
 *  为什么抽出来：对话流（StageChat）给步骤定状态、右栏「改动」清单（WorkspacePanel → lib/artifacts/collect）判一次写入算不算改动，
 *  都要知道「最后一个回合还在不在跑」——在跑的话，它里面没有结果的工具只是结果还没到（pending），不是中断。
 *  两处各写一份的话，哪天一处改了判据、另一处没改，同一步在对话流里画成还在等、在改动清单里却已经消失（或反过来）。
 *  lib/ 下别的模块都是纯函数，这一个依赖 vue：判据要看 running 落下的那一拍历史换没换，只有 watch 看得到「那一拍」。
 *  每个调用方各有一份自己的 watch：WorkspacePanel 常驻（AppShell 用 v-show），从应用启动起每一拍都看得到；
 *  StageChat 在会话视图才挂载，挂载前的那一拍它看不到，与挪出来之前一样。
 *
 *  判据：running 为真时当然是。另有一小段：running 落下之后、open() 把历史重取回来之前（一次 RPC 往返），
 *  手里的 messages 还是回合跑着时取的。里面若有这个回合跑到一半的步骤，它们的结果其实已经落库、只是还没取回来，
 *  这时就判「已中断」的话，收尾会闪一下假的中断标。这样的 messages 不只中途接上（midRun）的回合才有：
 *  本窗口发起的回合，用户中途点一下当前会话（NavRail 的会话行、搜索结果、定时页「打开最近一次会话」都无条件 chat.open），
 *  同会话 open() 不动 running / midRun，也会把跑到一半的步骤取进来。所以不看 midRun，看 running 落下的那一拍历史换没换：
 *  - 没换：turnEnd / error 之后 open() 的重取还在路上；换会话时 open() 也是先落 running、历史 await 回来才换
 *    （那个会话确实还在跑）。记下这份 messages，它被换掉之前仍按还在跑处理。
 *  - 换了：发送被拒时 store 在同一拍里用新数组撤掉乐观消息、再落 running；删会话回欢迎页同理。不按还在跑处理——
 *    被拒之后不会重取历史，按还在跑处理的话，上一回合真悬空的工具就一直画成没事。
 *  watch 用默认的 pre：同一拍里的几处改动合成一次回调，并在这一拍渲染之前定好 settling。
 *  改成 sync 的话，「换数组、落 running」会拆成两次回调，第二次看到的历史像是没换过。 */
import { computed, shallowRef, watch, type ComputedRef } from 'vue';

/** chat：chat store（只读 running 与 messages）。须在组件 setup（或别的 effectScope）里调用，watch 随作用域停掉。 */
export function useLastTurnLive(chat: { readonly running: boolean; readonly messages: unknown }): ComputedRef<boolean> {
  const settling = shallowRef<unknown>(null);
  watch([() => chat.running, () => chat.messages], ([running, msgs], [wasRunning, oldMsgs]) => {
    settling.value = wasRunning && !running && msgs === oldMsgs ? msgs : null;
  });
  return computed(() => chat.running || (settling.value !== null && settling.value === chat.messages));
}
