/**
 * F11A 附件同步的装配入口。minisd/index.ts 只调 createAttachmentSync，拿到：
 *   port          交给 SyncCoordinator（触发、暂停、关停）
 *   peerMethods   sync.att.*，装配处逐个包 guardBusinessMethod(…, k, isPaired)
 *   localMethods  attachments.*，同样包守卫；方法体内只许 local
 *   onPeerHello   交给 createSyncMethods：应答端记下每个入站对端的声明
 */
import type { RpcMethods } from '../../rpc/server';
import type { SyncPeerInfo } from '../wire';
import { AttachmentEngine, type AttachmentSyncDeps, type AttachmentSyncPort } from './engine';
import { createAttachmentLocalMethods, createAttachmentPeerMethods } from './rpc';
import type { AttachmentStore } from './store';

export type { AttachmentSyncDeps, AttachmentSyncPort } from './engine';
export type { AttachmentStore, AttachmentRow, RefInfo } from './store';
export type { AttachmentLimits } from './limits';
export type { AttachmentIo, VerifiedFile } from './io';

export interface AttachmentSync {
  readonly store: AttachmentStore;
  readonly port: AttachmentSyncPort;
  readonly peerMethods: RpcMethods;
  readonly localMethods: RpcMethods;
  /** 永不抛。 */
  onPeerHello(peerFp: string | undefined, peer: SyncPeerInfo): void;
  /** 没有在跑的作业与处理器时 resolve（只给测试）。 */
  idle(): Promise<void>;
}

/** 构造时同步执行 store.recover()（监听端口之前）：清掉上次留下的 .stage、无主或过期的 .part、已不存在的会话的行。 */
export function createAttachmentSync(deps: AttachmentSyncDeps): AttachmentSync {
  const engine = new AttachmentEngine(deps);
  try { engine.store.recover(); } catch { /* 自检失败不挡启动；残留的暂存不经整文件校验不会被发布 */ }
  const port: AttachmentSyncPort = {
    markDirty: sid => engine.markDirty(sid),
    onPeerOnline: fp => { try { engine.onPeerOnline(fp); } catch { /* 端口方法永不抛 */ } },
    onRemoteDirty: (fp, sid) => { try { engine.onRemoteDirty(fp, sid); } catch { /* 同上 */ } },
    schedule: (fp, sid) => { try { engine.schedule(fp, sid); } catch { /* 同上 */ } },
    setPaused: p => engine.setPaused(p),
    stop: () => { try { engine.stop(); } catch { /* 同上 */ } },
  };
  return {
    store: engine.store,
    port,
    peerMethods: createAttachmentPeerMethods(engine),
    localMethods: createAttachmentLocalMethods(engine),
    onPeerHello: (fp, peer) => engine.onPeerHello(fp, peer),
    idle: () => engine.idle(),
  };
}
