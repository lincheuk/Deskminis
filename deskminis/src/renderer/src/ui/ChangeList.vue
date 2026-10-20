<script setup lang="ts">
/** F08：「改动」页的取数外壳。取 checkpoints.list、订阅变更提示、发预检与恢复、改容量，把状态原样喂给展示件。
 *  清单来自引擎里的检查点记录（磁盘事实）；没有检查点的旧改动仍按工具调用入参列在下面一节，只能看、没有恢复入口。
 *  直接 rpc.call（与 WorkspacePanel 取文件树同一做法），不往 store 里加状态。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChangeList, RestorePrecheck, RestoreReport } from '../../../shared/checkpoint';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import { collectArtifacts } from '../lib/artifacts/collect';
import { planRunRestore } from '../lib/changes/model';
import { useLastTurnLive } from '../lib/steps/live';
import ChangeListView from './ChangeListView.vue';

const props = defineProps<{ selected: string | null }>();
const emit = defineEmits<{ (e: 'open', path: string): void; (e: 'review', id: string): void }>();
const chat = useChat();

const list = ref<ChangeList | null>(null);
/** 取清单的错误（远程连接看不了检查点等）。每次重取都重新定。 */
const error = ref('');
/** 预检 / 恢复这次操作本身的错误（整次调用被拒：记录已不在、超过单次上限等）。与取数的错误分开放：
 *  恢复之后紧跟着一次重取，重取成功就把取数的错误清空——合在一起的话这句只闪一下，用户看到的是点了「恢复」什么都没发生。
 *  留到用户收起面板或发起下一次操作。 */
const actionError = ref('');
/** 这个会话的清单取回来过没有（成功或被拒都算）。没取回来之前不列「没有检查点的改动」：
 *  那一节要靠清单里的 coveredToolUseIds 去重，先列出来的话，有检查点的改动会在那里闪一下再消失。 */
const loaded = ref(false);
const expandedRunId = ref<string | null>(null);
const precheck = ref<RestorePrecheck[] | null>(null);
const report = ref<RestoreReport | null>(null);
const busy = ref(false);
const quotaEditing = ref(false);
const quotaError = ref('');

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 重取清单。被拒（远程连接看不了检查点）时显示那一句，下面「没有检查点的改动」照常列。 */
async function load(): Promise<void> {
  const sid = chat.activeId;
  if (!sid) { list.value = null; error.value = ''; loaded.value = true; return; }
  try {
    const got = await rpc.call('checkpoints.list', { sessionId: sid });
    if (chat.activeId !== sid) return;   // 等的时候切了会话：这份不是给现在这个会话的
    list.value = got; error.value = ''; loaded.value = true;
  } catch (e) {
    if (chat.activeId !== sid) return;
    list.value = null; error.value = msgOf(e); loaded.value = true;
  }
}

/** checkpoints.changed 只是「请重取」的提示，可丢。 */
function onChanged(p: { sessionId?: string } | undefined): void {
  if (!p || p.sessionId === undefined || p.sessionId === chat.activeId) void load();
}
onMounted(() => { rpc.on('checkpoints.changed', onChanged); void load(); });
onBeforeUnmount(() => { rpc.off('checkpoints.changed', onChanged); });
watch(() => chat.activeId, () => { collapse(); quotaEditing.value = false; quotaError.value = ''; loaded.value = false; list.value = null; void load(); });
// 回合结束：这一轮写的文件已有记录
watch(() => chat.running, (now, prev) => { if (prev && !now) void load(); });
// F06：重连之后的整体刷新。checkpoints.changed 可丢——断线期间的那几条在重连走快照时不会补发，清单就停在断线前；
// 断线期间结束的回合、别的窗口做的恢复都在其中。展开着的预检与结果不收起：它们是用户正在看的那一次操作的
watch(() => chat.refreshTick, () => { void load(); });

/** 没有检查点的改动：引擎标为已覆盖的写调用不列（已有检查点的，以及由带检查点的引擎执行、没有改变文件的）；
 *  结果还没到的调用也不列——它还不是改动，写成之后有了检查点会出现在按运行分组的清单里。
 *  正在跑的这一轮的实时卡片：清单取得到时不看。取得到 = 连的是带检查点的本机引擎，这一轮的写入都是它执行的，
 *  写成了就有检查点（由上面的清单列），没有检查点的只可能是内容没变或没写成；而「已覆盖」的名单是上一次取清单时的，
 *  还不认识刚跑完的这一步——照着它判，一次没有改动文件的写入会在这一节挂到下一次重取为止。清单取不到时才用实时卡片。 */
const lastTurnLive = useLastTurnLive(chat);
const legacy = computed(() => (loaded.value ? collectArtifacts(
  chat.messages, list.value ? [] : chat.toolCards, lastTurnLive.value,
  { skipToolUseIds: new Set(list.value?.coveredToolUseIds ?? []), settledOnly: true },
) : []));

function collapse(): void { expandedRunId.value = null; precheck.value = null; report.value = null; actionError.value = ''; }

/** 「恢复这次运行…」：先预检，就地展开逐项结论；不直接恢复。 */
async function inspectRun(runId: string): Promise<void> {
  const sid = chat.activeId;
  const group = list.value?.groups.find(g => g.runId === runId);
  if (!sid || !group) return;
  expandedRunId.value = runId; report.value = null; precheck.value = null; actionError.value = ''; busy.value = true;
  try { precheck.value = await rpc.call('checkpoints.inspect', { sessionId: sid, ids: group.changes.map(c => c.id) }); }
  catch (e) { collapse(); actionError.value = msgOf(e); }
  finally { busy.value = false; }
}

/** 确认后恢复。发的是预检就绪的记录，加上「挡着它的后续改动也都在这次要发的记录里」的那些（planRunRestore）：
 *  同一次运行里同一个文件改了多次时整条链一起发，引擎在锁内从新到旧逐项重判，一次回到这次运行最早那次改动之前。
 *  发什么由外壳按预检结果算，不由展示件传：展示件上的数字与这里发出去的出自同一个函数。逐项结果留在组内，直到用户收起。 */
async function restoreRun(): Promise<void> {
  const sid = chat.activeId;
  const ids = planRunRestore(precheck.value ?? []).send.map(i => i.id);
  if (!sid || ids.length === 0) return;
  actionError.value = ''; busy.value = true;
  try { report.value = await rpc.call('checkpoints.restore', { sessionId: sid, ids, confirm: true }); }
  catch (e) { actionError.value = msgOf(e); }
  finally { busy.value = false; }
  void load();
}

async function setQuota(bytes: number): Promise<void> {
  busy.value = true;
  try {
    await rpc.call('checkpoints.setQuota', { quotaBytes: bytes });
    quotaEditing.value = false; quotaError.value = '';
    await load();
  } catch (e) { quotaError.value = msgOf(e); }   // 越界的错误原样显示
  finally { busy.value = false; }
}
</script>

<template>
  <ChangeListView
    :list="list" :legacy="legacy" :error="error" :action-error="actionError" :loading="!loaded"
    :expanded-run-id="expandedRunId" :precheck="precheck" :report="report"
    :busy="busy" :quota-editing="quotaEditing" :quota-error="quotaError" :selected="props.selected"
    @review="id => emit('review', id)" @open="p => emit('open', p)"
    @inspect-run="inspectRun" @restore-run="restoreRun" @collapse="collapse"
    @edit-quota="quotaEditing = !quotaEditing" @set-quota="setQuota"
  />
</template>
