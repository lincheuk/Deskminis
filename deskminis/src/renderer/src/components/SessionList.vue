<script setup lang="ts">
/** 左栏 · 会话列表（设计 §4.1）——plain 列表、圆形头像、选中 brand 30% 内缩块、
 *  粘性日期分组头（置顶/今天/昨天/本周/本月/更早）。 */
import { computed } from 'vue';
import { useChat } from '../stores/chat';
import Icon from './Icon.vue';

const chat = useChat();

interface S { id: string; title: string; updatedAt?: number; pinnedAt?: number }

const GROUP_ORDER = ['置顶', '今天', '昨天', '本周', '本月', '更早'];
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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

function fmtDate(s: S): string {
  const t = s.updatedAt ? s.updatedAt * 1000 : 0;
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const today = startOfDay(now);
  if (t >= today) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (t >= today - 6 * 86400_000) return WEEK[d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
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
          class="srow" :class="{ on: s.id === chat.activeId }"
          @click="chat.open(s.id)"
        >
          <div class="ava"><Icon name="terminal" :size="20" /></div>
          <div class="smid"><div class="stitle">{{ s.title || '新会话' }}</div></div>
          <div class="sdate">{{ fmtDate(s) }}</div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; height: 100%; background: var(--bg); overflow: hidden; }
.newbtn {
  display: flex; align-items: center; gap: 8px; margin: 12px; padding: 9px 12px; border-radius: var(--r-md);
  background: var(--brand); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; flex: 0 0 auto;
}
.newbtn :deep(svg) { stroke: #fff; }
.list { flex: 1; overflow: auto; padding-bottom: 8px; }
.datehead {
  position: sticky; top: 0; z-index: 1; padding: 6px 16px; font-size: 12px; font-weight: 600;
  color: var(--label-secondary); background: var(--bg); display: flex; align-items: center; gap: 4px;
}
.srow { display: flex; gap: 8px; padding: 12px 16px; cursor: pointer; align-items: center; }
.srow.on { background: color-mix(in srgb, var(--brand) 30%, transparent); border-radius: var(--r-md); margin: 0 6px; padding: 12px 10px; }
.ava {
  width: 44px; height: 44px; flex: 0 0 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--brand) 18%, transparent); color: var(--label-secondary);
}
.srow.on .ava { background: color-mix(in srgb, var(--brand) 35%, transparent); color: var(--label); }
.smid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.stitle { font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sdate { font-size: 13px; color: var(--label-tertiary); flex: 0 0 auto; padding-top: 2px; }
</style>
