<script setup lang="ts">
/** 左栏 · 会话列表（MU2b Task 4，设计 §1.1-1 变体 A 定稿）——任务卡式：
 *  标题 + 相对时间 + 状态徽标（●进行中绿 / ⏸等待批准橙 / ✕失败红 / ✓完成灰）+ 产物计数角标。
 *  粘性日期分组头（置顶/今天/昨天/本周/本月/更早）沿用 M1 既有；底部固定「设置/设备」入口
 * （设置 → inject('openSettings') 开独立模态（Task 5 已切）；设备 → inject('openDevices') 开
 *  DevicesModal 配对管理面（Task 7 已填实））。
 *  数据源诚实说明：sessions.list RPC 无 running/messages 字段，徽标与角标仅活动会话可得（lib/session/status）。 */
import { computed, inject, onUnmounted, ref } from 'vue';
import { useChat } from '../stores/chat';
import { sessionBadge, artifactCountOf, type SessionBadge } from '../lib/session/status';
import { fmtRelative } from '../lib/time/relative';
import Icon from './Icon.vue';

const chat = useChat();
// App.vue provide：打开设置独立模态（Task 5 起）
const openSettings = inject<() => void>('openSettings', () => {});
// App.vue provide：打开配对管理面 DevicesModal（MU2b Task 7）
const openDevices = inject<() => void>('openDevices', () => {});

interface S { id: string; title: string; updatedAt?: number; pinnedAt?: number }

const GROUP_ORDER = ['置顶', '今天', '昨天', '本周', '本月', '更早'];

function startOfDay(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

function groupOf(s: S): string {
  if (s.pinnedAt) return '置顶';
  const t = s.updatedAt ? s.updatedAt * 1000 : 0;
  if (!t) return '更早';
  const today = startOfDay(new Date());
  const day = 86400_000;
  if (t >= today) return '今天';
  if (t >= today - day) return '昨天';
  if (t >= today - 6 * day) return '本周';
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  if (t >= monthStart) return '本月';
  return '更早';
}

const grouped = computed(() => {
  const buckets = new Map<string, S[]>();
  for (const s of chat.sessions as S[]) {
    const g = groupOf(s);
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g)!.push(s);
  }
  return GROUP_ORDER.filter(g => buckets.has(g)).map(g => ({ group: g, items: buckets.get(g)! }));
});

// ---- 任务卡：相对时间（30s tick 刷新「N 分钟前」）+ 状态徽标 + 产物角标 ----
const nowSec = ref(Date.now() / 1000);
const tick = setInterval(() => { nowSec.value = Date.now() / 1000; }, 30_000);
onUnmounted(() => clearInterval(tick));

function relTime(s: S): string {
  return s.updatedAt ? fmtRelative(s.updatedAt, nowSec.value) : '';
}

/** 活动会话实时态（chat store 直取）；非活动会话 live=null → 徽标 null（数据源不可得，一期）。 */
const liveNow = computed(() => ({ running: chat.running, pendingPerms: chat.pendingPerms, lastStopReason: chat.lastStopReason }));
function badgeOf(s: S): SessionBadge {
  return sessionBadge(s, s.id === chat.activeId ? liveNow.value : null);
}
const BADGE_VIEW: Record<Exclude<SessionBadge, null>, { cls: string; text: string }> = {
  running: { cls: 'run', text: '● 进行中' },
  waiting: { cls: 'wait', text: '⏸ 等待批准' },
  failed: { cls: 'fail', text: '✕ 失败' },
  done: { cls: 'done', text: '✓ 完成' },
};

/** 产物角标：仅活动会话可得（messages 在 chat store）；0 不显示。 */
const activeArtifactCount = computed(() => artifactCountOf(chat.messages));
</script>

<template>
  <div class="pane">
    <div class="newbtn" @click="chat.newSession()">
      <Icon name="plus" :size="16" /><span>新建会话</span>
    </div>
    <div class="list">
      <template v-for="grp in grouped" :key="grp.group">
        <div class="datehead">
          <Icon v-if="grp.group === '置顶'" name="chevron-up" :size="11" /><span>{{ grp.group }}</span>
        </div>
        <div
          v-for="s in grp.items" :key="s.id"
          class="scard" :class="{ on: s.id === chat.activeId }"
          @click="chat.open(s.id)"
        >
          <div class="stitle">{{ s.title || '新会话' }}</div>
          <div class="smeta">
            <span class="stime">{{ relTime(s) }}</span>
            <span v-if="badgeOf(s)" class="sbadge" :class="BADGE_VIEW[badgeOf(s)!].cls">{{ BADGE_VIEW[badgeOf(s)!].text }}</span>
            <span v-if="s.id === chat.activeId && activeArtifactCount > 0" class="scount">◈ {{ activeArtifactCount }}</span>
          </div>
        </div>
      </template>
    </div>
    <div class="lfoot">
      <button class="lfbtn" type="button" @click="openSettings()"><Icon name="gear" :size="14" /><span>设置</span></button>
      <button class="lfbtn" type="button" title="设备与同步" @click="openDevices()"><span>设备</span></button>
    </div>
  </div>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; height: 100%; background: var(--bg); overflow: hidden; }
.newbtn {
  display: flex; align-items: center; gap: 8px; margin: 12px; padding: 9px 12px; border-radius: var(--r-md);
  background: var(--fill-tertiary); color: var(--label); font-size: var(--fs-ui); font-weight: 600; cursor: pointer; flex: 0 0 auto;
}
.newbtn:hover { background: var(--fill); }
.newbtn :deep(svg) { stroke: var(--label); }
.list { flex: 1; min-height: 0; overflow: auto; padding: 0 6px 8px; }
.datehead {
  position: sticky; top: 0; z-index: 1; padding: 6px 10px; font-size: 12px; font-weight: 600;
  color: var(--label-secondary); background: var(--bg); display: flex; align-items: center; gap: 4px;
}
/* 任务卡（变体 A）：标题行 + meta 行（相对时间/状态徽标/产物角标） */
.scard { padding: 9px 10px; border-radius: var(--r-md); margin-bottom: 2px; cursor: pointer; }
.scard:hover { background: var(--fill-quaternary); }
.scard.on { background: var(--fill-tertiary); }
.stitle {
  font-size: var(--fs-ui); font-weight: 600; color: var(--label);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.scard.on .stitle { color: var(--action); }
.smeta { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: var(--fs-micro); color: var(--label-tertiary); }
.stime { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.sbadge { flex: 0 0 auto; }
.sbadge.run { color: var(--state-ok); }
.sbadge.wait { color: var(--state-warn); }
.sbadge.fail { color: var(--state-err); }
.sbadge.done { color: var(--label-tertiary); }
.scount { flex: 0 0 auto; margin-left: auto; color: var(--label-secondary); font-variant-numeric: tabular-nums; }
/* 底部固定入口：设置（独立模态）/ 设备（DevicesModal，Task 7 已填实） */
.lfoot {
  flex: 0 0 auto; display: flex; gap: 2px; padding: 8px 10px;
  border-top: .5px solid var(--separator);
}
.lfbtn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 7px 10px; border: none; border-radius: var(--r-control); background: none;
  font-size: var(--fs-ui); font-weight: 500; color: var(--label-secondary); cursor: pointer;
}
.lfbtn:hover { background: var(--fill-quaternary); color: var(--label); }
</style>
