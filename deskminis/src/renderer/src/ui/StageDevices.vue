<script setup lang="ts">
/** T5：设备配对。三块——已配对列表 / 发起配对 / 加入配对。
 *  逻辑照搬旧弹窗（倒计时 1s tick + 2s 轮询感知对端完成 + host:port 解析），
 *  版面改成舞台页：配对要对着另一台机器抄码，弹窗尺寸下两台机器的信息挤在一起。
 *  F11C 起多了认证配对：策略开关（remote.pair.setPolicy）、取消真正到达引擎（remote.pair.cancel）、
 *  12 位码与剩余次数、发起侧结局提示、旧配对标记。码的种类由引擎判断，这里不做分类。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useChat } from '../stores/chat';
import { remainSeconds, countdownTone } from '../lib/perm/countdown';
import { fmtFingerprint, fmtPairingCode, codeInputNormalize } from '../lib/devices/fmt';
import { PAIRING_DELETE_NOTE, retainedSummary } from '../lib/devices/delete-scope';
import { fmtRelative } from '../lib/time/relative';
import { PAIR_ERROR_TEXT, pairErrorCodeOf } from '@shared/pairing';
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
/** F11C：认证配对发起侧的结局提示（配对完成 / 作废原因）。重新配对同一台设备时不会出现新指纹，靠它收尾。 */
const hostNote = ref(''); const hostNoteOk = ref(false);
/** F11C：切换本机配对策略的开关。 */
const policyBusy = ref(false); const policyErr = ref('');
const authOn = computed(() => chat.pairStatus?.policy === 'authenticated');
async function togglePolicy(): Promise<void> {
  policyBusy.value = true; policyErr.value = ''; hostNote.value = '';
  try { await chat.setPairingPolicy(authOn.value ? 'legacy' : 'authenticated'); }
  catch (e) { policyErr.value = e instanceof Error ? e.message : String(e); }
  finally { policyBusy.value = false; }
}

const remain = computed(() => {
  const p = chat.pairingSession;
  return p ? remainSeconds(p.startedAt + p.expiresIn * 1000, nowMs.value) : 0;
});
const expired = computed(() => chat.pairingSession !== null && remain.value <= 0);
const tone = computed(() => countdownTone(remain.value));

async function begin(): Promise<void> {
  hostNote.value = '';
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
      // F11C：认证配对看引擎报告的发起侧结局（码不在了才算有结局）
      if (chat.pairingMeta?.protocol === 2) {
        const st = chat.pairStatus;
        const out = st?.lastHostOutcome;
        if (out?.kind === 'paired') { hostNote.value = '配对完成。'; hostNoteOk.value = true; chat.cancelPairing(); return; }
        if (st && !st.host && out?.kind === 'failed') { hostNote.value = PAIR_ERROR_TEXT[out.code] ?? '配对没有完成。'; hostNoteOk.value = false; chat.cancelPairing(); return; }
      }
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
  } catch (e) {
    // F11C：认证配对的错误串以错误码开头，界面显示对应的中文说明；取不到码就显示原消息
    const msg = e instanceof Error ? e.message : String(e);
    const code = pairErrorCodeOf(msg);
    joinErr.value = code ? PAIR_ERROR_TEXT[code] : msg;
  }
  finally { joinBusy.value = false; }
}

// ---- ④ F11B：已在其他设备删除（保留副本）----
// 另一台设备删掉了这个会话，而这台设备上有对方删除时没见过的消息或标注：内容先留着，由用户决定恢复还是清掉。
/** 正在二次确认「彻底删除」的会话 id。 */
const purging = ref('');
const retainBusy = ref('');
const retainErr = ref<Record<string, string>>({});
/** 操作被拒、而那一行已经不在清单里了（它刚被别的设备恢复，或在别处清掉了）：失败原因没有行可挂，放到这一节外面说，
 *  不然用户只看到一行凭空消失，分不清是删掉了还是回到了会话列表。下一次操作时清掉。 */
