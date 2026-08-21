<script setup lang="ts">
/** T5：设备配对。三块——已配对列表 / 发起配对 / 加入配对。
 *  逻辑照搬旧弹窗（倒计时 1s tick + 2s 轮询感知对端完成 + host:port 解析），
 *  版面改成舞台页：配对要对着另一台机器抄码，弹窗尺寸下两台机器的信息挤在一起。
 *  只消费既有 RPC，不新增任何接口。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useChat } from '../stores/chat';
import { remainSeconds, countdownTone } from '../lib/perm/countdown';
import { fmtFingerprint, fmtPairingCode, codeInputNormalize } from '../lib/devices/fmt';
import { fmtRelative } from '../lib/time/relative';
import UiIcon from './UiIcon.vue';

const chat = useChat();

// ---- ① 已配对设备 ----
const confirming = ref('');
function onRemove(fp: string): void { chat.unpair(fp); confirming.value = ''; }

// ---- ② 发起配对 ----
const nowMs = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
/** 发起那一刻的指纹集：轮询里出现新指纹 = 对端已完成配对。 */
let startFps = new Set<string>();

const remain = computed(() => {
  const p = chat.pairingSession;
  return p ? remainSeconds(p.startedAt + p.expiresIn * 1000, nowMs.value) : 0;
});
const expired = computed(() => chat.pairingSession !== null && remain.value <= 0);
const tone = computed(() => countdownTone(remain.value));

async function begin(): Promise<void> {
  startFps = new Set(chat.devices.map(d => d.peerFingerprint));
  try { await chat.beginPairing(); } catch { /* store 不冒泡；界面停在未发起态 */ }
}
function stopTimers(): void {
  if (tick) { clearInterval(tick); tick = null; }
  if (poll) { clearInterval(poll); poll = null; }
}
watch(() => chat.pairingSession, (p) => {
  stopTimers();
  if (!p) return;
  tick = setInterval(() => { nowMs.value = Date.now(); }, 1000);
  poll = setInterval(() => {
    void chat.refreshDevices().then(() => {
      if (chat.devices.some(d => !startFps.has(d.peerFingerprint))) chat.cancelPairing();
    });
  }, 2000);
});

