import { createRenderer, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import StageChat from '../../src/renderer/src/ui/StageChat.vue';
import { useChat } from '../../src/renderer/src/stores/chat';
import { rpc } from '../../src/renderer/src/rpc';
import type { ContextRecoveryView } from '../../src/shared/compaction';
import type { RunView } from '../../src/shared/run';

type Host = { tag: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null };
const node = (tag: string, text = ''): Host => ({ tag, text, props: {}, children: [], parent: null });
const detach = (n: Host) => { if (n.parent) { const at = n.parent.children.indexOf(n); if (at >= 0) n.parent.children.splice(at, 1); } };
const renderer = createRenderer<Host, Host>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; n.children = []; },
  insert(n, parent, anchor = null) { detach(n); n.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, n); },
  remove: detach, parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  patchProp: (n, key, _old, value) => { n.props[key] = value; },
});
const all = (n: Host | undefined): Host[] => n ? [n, ...n.children.flatMap(all)] : [];
const textOf = (n: Host | undefined): string => !n ? '' : (n.tag === '#comment' ? '' : n.text) + n.children.map(textOf).join('');
const hasClass = (n: Host, name: string) => String(n.props.class ?? '').split(/\s+/).includes(name);
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
globalThis.requestAnimationFrame = cb => { const id = nextFrame++; frames.set(id, cb); return id; };
globalThis.cancelAnimationFrame = id => { frames.delete(id); };
const settle = async () => { await nextTick(); for (let pass = 0; pass < 3; pass++) { const jobs = [...frames.values()]; frames.clear(); for (const cb of jobs) cb(pass * 16); await nextTick(); } };
// N05b新增用户输入监听和底部观察器；此宿主无布局，位置仍由原有场景控制。
(globalThis as any).window = { matchMedia: () => ({ matches: false }), addEventListener: () => {}, removeEventListener: () => {} };
(globalThis as any).IntersectionObserver = class { observe(): void {} disconnect(): void {} };
const stats = (globalThis as any).__q11Probe = { historyParses: 0, stageUpdates: 0 };

