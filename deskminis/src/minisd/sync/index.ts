/** M3b 同步模块装配工厂。Task 5 导出 createSyncMethods + OutboundClient；Task 6 追加 SyncCoordinator。 */
export { createSyncMethods } from './rpc';
export { SyncCoordinator } from './coordinator';
export type { SyncCoordinatorOpts } from './coordinator';
export { OutboundClient } from './outbound-client';
export type { OutboundClientOpts } from './outbound-client';
// F11B：会话生命周期（墓碑与显式恢复）
export { receiveRemotePayload } from './receive';
export type { SyncReceiveResult, TombstoneHost, TombstoneOutcome } from './receive';
export { compareLifecycle, decideIncoming, isDeletedVersion, unseenOf } from './lifecycle';
export type { SyncPayload, WireLifecycle, WireLifecycleHead, WireSeen } from './wire';
// F11A：附件同步
export { createAttachmentSync } from './attachments';
export type { AttachmentSync, AttachmentSyncDeps, AttachmentSyncPort, AttachmentStore } from './attachments';
