<script setup lang="ts">
/** 配对管理面（MU2b Task 7，设计 §7.1）——三区块：
 *  ① 已配对设备列表（remote.status 脱敏视图：设备名/指纹 mono/配对时间/在线点/移除钮二次确认）；
 *  ② 发起配对（remote.pair.begin → 8 字码 32px mono 字距 8px + expiresIn 倒计时复用 lib/perm/countdown
 *     + 「等待对端输入…」状态句；发起中 2s 轮询 remote.status，设备出现即清 pairingSession 滑入列表；
 *     超时 → 「配对码已过期，请重新发起」）；
 *  ③ 加入配对（M3c Task 7 启用）：host:port + 配对码两输入，免手抄公钥（决策 3）——
 *     调 chat.joinPairing → remote.pair.join 真出站完成配对，返回 peerFingerprint 供人工比对。
 *  红线：只消费既有 remote.status / remote.pair.begin / remote.unpair / remote.pair.join，不新增任何 RPC。 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useChat } from '../stores/chat';
import { remainSeconds, countdownTone } from '../lib/perm/countdown';
import { fmtFingerprint, fmtPairingCode, codeInputNormalize } from '../lib/devices/fmt';
import { fmtRelative } from '../lib/time/relative';
import Icon from './Icon.vue';

const emit = defineEmits<{ (e: 'close'): void }>();
const chat = useChat();

// ---- ① 已配对设备：移除钮二次确认 ----
const confirmingFp = ref('');
function onRemove(fp: string): void {
  if (confirmingFp.value === fp) {
    confirmingFp.value = '';
    void chat.unpair(fp);
  } else {
    confirmingFp.value = fp;
  }
}

// ---- ② 发起配对：倒计时（1s tick）+ 2s 轮询感知对端完成 ----
const nowMs = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** 发起配对那一刻的设备指纹集——轮询中出现新指纹即视为对端已完成配对 */
let pairStartFps = new Set<string>();

const remain = computed(() => {
  const p = chat.pairingSession;
  if (!p) return 0;
  return remainSeconds(p.startedAt + p.expiresIn * 1000, nowMs.value);
});
const expired = computed(() => chat.pairingSession !== null && remain.value <= 0);
const tone = computed(() => countdownTone(remain.value));