const retainNotice = ref('');
/** 删除方显示成设备名；已不在配对表里（或没起名）时退回指纹。 */
const deletedByName = (fp: string): string => chat.devices.find(d => d.peerFingerprint === fp)?.peerName || fmtFingerprint(fp);
async function runRetained(id: string, act: () => Promise<void>): Promise<void> {
  retainBusy.value = id;
  retainErr.value = { ...retainErr.value, [id]: '' };
  retainNotice.value = '';
  const title = chat.retainedSessions.find(r => r.id === id)?.title || '新会话';
  try { await act(); purging.value = ''; }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    retainErr.value = { ...retainErr.value, [id]: msg };
    if (!chat.retainedSessions.some(r => r.id === id)) { retainNotice.value = `「${title}」：${msg}`; purging.value = ''; }
  }
  finally { retainBusy.value = ''; }
}
const onRestore = (id: string): Promise<void> => runRetained(id, () => chat.restoreSession(id));
const onPurge = (id: string): Promise<void> => runRetained(id, () => chat.purgeRetainedSession(id));

// Y3：暂停态是持久化设置，进页再读一次自愈（init 已读过一次）
onMounted(() => { void chat.refreshDevices(); void chat.refreshSyncPaused(); void chat.refreshRetained(); });
onBeforeUnmount(stopTimers);
const relTime = (sec: number): string => fmtRelative(sec, Date.now() / 1000);
</script>