// ---- ③ 加入配对 ----
const joinAddr = ref(''); const joinCode = ref('');
const joinErr = ref(''); const joinFp = ref(''); const joinBusy = ref(false);
function onCodeInput(e: Event): void { joinCode.value = codeInputNormalize((e.target as HTMLInputElement).value); }
/** host:port（IPv4 + 端口；局域网场景够用，IPv6 暂不支持）。 */
function parseHostPort(s: string): { host: string; port: number } | null {
  const m = /^([^:]+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const port = Number(m[2]);
  return (!port || port < 1 || port > 65535) ? null : { host: m[1], port };
}
async function join(): Promise<void> {
  joinErr.value = ''; joinFp.value = '';
  const hp = parseHostPort(joinAddr.value);
  if (!hp) { joinErr.value = '请输入 host:port（如 192.168.1.5:7820）'; return; }
  if (!joinCode.value.trim()) { joinErr.value = '请输入配对码'; return; }
  joinBusy.value = true;
  try {
    joinFp.value = await chat.joinPairing({ host: hp.host, port: hp.port, pairingCode: joinCode.value.trim() });
    joinAddr.value = ''; joinCode.value = '';
  } catch (e) { joinErr.value = e instanceof Error ? e.message : String(e); }
  finally { joinBusy.value = false; }
}

onMounted(() => { void chat.refreshDevices(); });
onBeforeUnmount(stopTimers);
const relTime = (sec: number): string => fmtRelative(sec, Date.now() / 1000);
</script>

<template>
  <div class="scroll">
    <div class="col">
      <header class="head">
        <h1 class="t-h1">设备</h1>
        <p class="t-body sub">把另一台机器上的 DeskMinis 配上来，会话与设置在两边同步。配对只走局域网直连。</p>
      </header>

      <section class="f-sec">
        <h2>已配对</h2>
        <p v-if="!chat.devices.length" class="f-note">还没有配对任何设备。</p>
        <div v-for="d in chat.devices" :key="d.peerFingerprint" class="drow">
          <span class="dot" :class="{ on: d.online }" :title="d.online ? '在线' : '离线'"></span>
          <span class="dinfo">
            <span class="dname">{{ d.peerName || '未命名设备' }}</span>
            <span class="dfp t-aux">{{ fmtFingerprint(d.peerFingerprint) }}</span>
          </span>
          <span class="t-aux dtime">{{ d.online ? '在线' : `最后在线 ${relTime(d.lastSeenAt)}` }}</span>
          <template v-if="confirming === d.peerFingerprint">
            <span class="f-confirm">解绑？</span>
            <button class="f-btn danger" type="button" @click="onRemove(d.peerFingerprint)">确认解绑</button>
            <button class="f-btn ghost" type="button" @click="confirming = ''">取消</button>
          </template>
          <button v-else class="f-btn danger" type="button" @click="confirming = d.peerFingerprint">解绑</button>
        </div>
      </section>

      <section class="f-sec">
        <h2>发起配对</h2>
        <p class="f-note">在这台机器上生成配对码，到另一台机器上输入它。</p>
        <div class="f-card">
          <template v-if="chat.pairingSession && !expired">
            <div class="code">{{ fmtPairingCode(chat.pairingSession.code) }}</div>
            <p class="wait t-body">等待对端输入…<span class="tnum" :class="tone">{{ remain }}s 后过期</span></p>
            <p class="f-hint">对端需要填这台机器的 host:port。指纹：{{ fmtFingerprint(chat.pairingSession.myFingerprint) }}</p>
            <div class="f-row"><button class="f-btn ghost" type="button" @click="chat.cancelPairing()">取消</button></div>
          </template>
          <template v-else-if="expired">
            <p class="t-body errline">配对码已过期，请重新发起。</p>
            <div class="f-row"><button class="f-btn primary" type="button" @click="begin">重新发起</button></div>
          </template>
          <template v-else>
            <div class="f-row"><button class="f-btn primary" type="button" @click="begin">生成配对码</button></div>
          </template>
        </div>
      </section>

      <section class="f-sec">
        <h2>加入配对</h2>
        <p class="f-note">另一台机器已经生成了配对码，就在这里填它的地址和码。</p>
        <form class="f-card" @submit.prevent="join">
          <div class="f-grid">
            <label class="f-label">
              <span>对方地址</span>
              <input v-model="joinAddr" class="f-input" placeholder="192.168.1.5:7820" />
            </label>
            <label class="f-label">
              <span>配对码</span>
              <input :value="joinCode" class="f-input codein" placeholder="8 位配对码" @input="onCodeInput" />
            </label>
          </div>
          <p v-if="joinErr" class="errline">{{ joinErr }}</p>
          <p v-if="joinFp" class="okline t-body">已配对。对方指纹：{{ fmtFingerprint(joinFp) }}——跟对方屏幕上的对一遍。</p>
          <div class="f-row"><button class="f-btn primary" type="submit" :disabled="joinBusy">{{ joinBusy ? '连接中…' : '加入' }}</button></div>
        </form>
      </section>
    </div>
  </div>
</template>

<style scoped>
.scroll { flex: 1; min-height: 0; overflow-y: auto; background: var(--c-bg); }
.col {
  width: min(var(--w-stage), 100% - var(--sp-8) * 2); margin: 0 auto;
  padding: var(--sp-8) 0; display: flex; flex-direction: column; gap: var(--sp-8);
}
.head { display: flex; flex-direction: column; gap: var(--sp-1); }
.head h1 { margin: 0; color: var(--c-ink); }
.sub { margin: 0; color: var(--c-ink-3); }

.drow {
  display: flex; align-items: center; gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4); background: var(--c-bg);
  border: 1px solid var(--c-line); border-radius: var(--r-s);
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-ink-4); flex: 0 0 auto; }
.dot.on { background: var(--c-ok); }
.dinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dname { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.dfp { color: var(--c-ink-3); font-family: var(--f-mono); }
.dtime { color: var(--c-ink-3); flex: 0 0 auto; }

/* 配对码要隔着一米看得清：另一台机器上的人是照着屏幕抄的 */
.code {
  font-family: var(--f-mono); font-size: 32px; line-height: 1.3; letter-spacing: 8px;
  text-align: center; color: var(--c-ink); padding: var(--sp-4) 0;
}
.codein { font-family: var(--f-mono); letter-spacing: 3px; }
/* 占位符不跟着拉字距：「8 位配对码」被拉开后像一串代码而不是提示 */
.codein::placeholder { letter-spacing: normal; }
.wait { margin: 0; text-align: center; color: var(--c-ink-2); display: flex; gap: var(--sp-3); justify-content: center; }
.wait .warn { color: var(--c-warn); }
.wait .danger { color: var(--c-err); }
.errline { margin: 0; font-size: var(--t-body-size); color: var(--c-err); }
.okline { margin: 0; color: var(--c-ok); }
</style>