async function onBeginPairing(): Promise<void> {
  pairStartFps = new Set(chat.devices.map(d => d.peerFingerprint));
  try { await chat.beginPairing(); }
  catch { /* RPC 失败由 store 不冒泡；pairingSession 保持 null，界面停留未发起态 */ }
}
function stopPairTimers(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
watch(() => chat.pairingSession, (p) => {
  stopPairTimers();
  if (!p) return;
  tickTimer = setInterval(() => { nowMs.value = Date.now(); }, 1000);
  pollTimer = setInterval(() => {
    void chat.refreshDevices().then(() => {
      // 对端完成配对（remote.pair.complete 由对端触发）：新指纹出现 → 清发起态，设备滑入列表
      if (chat.devices.some(d => !pairStartFps.has(d.peerFingerprint))) chat.cancelPairing();
    });
  }, 2000);
});

// ---- ③ 加入配对（M3c Task 7 启用）：host:port + 配对码两输入，免手抄公钥 ----
const joinAddr = ref('');
const joinCode = ref('');
const joinError = ref('');
const joinResultFp = ref('');
const joinBusy = ref(false);
function onJoinInput(e: Event): void {
  joinCode.value = codeInputNormalize((e.target as HTMLInputElement).value);
}
// host:port 解析（支持 IPv4 + 端口；IPv6 暂不支持，局域网场景够用）
function parseHostPort(s: string): { host: string; port: number } | null {
  const m = /^([^:]+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!port || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}
async function onJoin(): Promise<void> {
  joinError.value = '';
  joinResultFp.value = '';
  const hp = parseHostPort(joinAddr.value);
  if (!hp) { joinError.value = '请输入 host:port（如 192.168.1.5:7820）'; return; }
  const code = joinCode.value.trim();
  if (!code) { joinError.value = '请输入配对码'; return; }
  joinBusy.value = true;
  try {
    const fp = await chat.joinPairing({ host: hp.host, port: hp.port, pairingCode: code });
    joinResultFp.value = fp;
    joinAddr.value = '';
    joinCode.value = '';
  } catch (e) {
    joinError.value = e instanceof Error ? e.message : String(e);
  } finally {
    joinBusy.value = false;
  }
}

function relTime(epochSec: number): string {
  return fmtRelative(epochSec, Date.now() / 1000);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); emit('close'); }
}
onMounted(() => {
  window.addEventListener('keydown', onKey, true);
  void chat.refreshDevices();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true);
  stopPairTimers();
});
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-label="设备与同步">
      <div class="dhead">
        <span class="dtitle">设备与同步</span>
        <button class="xbtn" type="button" title="关闭" @click="emit('close')"><Icon name="x" :size="14" /></button>
      </div>

      <!-- ① 已配对设备 -->
      <div class="sect">
        <div class="sectitle">已配对设备</div>
        <div v-if="!chat.devices.length" class="empty">暂无已配对设备</div>
        <div v-for="d in chat.devices" :key="d.peerFingerprint" class="devcard">
          <span class="dot" :class="d.online ? 'on' : 'off'" :title="d.online ? '在线' : '离线'"></span>
          <div class="dtxt">
            <div class="dname">{{ d.peerName || '未命名设备' }}</div>
            <div class="dmeta">
              <span class="dfp">{{ fmtFingerprint(d.peerFingerprint) }}</span>
              <span class="dtime">配对于 {{ relTime(d.createdAt) }}</span>
            </div>
          </div>
          <template v-if="confirmingFp === d.peerFingerprint">
            <button class="rbtn danger" type="button" @click="onRemove(d.peerFingerprint)">确认移除</button>
            <button class="rbtn" type="button" @click="confirmingFp = ''">取消</button>
          </template>
          <button v-else class="rbtn" type="button" @click="onRemove(d.peerFingerprint)"><Icon name="trash" :size="13" /><span>移除</span></button>
        </div>
      </div>

      <!-- ② 发起配对 -->
      <div class="sect">
        <div class="sectitle">发起配对</div>
        <template v-if="!chat.pairingSession">
          <div class="snote">在另一台设备上输入配对码，即可建立加密连接。</div>
          <button class="pbtn" type="button" @click="onBeginPairing">发起配对</button>
        </template>
        <template v-else>
          <div class="codewrap">
            <div class="code">{{ fmtPairingCode(chat.pairingSession.code) }}</div>
            <div v-if="!expired" class="codestate" :class="{ urgent: tone === 'urgent' }">
              等待对端输入…（{{ remain }}s）
            </div>
            <div v-else class="codestate urgent">配对码已过期，请重新发起</div>
          </div>
          <div class="pairrow">
            <button v-if="expired" class="pbtn" type="button" @click="onBeginPairing">重新发起</button>
            <button class="rbtn" type="button" @click="chat.cancelPairing()">取消</button>
          </div>
        </template>
      </div>

      <!-- ③ 加入配对（M3c 启用）：host:port + 配对码两输入，免手抄公钥 -->
      <div class="sect">
        <div class="sectitle">加入配对</div>
        <div class="joinrow">
          <input
            class="codeinput joinaddr" type="text" v-model="joinAddr" placeholder="host:port"
            title="输入对端 IP:端口"
          />
          <input
            class="codeinput" type="text" :value="joinCode" placeholder="XXXX-XXXX"
            title="输入配对码"
            @input="onJoinInput"
          />
          <button class="pbtn" type="button" :disabled="joinBusy" @click="onJoin">{{ joinBusy ? '配对中…' : '加入' }}</button>
        </div>
        <div v-if="joinError" class="snote err">{{ joinError }}</div>
        <div v-else-if="joinResultFp" class="snote ok">已配对：{{ joinResultFp }}</div>
        <div v-else class="snote">输入对端显示的 host:port 和配对码，建立加密连接（无需手抄公钥）。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 110; background: var(--scrim);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: 480px; max-width: calc(100vw - 64px); max-height: calc(100vh - 64px); overflow: auto;
  background: var(--bg); border-radius: var(--r-sheet); box-shadow: var(--shadow-pop); padding: 18px 20px;
}
.dhead { display: flex; align-items: center; margin-bottom: 6px; }
.dtitle { font-size: var(--fs-display); font-weight: 700; color: var(--label); }
.xbtn {
  margin-left: auto; width: 26px; height: 26px; border: none; border-radius: var(--r-control);
  background: none; color: var(--label-secondary); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.xbtn:hover { background: var(--fill-quaternary); color: var(--label); }
.sect { margin-top: 14px; }
.sectitle { font-size: var(--fs-ui); font-weight: 700; color: var(--label-strong); margin-bottom: 8px; }
.empty { font-size: var(--fs-caption); color: var(--label-tertiary); padding: 10px 2px; }
.devcard {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px; margin-bottom: 6px;
  border: .5px solid var(--separator); border-radius: var(--r-card); background: var(--surface-1);
}
.dtxt { flex: 1; min-width: 0; }
.dname { font-size: var(--fs-ui); font-weight: 600; color: var(--label); }
.dmeta { display: flex; align-items: center; gap: 10px; margin-top: 3px; }
.dfp { font-family: var(--font-mono); font-size: var(--fs-caption); color: var(--label-secondary); }
.dtime { font-size: var(--fs-micro); color: var(--label-tertiary); }
.dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--label-tertiary); }
.dot.on { background: var(--state-ok); }
.dot.off { background: var(--label-tertiary); opacity: .5; }
.codewrap {
  display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px;
  border: .5px solid var(--separator); border-radius: var(--r-card); background: var(--surface-1);
}
.code { font-family: var(--font-mono); font-size: 32px; font-weight: 700; letter-spacing: 8px; color: var(--label-intense); }
.codestate { font-size: var(--fs-caption); color: var(--label-secondary); font-variant-numeric: tabular-nums; }
.codestate.urgent { color: var(--state-warn); }
.pairrow { display: flex; gap: 8px; margin-top: 8px; }
.pbtn {
  padding: 8px 16px; border: none; border-radius: var(--r-control); background: var(--action);
  color: var(--on-action); font-size: var(--fs-ui); font-weight: 600; cursor: pointer;
}
.pbtn:disabled { opacity: .45; cursor: default; }
.rbtn {
  display: flex; align-items: center; gap: 5px; padding: 6px 12px; flex: 0 0 auto;
  border: .5px solid var(--separator); border-radius: var(--r-control); background: var(--surface-1);
  color: var(--label-secondary); font-size: var(--fs-caption); cursor: pointer;
}
.rbtn:hover { background: var(--fill-quaternary); color: var(--label); }
.rbtn.danger { color: var(--state-err); border-color: var(--state-err); }
.joinrow { display: flex; gap: 8px; }
.codeinput {
  flex: 1; min-width: 0; padding: 8px 12px; border: .5px solid var(--separator); border-radius: var(--r-control);
  background: var(--bg-tertiary); color: var(--label); font-family: var(--font-mono); font-size: var(--fs-ui);
  letter-spacing: 2px; outline: none;
}
.codeinput:disabled { opacity: .45; }
.codeinput.joinaddr { letter-spacing: 0; font-family: var(--font-mono); }
.snote { font-size: var(--fs-caption); color: var(--label-tertiary); line-height: 1.6; padding: 8px 2px; }
.snote.err { color: var(--state-err); }
.snote.ok { color: var(--state-ok); }
</style>