<template>
  <div class="scroll">
    <div class="col">
      <header class="head">
        <h1 class="t-h1">设备</h1>
        <!-- W2b-11a 订正：这里原写「会话与设置在两边同步」。按 sync/wire.ts 与 chat-store 的 mergeRemoteSession，
             同步的只有会话：消息与压缩摘要，外加标题、记忆开关、模型绑定、置顶这几项会话属性；模型与密钥、MCP、技能、
             助手、定时、权限档位这些设置一样都不同步，记忆文件也不传。minisd 缺省只听 127.0.0.1
             （index.ts 的 listenHost），主进程也不注入 MINISD_HOST，跨机器得用户自己设——界面上暂时没有开关。
             F11A 订正：消息里引用的附件现在经同一条加密连接传到对方（sync/attachments/），前提是两台都是支持附件同步的版本；
             对方版本不支持时附件显示为不可用，不走别的通路。工作区文件、截屏、记忆文件仍不同步。
             F11B 订正：删除会话现在也会同步（每个会话留一条不含内容的删除记录，旧副本带不回来）；细则在下面「同步」卡片里。 -->
        <p class="t-body sub">把另一台机器上的 DeskMinis 配上来，两边的会话（消息、标题、记忆开关、模型绑定）互相同步，删除也会同步，消息里的附件也会传到对方（两台都要是支持附件同步的版本）；设置、记忆文件不同步。</p>
        <p class="t-body sub">配对只走局域网直连。应用默认只在本机监听，跨机器使用要先在两台机器上都设好环境变量 <code>MINISD_HOST=0.0.0.0</code> 再启动，界面上暂时没有这个开关。</p>
      </header>

      <!-- Y3：M6 的同步暂停开关（MU6 立、T 波换壳丢）。三句文案从旧 SettingsModal 原样搬回——
           那句「不会中断正在执行的任务」是因为用户曾以为点了能停下任务。 -->
      <section class="f-sec">
        <h2>同步</h2>
        <div class="f-card">
          <div class="syncrow">
            <div class="synctxt">
              <div class="t-item synclabel">设备间同步</div>
              <div class="t-aux syncsub">{{ chat.syncPaused ? '已暂停：不再与其它设备收发会话。' : '进行中：会话在已配对设备之间自动同步。' }}</div>
            </div>
            <button class="f-btn" :class="{ primary: chat.syncPaused }" type="button" @click="chat.setSyncPaused(!chat.syncPaused)">{{ chat.syncPaused ? '恢复同步' : '暂停同步' }}</button>
          </div>
          <p class="f-hint">暂停的只是<strong>设备间同步</strong>，<strong>不会中断</strong>正在执行的任务——要停下当前回合请用输入框旁的停止按钮。暂停状态会保留到下次启动。</p>
          <!-- F11B：删除怎么同步、什么时候会留下内容、暂停与解绑期间怎么算 -->
          <p class="f-hint">在一台设备上删掉的会话，其它已配对设备也会删除，不会被旧副本带回来。那台设备上如果有你删除时没见过的消息或标注，它会把内容留下、列在下面的「已在其他设备删除」里，由你决定恢复还是清掉。暂停期间删除既不发出也不生效，恢复同步后补齐。解绑一台设备之后删掉的会话不会传给它；以后再把它配回来，它上面的这些会话同样会被删除。</p>
        </div>
      </section>

      <!-- F11B：恢复 / 彻底删除被拒，而那一行已经不在清单里（见 retainNotice）。放在这一节外面：清单空了整节都不显示 -->
      <p v-if="retainNotice" class="errline" role="status">{{ retainNotice }}</p>

      <!-- F11B：保留副本。只在有的时候显示；这是同步冲突的处理面，不是回收站 -->
      <section v-if="chat.retainedSessions.length" class="f-sec">
        <h2>已在其他设备删除</h2>
        <p class="f-note">这些会话已在另一台设备上删除，不再同步。这台设备上有对方删除时没见过的内容，所以先留着。恢复会让它重新出现在所有已配对设备上；彻底删除后无法恢复。</p>
        <div v-for="r in chat.retainedSessions" :key="r.id" class="drow rrow">
          <span class="dinfo">
            <span class="dname">{{ r.title || '新会话' }}</span>
            <span class="t-aux">由 {{ deletedByName(r.deletedBy) }} 删除 · {{ retainedSummary(r) }}</span>
            <span v-if="retainErr[r.id]" class="errline">{{ retainErr[r.id] }}</span>
          </span>
          <template v-if="purging === r.id">
            <span class="f-confirm">彻底删除？</span>
            <button class="f-btn danger" type="button" :disabled="retainBusy === r.id" @click="onPurge(r.id)">确认删除</button>
            <button class="f-btn ghost" type="button" :disabled="retainBusy === r.id" @click="purging = ''">取消</button>
          </template>
          <template v-else>
            <button class="f-btn primary" type="button" :disabled="retainBusy === r.id" @click="onRestore(r.id)">恢复</button>
            <button class="f-btn danger" type="button" :disabled="retainBusy === r.id" @click="purging = r.id">彻底删除</button>
          </template>
        </div>
      </section>

      <section class="f-sec">
        <h2>已配对</h2>
        <p v-if="!chat.devices.length" class="f-note">还没有配对任何设备。</p>
        <div v-for="d in chat.devices" :key="d.peerFingerprint" class="drow">
          <span class="dot" :class="{ on: d.online }" :title="d.online ? '在线' : '离线'"></span>
          <span class="dinfo">
            <span class="dname">{{ d.peerName || '未命名设备' }}
              <!-- F11C：这条配对是怎么建立的。默认策略下旧方式的行不加标记 -->
              <small v-if="chat.deviceMeta[d.peerFingerprint]?.pairingProtocol === 2" class="dtag ok">认证配对</small>
              <small v-else-if="authOn" class="dtag">旧方式配对（未认证）</small>
              <small v-if="authOn && chat.deviceMeta[d.peerFingerprint]?.canUpgradePairing" class="dtag">对方支持认证配对，重新配对即可升级</small>
            </span>
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
        <!-- F11B：配对是删除开始跨设备生效的那一步，这句话要在按下「生成配对码」之前看得到 -->
        <p class="f-note">{{ PAIRING_DELETE_NOTE }}</p>
        <!-- F11C：认证配对的策略开关（照搬上面「同步」卡片的版式）。旧引擎不报告 pairing，整行不显示 -->
        <div v-if="chat.pairStatus" class="f-card">
          <div class="syncrow">
            <div class="synctxt">
              <div class="t-item synclabel">认证配对（实验）</div>
              <div class="t-aux syncsub">实验性功能，尚未经独立密码学审查，默认关闭。打开后这台机器生成以 0 开头的 12 位配对码，配对码本身不经过网络；打开期间这台机器不再接受、也不再发起旧的 8 位配对。对方也要是支持认证配对的版本。</div>
            </div>
            <button class="f-btn" :class="{ primary: !authOn }" type="button" :disabled="policyBusy" @click="togglePolicy">{{ authOn ? '关闭' : '打开' }}</button>
          </div>
          <p v-if="policyErr" class="errline">{{ policyErr }}</p>
        </div>
        <div class="f-card">
          <template v-if="chat.pairingSession && !expired">
            <div class="code">{{ fmtPairingCode(chat.pairingSession.code) }}</div>
            <p class="wait t-body">等待对端输入…<span class="tnum" :class="tone">{{ remain }}s 后过期</span></p>
            <p v-if="chat.pairingMeta?.protocol === 2" class="f-hint">认证配对：这个码以 0 开头，12 位要全部输入。还可以尝试 {{ chat.pairStatus?.host?.attemptsLeft ?? chat.pairingMeta.attempts ?? 5 }} 次；输错 5 次，或对方用不支持认证配对的版本输入了这个码，它就作废。</p>
            <p class="f-hint">对端需要填这台机器的 host:port。指纹：{{ fmtFingerprint(chat.pairingSession.myFingerprint) }}</p>
            <div class="f-row"><button class="f-btn ghost" type="button" @click="chat.cancelPairing()">取消</button></div>
          </template>
          <template v-else-if="expired">
            <p class="t-body errline">配对码已过期，请重新发起。</p>
            <div class="f-row"><button class="f-btn primary" type="button" @click="begin">重新发起</button></div>
          </template>
          <template v-else>
            <p v-if="hostNote" class="t-body" :class="hostNoteOk ? 'okline' : 'errline'">{{ hostNote }}</p>
            <div class="f-row"><button class="f-btn primary" type="button" @click="begin">生成配对码</button></div>
          </template>
        </div>
      </section>

      <section class="f-sec">
        <h2>加入配对</h2>
        <p class="f-note">另一台机器已经生成了配对码，就在这里填它的地址和码。</p>
        <p class="f-note">{{ PAIRING_DELETE_NOTE }}</p>
        <form class="f-card" @submit.prevent="join">
          <div class="f-grid">
            <label class="f-label">
              <span>对方地址</span>
              <input v-model="joinAddr" class="f-input" placeholder="192.168.1.5:7820" />
            </label>
            <label class="f-label">
              <span>配对码</span>
              <input :value="joinCode" class="f-input codein" placeholder="8 位，或以 0 开头的 12 位" @input="onCodeInput" />
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
.syncrow { display: flex; align-items: center; gap: var(--sp-5); }
.synctxt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.synclabel { color: var(--c-ink); font-weight: var(--w-md); }
.syncsub { color: var(--c-ink-3); }
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
/* F11C：配对方式的小标记，跟在设备名后面 */
.dtag { margin-left: var(--sp-2); font-size: var(--t-aux-size); font-weight: 400; color: var(--c-ink-3); }
.dtag.ok { color: var(--c-ok); }
.dtime { color: var(--c-ink-3); flex: 0 0 auto; }

/* 配对码要隔着一米看得清：另一台机器上的人是照着屏幕抄的 */
.code {
  font-family: var(--f-mono); font-size: 32px; line-height: 1.3; letter-spacing: 8px;
  text-align: center; color: var(--c-ink); padding: var(--sp-4) 0;
}
.codein { font-family: var(--f-mono); letter-spacing: 3px; }
/* 占位符不跟着拉字距：「8 位，或以 0 开头的 12 位」被拉开后像一串代码而不是提示 */
.codein::placeholder { letter-spacing: normal; }
.wait { margin: 0; text-align: center; color: var(--c-ink-2); display: flex; gap: var(--sp-3); justify-content: center; }
.wait .warn { color: var(--c-warn); }
.wait .danger { color: var(--c-err); }
.errline { margin: 0; font-size: var(--t-body-size); color: var(--c-err); }
.okline { margin: 0; color: var(--c-ok); }
</style>
