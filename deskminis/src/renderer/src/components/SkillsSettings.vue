<script setup lang="ts">
/** 设置 · 技能（MU6 Task 3）。
 *
 *  立项理由：M2c 建成了完整的技能系统（启停 / 删除 / 导入 / 会话覆盖），
 *  但渲染端一直只用 `skills.list` 喂斜杠菜单——**没有任何管理界面**。
 *  技能装进来之后，用户既看不到有哪些、也关不掉、更删不了。
 *
 *  本轮只消费既有 RPC：`skills.list` / `setEnabled` / `delete` / `import` / `importStatus`，
 *  `src/minisd` 零改动（计划 §4 红线 1）。
 *
 *  两处刻意的取舍：
 *  ① **只做全局启停**。`skills.setEnabled` 带 sessionId 时写的是会话覆盖，不带才是全局开关。
 *     两种范围混在一个界面里会让用户搞不清自己改了什么，故本轮只做全局并在页面上写明。
 *  ② **导入只接本地目录、且入口是路径文本框**（§2-4 拍板）。原生目录选择器要走主进程
 *     `dialog.showOpenDialog`，那就动了 `src/main` 直接破红线 1；文本框是唯一守得住纯 renderer 的通路。 */
import { computed, onMounted, ref } from 'vue';
import { useChat } from '../stores/chat';
import Icon from './Icon.vue';

const chat = useChat();

const importPath = ref('');
const importError = ref('');
const busy = ref(false);
/** 哪一个技能处在删除二次确认态（红线 6：破坏性操作必须二次确认）。 */
const confirmDelete = ref('');

onMounted(() => { void chat.refreshAllSkills(); });

const task = computed(() => chat.skillImport);

