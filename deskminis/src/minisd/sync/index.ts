/** M3b 同步模块装配工厂。Task 5 导出 createSyncMethods + OutboundClient；Task 6 追加 SyncCoordinator。 */
export { createSyncMethods } from './rpc';
export { SyncCoordinator } from './coordinator';
export type { SyncCoordinatorOpts } from './coordinator';
export { OutboundClient } from './outbound-client';
export type { OutboundClientOpts } from './outbound-client';
