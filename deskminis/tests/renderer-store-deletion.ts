/** Q20b：删除路径的全state键哨兵。新增state键必须同时补表，否则tsc失败。 */
import { expect } from 'vitest';
import type { Chat } from './renderer-store-fixture';

export const deletionSentinels = {
  sessions: [{ id: 'A', title: 'A' }], activeId: 'A',
  messages: [{ id: 'old', role: 'user', parts: [{ type: 'text', value: '旧消息' }], createdAt: 1 }],
  streamingText: '正文', streamingThinking: '思考', toolCards: [{ toolUseId: 'T', name: 'tool', title: '工具' }],
  pendingPerms: [{ requestId: 'P', sessionId: 'B', detail: '审批', kind: 'file-write', toolTitle: '写文件' }],
  permFocusRequestId: 'P', pendingFilePreview: 'file.txt', draft: { text: '草稿', attachments: [] },
  relayDraft: { sessionId: 'B', text: '接力' }, relaySource: { sessionId: 'B', text: '来源' },
  providers: [{ id: 'P', name: '模型', kind: 'openai', modelId: 'm', hasApiKey: true }], modelGroups: [{ id: 'G', name: '组', memberIds: ['P'] }],
  assistants: [{ id: 'AS', name: '助手', avatar: 'a', rules: 'r', skillIds: [], prompts: [], sortOrder: 1 }],
  welcomeAssistantId: 'AS', cronJobs: [{ id: 'C', name: '定时', prompt: 'p', scheduleKind: 'once', scheduleValue: '1', enabled: true, lastStatus: 'done' }],
  searchProvider: { kind: 'tavily', hasKey: true }, skills: [{ id: 'S', name: '技能', description: '描述', isEnabled: true, useCount: 3 }], allSkills: [{ id: 'S', name: '技能', description: '禁用', isEnabled: false, useCount: 4 }],
  skillImport: { taskId: 'I', state: 'done', total: 1, completed: 1, succeeded: ['S'], failures: [] },
  mcpServers: { servers: [{ name: 'srv', transport: 'stdio', enabled: true, command: 'cmd' }], statuses: [], configError: true },
  annotations: [{ id: 'N', messageId: 'old', exact: '旧', prefix: 'p', suffix: 's', note: 'n', color: 'yellow' }],
  lastError: '旧错', retryNote: '重试', running: true, runningSessions: ['A', 'B'], midRun: true,
  connection: 'reconnecting', link: { attempt: 2, maxAttempts: 3, retryInMs: 50 }, linkRetryable: true, linkGeneration: 4, refreshTick: 5,
  syncOn: true, engineEpoch: 7, streamRevision: 8, inputsOn: true,
  inputsBySession: { B: [{ sessionId: 'B', messageId: 'I', seq: 1, mode: 'queue', text: '输入', attachments: [], state: 'pending', createdAt: 1, updatedAt: 2 }] },
  inDoubtInputs: [{ sessionId: 'B', messageId: 'II', mode: 'queue', text: '输入', attachments: [] }],
  inputRetryBySession: { B: { sessionId: 'B', messageId: 'IR', mode: 'queue', text: '重试', attachments: [] } },
  failedInputDrafts: { B: [{ sessionId: 'B', messageId: 'IF', mode: 'queue', text: '失败', attachments: [] }] },
  stopSummaries: { B: { sessionId: 'B', runId: 'RB', started: 1, notStarted: 2, unknown: 3, possibleSideEffects: true } }, runOf: { A: { runId: 'RA', generation: 1, ended: false }, B: { runId: 'RB', generation: 2, ended: false } },
  pendingStarts: { B: { runId: 'RB', since: 1 } }, goneSessions: ['gone-before'], joinedTail: true,
  inDoubtPrompts: [{ sessionId: 'B', promptId: 'PB', text: '发送', attachments: ['a.txt'], optimisticId: 'local-B' }],
  inDoubtPerms: [{ requestId: 'MP', sessionId: 'B' }],
  undelivered: { sessionId: 'B', promptId: 'UB', text: '未送达', attachments: [], optimisticId: 'local-U' },
  thinkingLevel: 'high', defaultProviderId: 'P', permTier: 'full', lastStopReason: 'cancelled',
  eventNotes: [{ kind: 'error', ts: 1, detail: '旧事' }], fallbackState: { from: 'P', to: 'Q', reason: '失败' },
  compactedState: { markerId: 'M', summary: '摘要' }, offloadedState: { count: 3, lastRelativePath: 'off.txt' },
  contextRecoveryState: { v: 1, incident: 1, seq: 2, slot: { label: '模型', modelId: 'm' }, phase: 'recovered', rejections: 1, resends: 1, runRejections: 1, before: { slot: 'P', inputTokens: 100, inputLimit: 50, maxTokens: 10, status: 'over' }, actions: [], limits: { resendsPerIncident: 2, rejectionsPerRun: 6 } }, compactionDetail: { markerId: 'M', v: 2, form: 'structured' },
  contextInfo: { windowTokens: 100, usedTokens: 70, remaining: 30 }, lastOutputLimit: { requested: 100, limitedBy: 'model', continued: 1 },
  devices: [{ peerFingerprint: 'FP', peerName: '设备', roomId: 'R', createdAt: 1, online: true, lastSeenAt: 2 }],
  pairingSession: { code: 'CODE', myFingerprint: 'FP', expiresIn: 30, startedAt: 1 },
  deviceMeta: { FP: { pairingProtocol: 2, canUpgradePairing: true } },
  pairStatus: { policy: 'authenticated', defaultPolicy: 'legacy' }, pairingMeta: { protocol: 2, attempts: 3 },
  attachmentViews: { 'a.txt': { name: 'a.txt', relativePath: 'a.txt', mimeType: 'text/plain', state: 'ready', conflict: false, localAvailable: true, canRetry: false, canCancel: false } },
  retainedSessions: [{ id: 'R1', title: '保留', deletedBy: 'FP', deletedAt: 1, retainedAt: 2, messageCount: 5, unseenCount: 2, annotationCount: 1 }],
  devicesLoaded: true, syncState: 'syncing', syncPaused: true, workspaceRoot: '/project', workspaceIsDefault: false,
} satisfies Chat['$state'] & Record<keyof Chat['$state'], unknown>;

export function seedDeletion(chat: Chat): void {
  chat.$reset();
  const defaults = JSON.parse(JSON.stringify(chat.$state));
  for (const [key, value] of Object.entries(deletionSentinels)) expect(value, key + ' 非默认哨兵').not.toEqual(defaults[key]);
  Object.assign(chat.$state, structuredClone(deletionSentinels));
}