async function doImport(): Promise<void> {
  const src = importPath.value.trim();
  importError.value = '';
  if (!src) { importError.value = '请先填写技能目录的绝对路径'; return; }
  busy.value = true;
  try {
    const t = await chat.importSkillFolder(src);
    // 广播可能丢：拿到 taskId 后主动兜一次底，避免界面永远停在「进行中」
    if (t && typeof t.taskId === 'string') {
      window.setTimeout(() => { void chat.pollSkillImport(t.taskId); }, 1200);
    }
    importPath.value = '';
  } catch (e) {
    // 路径不存在、不是目录、没有 SKILL.md……后端都会抛，照实显示而不是静默吞掉
    importError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function onDelete(id: string): Promise<void> {
  await chat.deleteSkill(id);
  confirmDelete.value = '';
}
</script>

<template>
  <div class="skills">
    <div class="snote">
      技能来自 <code>SKILL.md</code> 目录，装好后会出现在输入框的 <code>/</code> 菜单里。
      这里的启停是<strong>全局</strong>的——对所有会话生效，不是只改当前这一个。
    </div>

    <!-- 导入：路径文本框（§2-4） -->
    <div class="imp">
      <label class="implabel" for="skill-import-path">导入本地技能目录</label>
      <div class="improw">
        <input
          id="skill-import-path" v-model="importPath" class="impinput" type="text"
          placeholder="粘贴技能目录的绝对路径，例如 D:\\skills\\my-skill"
          @keydown.enter="doImport"
        />
        <button class="impbtn" type="button" :disabled="busy" @click="doImport">导入</button>
      </div>
      <div class="imphint">
        需要目录的<strong>绝对路径</strong>。当前版本不提供目录选择对话框——那需要主进程能力，
        本轮范围内不引入。
      </div>
      <div v-if="importError" class="imperr">{{ importError }}</div>
      <div v-else-if="task" class="impstat" :class="task.state">
        <template v-if="task.state === 'running'">导入中… 已处理 {{ task.completed }}/{{ task.total }}</template>
        <template v-else-if="task.state === 'done'">
          导入完成：成功 {{ task.succeeded.length }} 个<template v-if="task.failures.length">，失败 {{ task.failures.length }} 个</template>
        </template>
        <template v-else>导入失败：{{ task.error || '未知原因' }}</template>
        <ul v-if="task.failures.length" class="impfail">
          <li v-for="f in task.failures" :key="f.name">{{ f.name }}：{{ f.error }}</li>
        </ul>
      </div>
    </div>

    <!-- 技能列表：含禁用项（管理页必须看得见禁用的，否则关掉就找不回来了） -->
    <div v-if="!chat.allSkills.length" class="empty">还没有安装任何技能。</div>
    <div v-for="s in chat.allSkills" :key="s.id" class="row" :class="{ off: !s.isEnabled }">
      <div class="rmain">
        <div class="rname">
          {{ s.name }}
          <span class="rcount" :title="`已被调用 ${s.useCount} 次`">{{ s.useCount }} 次</span>
        </div>
        <div class="rdesc">{{ s.description || '（无描述）' }}</div>
      </div>
      <button
        class="rtoggle" type="button" :class="{ on: s.isEnabled }"
        :title="s.isEnabled ? '停用（全局）' : '启用（全局）'"
        @click="chat.setSkillEnabled(s.id, !s.isEnabled)"
      >{{ s.isEnabled ? '已启用' : '已停用' }}</button>
      <template v-if="confirmDelete !== s.id">
        <button class="rdel" type="button" title="删除技能" @click="confirmDelete = s.id">
          <Icon name="trash" :size="14" />
        </button>
      </template>
      <template v-else>
        <button class="rkeep" type="button" @click="confirmDelete = ''">取消</button>
        <button class="rdel danger" type="button" @click="onDelete(s.id)">确认删除</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.skills { display: flex; flex-direction: column; gap: 10px; }
.snote { font-size: var(--fs-ui); line-height: 1.7; color: var(--label-secondary); }
.snote code {
  font-family: var(--font-mono); font-size: var(--fs-micro);
  background: var(--fill-quaternary); padding: 1px 5px; border-radius: var(--r-control);
}
.snote strong { color: var(--label); font-weight: var(--fw-strong); }

/* E3（Aurora §4）：导入卡浮岛化——顶缘高光 + 柔影；实心材质不用 blur */
.imp {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px; border-radius: var(--r-card);
  background: var(--grouped-bg-secondary); border: 1px solid var(--separator);
  box-shadow: 0 2px 8px var(--shadow-color);
}
.implabel { font-size: var(--fs-ui); font-weight: var(--fw-medium); color: var(--label); }
.improw { display: flex; gap: 8px; }
.impinput {
  flex: 1; min-width: 0; padding: 7px 10px; border-radius: var(--r-control);
  border: 1px solid var(--separator); background: var(--surface-1);
  color: var(--label); font-size: var(--fs-ui); font-family: var(--font-mono);
}
.impinput:focus-visible { outline: 2px solid var(--ring-input); outline-offset: 1px; }
/* E3：主钮青底——accent 底 + on-action 字（§4），两主题自动对 */
.impbtn {
  flex: 0 0 auto; padding: 7px 16px; border-radius: var(--r-control); border: none;
  background: var(--accent); color: var(--on-action);
  font-size: var(--fs-ui); font-weight: var(--fw-medium); cursor: pointer;
}
.impbtn:disabled { background: var(--label-quaternary); cursor: default; }
.impbtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.imphint { font-size: var(--fs-micro); line-height: 1.6; color: var(--label-tertiary); }
.imphint strong { color: var(--label-secondary); }
.imperr { font-size: var(--fs-micro); line-height: 1.6; color: var(--state-err); }
.impstat { font-size: var(--fs-micro); line-height: 1.6; color: var(--label-secondary); }
.impstat.done { color: var(--state-ok); }
.impstat.failed { color: var(--state-err); }
.impfail { margin: 4px 0 0; padding-left: 18px; color: var(--state-err); }

.empty { font-size: var(--fs-ui); color: var(--label-tertiary); padding: 12px 0; }
/* E3：技能行浮岛化——顶缘高光 + 柔影 */
.row {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-radius: var(--r-card);
  border: 1px solid var(--separator); background: var(--surface-1);
  box-shadow: 0 2px 8px var(--shadow-color);
}
.row.off { opacity: .62; }
.rmain { flex: 1; min-width: 0; }
.rname {
  display: flex; align-items: center; gap: 8px;
  font-size: var(--fs-ui); font-weight: var(--fw-medium); color: var(--label);
}
/* E3：调用次数是「计数读数」，走 mono（Aurora §4 读数面） */
.rcount { font-size: var(--fs-micro); font-weight: 400; color: var(--label-tertiary); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.rdesc {
  margin-top: 2px; font-size: var(--fs-micro); color: var(--label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rtoggle {
  flex: 0 0 auto; padding: 4px 12px; border-radius: var(--r-pill);
  border: 1px solid var(--separator); background: none;
  font-size: var(--fs-micro); color: var(--label-secondary); cursor: pointer; white-space: nowrap;
}
.rtoggle.on { border-color: var(--state-ok); color: var(--state-ok); }
.rtoggle:focus-visible, .rdel:focus-visible, .rkeep:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.rdel {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  padding: 5px 8px; border: none; border-radius: var(--r-control); background: none;
  color: var(--label-tertiary); cursor: pointer; font-size: var(--fs-micro); white-space: nowrap;
}
.rdel:hover, .rdel.danger { color: var(--state-err); }
.rdel.danger { background: var(--state-err-bg); }
.rdel :deep(svg) { stroke: currentColor; }
/* 红线 6：确认态里「取消」排在危险项之前，默认焦点不落在删除上 */
.rkeep {
  flex: 0 0 auto; padding: 5px 10px; border-radius: var(--r-control);
  border: 1px solid var(--separator); background: var(--surface-1);
  font-size: var(--fs-micro); color: var(--label-secondary); cursor: pointer; white-space: nowrap;
}
</style>