async function main() {
  const pinia = createPinia(); setActivePinia(pinia); const chat = useChat(pinia);
  let stored: any[] = [];
  let historyReply: Promise<any> | undefined;
  (rpc as any).call = async (method: string) => method === 'chat.messages.list' ? (historyReply ?? stored) : {};
  const messages = Array.from({ length: 12 }, (_, i) => [
    { id: 'U' + i, role: 'user', parts: [{ type: 'text', value: '**literal user** ' + i }], createdAt: i * 2 },
    { id: 'A' + i, role: 'assistant', parts: [{ type: 'text', value: 'HIST-' + i + ' **history bold**' }], reasoningContent: i === 0 ? '历史思考' : undefined, createdAt: i * 2 + 1 },
  ]).flat();
  chat.$patch(state => { state.activeId = 'S';state.sessions = [{ id: 'S', title: 'fixture' }];state.messages = messages;state.running = true;state.runningSessions = ['S']; });
  const root = node('root'), app = renderer.createApp(StageChat); app.use(pinia); app.mount(root); await settle();
  const live = () => all(root).find(n => n.props['data-turn-id'] === 'live');
  const body = () => textOf(live() && all(live()!).find(n => hasClass(n, 'md')));
  const thinking = () => textOf(live() && all(live()!).find(n => hasClass(n, 'tbody')));
  const messageRoots = (id: string) => all(root).filter(n => n.props['data-mid'] === id && 'data-anno-root' in n.props);
  const initialParses = stats.historyParses;
  stats.historyParses = 0; stats.stageUpdates = 0;
  let expectedText = '', expectedThinking = '';
  for (let i = 0; i < 24; i++) {
    const text = i % 2 ? '思考' + i : '**live bold** ' + i + ' ';
    if (i % 2) expectedThinking += text; else expectedText += text;
    chat.onEvent({ kind: i % 2 ? 'thinkingDelta' : 'textDelta', text }); await settle();
  }
  const history0 = messageRoots('A0')[0], user0 = messageRoots('U0')[0];
  const count = { initialParses, historyParses: stats.historyParses, stageUpdates: stats.stageUpdates, H: 12, N: 24 };
  const scroller = all(root).find(n => hasClass(n,'scroll'))! as Host & { scrollTop: number;scrollHeight: number;clientHeight: number;querySelector: (q:string)=>unknown };
  scroller.scrollHeight = 1000;scroller.clientHeight = 100;scroller.scrollTop = 900;
  const navigationOptions: ScrollIntoViewOptions[] = [];
  scroller.querySelector = () => ({ scrollIntoView: (options: ScrollIntoViewOptions) => { navigationOptions.push(options); scroller.scrollTop = 0; } });
  scroller.props.onScroll();
  const savedBody = chat.streamingText;chat.onEvent({ kind: 'textDelta', text: 'queued-scroll' });await nextTick();await nextTick();
  const queuedFrames = frames.size;
  all(root).find(n => hasClass(n,'tdot') && !hasClass(n,'live'))!.props.onClick();await settle();
  const pendingNavigation = { queuedFrames, scrollTop: scroller.scrollTop };
  // Q11b：跳转在滚动停下之后收尾，按停下的位置决定还跟不跟随。宿主没有真实滚动，位置和滚动事件都由这里摆。
  const jumpEnds = () => new Promise<void>(r => setTimeout(r, 300)).then(settle);
  const dot = (liveDot: boolean) => all(root).find(n => hasClass(n,'tdot') && hasClass(n,'live') === liveDot)!;
  await jumpEnds();chat.onEvent({ kind: 'textDelta', text: 'after-jump-away' });await settle();
  const jumpAway = { scrollTop: scroller.scrollTop };
  // 回到底部，再点「正在进行的回合」：画面不动，没有任何滚动事件
  scroller.scrollTop = 900;scroller.props.onScroll();
  scroller.querySelector = () => ({ scrollIntoView: () => {} });
  dot(true).props.onClick();
  scroller.scrollHeight = 1400;chat.onEvent({ kind: 'textDelta', text: 'during-still-jump' });await settle();
  const stillJump = { during: scroller.scrollTop, afterIdle: 0, nextDelta: 0 };
  await jumpEnds();stillJump.afterIdle = scroller.scrollTop;
  scroller.scrollHeight = 1800;chat.onEvent({ kind: 'textDelta', text: 'after-still-jump' });await settle();stillJump.nextDelta = scroller.scrollTop;
  // 点历史回合：平滑滚动的头一帧离底部还不到 120，期间来了新内容；之后滚到很远处停下
  scroller.scrollTop = 1700;scroller.props.onScroll();
  scroller.querySelector = () => ({ scrollIntoView: () => { scroller.scrollTop = 1650; } });
  dot(false).props.onClick();scroller.props.onScroll();
  chat.onEvent({ kind: 'textDelta', text: 'during-moving-jump' });await settle();
  const movingJump = { firstFrame: scroller.scrollTop, stillScrolling: 0, end: 0 };
  // 滚动还在继续（每 150 毫秒一个滚动事件）、人仍在底部附近：起跳已过 300 毫秒，照样不贴底
  for (let i = 0; i < 2; i++) { await new Promise<void>(r => setTimeout(r, 150));scroller.props.onScroll(); }
  chat.onEvent({ kind: 'textDelta', text: 'still-scrolling' });await settle();movingJump.stillScrolling = scroller.scrollTop;
  scroller.scrollTop = 200;scroller.props.onScroll();await jumpEnds();
  chat.onEvent({ kind: 'textDelta', text: 'after-moving-jump' });await settle();movingJump.end = scroller.scrollTop;
  chat.streamingText = savedBody;await settle();
  const anchors = { navigationOptions, historyIds: all(root).filter(n => n.props['data-turn-id'] && n.props['data-turn-id'] !== 'live').map(n => n.props['data-turn-id']), liveExists: !!live(), hiddenWhenIdle: false };
  chat.streamingText = '';chat.streamingThinking = '';chat.running = false;await settle();anchors.hiddenWhenIdle = !live();
  chat.running = true;chat.streamingText = expectedText;chat.streamingThinking = expectedThinking;await settle();
  const wiring = { historyUsesMarkdown: !!history0 && all(history0).some(n => n.tag === 'strong' && textOf(n) === 'history bold'),
    liveUsesMarkdown: !!live() && all(live()!).some(n => n.tag === 'strong' && textOf(n) === 'live bold'),
    userPlain: textOf(user0).includes('**literal user**') && !all(user0).some(n => n.tag === 'strong'),
    liveThinking: thinking() === expectedThinking, historyThinking: all(root).some(n => hasClass(n, 'think') && textOf(n).includes('思考过程')) };
  chat.toolCards = [{ toolUseId: 'T1', name: 'file_edit', title: 'live', input: '{"path":"a","tool_title":"live"}' }, { toolUseId: 'T2', name: 'file_write', title: 'second', input: '{"path":"b","tool_title":"second"}' }];await settle();
  const liveInputs = JSON.parse(all(live()).find(n => n.tag === 'probe-steps')?.props.snapshot ?? '[]').map((s: any) => s.input);
  const normal = { body: !!all(live()!).find(n => hasClass(n,'md')), thinking: !!all(live()!).find(n => hasClass(n,'tbody')), steps: !!all(live()!).find(n => n.tag === 'probe-steps') };
  chat.midRun = true;await settle();
  const midRun = { text: textOf(live()), elapsed: textOf(all(live()).find(n => hasClass(n, 'turn-elapsed'))), body: !!all(live()!).find(n => hasClass(n,'md')), thinking: !!all(live()!).find(n => hasClass(n,'tbody')), steps: !!all(live()!).find(n => n.tag === 'probe-steps') };
  chat.streamingText = '';chat.streamingThinking = '';await settle();const midRunEmpty = textOf(live());
  const midRunEmptyElapsed = textOf(all(live()).find(n => hasClass(n, 'turn-elapsed')));
  chat.midRun = false;chat.streamingText = expectedText;chat.streamingThinking = expectedThinking;await settle();
  stats.historyParses = 0;
  chat.messages[1].parts[0].value = 'HIST-0 **changed**'; await settle();
  const edit = { reparses: stats.historyParses, changedVisible: textOf(messageRoots('A0')[0]).includes('changed') };
  stats.historyParses = 0;
  chat.messages[3].parts.push({ type: 'text', value: 'HIST-second **separate**' }); await settle();
  const multipleBlocks = { reparses: stats.historyParses, texts: messageRoots('A1').map(textOf) };
  chat.onEvent({ kind: 'retry', attempt: 1, delayMs: 0 }); await settle();
  const retry = { text: body(), thinking: thinking() };
  chat.onEvent({ kind: 'textDelta', text: '**after retry**' }); chat.onEvent({ kind: 'thinkingDelta', text: '新思考' }); await settle();
  chat.onEvent({ kind: 'fallback', from: 'a', to: 'b', reason: 'fixture' }); await settle();
  const fallback = { text: body(), thinking: thinking() };
  chat.onEvent({ kind: 'textDelta', text: '**before recovery**' }); await settle();
  const recoveryView: ContextRecoveryView = { v: 1, incident: 1, seq: 1, slot: { label: 'a', modelId: 'a' }, phase: 'resending', rejections: 1, resends: 1, runRejections: 1,
    before: { slot: 'a', inputTokens: 10, inputLimit: 100, maxTokens: 5, status: 'ok' }, after: { slot: 'a', inputTokens: 5, inputLimit: 100, maxTokens: 5, status: 'ok' }, actions: [], limits: { resendsPerIncident: 2, rejectionsPerRun: 3 } };
  chat.onEvent({ kind: 'contextRecovery', view: recoveryView }); await settle();
  const recovery = { text: body(), thinking: thinking() };
  let seed = 0x7151;
  const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const randomCases: { expected: string; actual: string; expectedRenderedBody: string; actualRenderedBody: string; expectedThinking: string; actualThinking: string; resets: string[]; resumes: number }[] = [];
  const full = '中文 **bold** 😊\n\n- one\n- two\n\n```ts\nx\n```\n\nfinal';
  chat.onEvent({ kind: 'retry', attempt: 1, delayMs: 0 });chat.onEvent({ kind: 'textDelta', text: full });await settle();
  const referenceRendered = body();
  const run: RunView = { runId: 'R', sessionId: 'S', epoch: 1, generation: 1, state: 'running', step: 'model', toolBatches: 0, origin: { kind: 'user' }, createdAt: 1, updatedAt: 1 };
  const reconnect = () => {
    chat.connection = 'reconnecting';
    chat.applySnapshot({ epoch: 1, instanceId: 'fixture', revision: 1, lastSeq: 1, takenAt: 1, sessions: [{ id: 'S', title: 'fixture', createdAt: 1, updatedAt: 1 }],
      runs: [run], executions: [], pendingPermissions: [], artifacts: [], live: [{ runId: 'R', sessionId: 'S', generation: 1, epoch: 1, seq: 1, text: chat.streamingText, thinking: chat.streamingThinking }],
      session: { sessionId: 'S', exists: true, messages: JSON.parse(JSON.stringify(chat.messages)) } } as any, { reason: 'no-cursor', cause: 'reconnect', epochChanged: false });
    chat.reconcileResume({ mode: 'resume', epoch: 1, runs: [run], pendingPermissions: [] } as any);
    chat.connection = 'ok';
  };
  for (let sample = 0; sample < 16; sample++) {
    chat.onEvent({ kind: 'retry', attempt: 1, delayMs: 0 }); await settle();
    const resets: string[] = []; let position = 0, thought = '', resumes = 0;
    while (position < full.length) {
      const width = 1 + random() % 7, chunk = full.slice(position, position + width); position += chunk.length;
      chat.onEvent({ kind: 'textDelta', text: chunk });
      const t = '想' + random() % 10; thought += t; chat.onEvent({ kind: 'thinkingDelta', text: t });
      if (position < full.length && random() % 13 === 0) {
        const kind = ['retry','fallback','contextRecovery'][random() % 3]; resets.push(kind);
        chat.onEvent(kind === 'retry' ? { kind, attempt: 2, delayMs: 0 } : kind === 'fallback' ? { kind, from: 'a', to: 'b', reason: 'fixture' } : { kind, view: recoveryView });
        position = 0; thought = '';
      }
      if (random() % 7 === 0) { reconnect(); resumes++; }
      await settle();
    }
    randomCases.push({ expected: full, actual: chat.streamingText, expectedRenderedBody: referenceRendered, actualRenderedBody: body(), expectedThinking: thought, actualThinking: thinking(), resets, resumes });
  }
  chat.onEvent({ kind: 'retry', attempt: 1, delayMs: 0 });
  chat.joinedTail = true;chat.onEvent({ kind: 'textDelta', text: 'persisted-prefix' });chat.onEvent({ kind: 'thinkingDelta', text: 'persisted-thought' });await settle();
  let resolve!: (messages: any[]) => void;historyReply = new Promise(r => { resolve = r; });
  const pending = chat.refreshJoinedHistory();
  chat.onEvent({ kind: 'textDelta', text: 'late-tail' });chat.onEvent({ kind: 'thinkingDelta', text: 'late-thought' });
  stored = [...chat.messages, { id: 'PERSIST', role: 'assistant', parts: [{ type: 'text', value: 'persisted-prefix' }], reasoningContent: 'persisted-thought', createdAt: 30 }];
  resolve(stored);await pending;historyReply = undefined;await settle();
  const tail = { text: body(), thinking: thinking(), persisted: messageRoots('PERSIST').map(textOf), canonical: chat.streamingText };
  app.unmount();frames.clear();
  console.log(JSON.stringify({ count, pendingNavigation, jumpAway, stillJump, movingJump, anchors, wiring, liveInputs, normal, midRun, midRunEmpty, midRunEmptyElapsed, edit, multipleBlocks, retry, fallback, recovery, randomCases, tail, expectedText }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
