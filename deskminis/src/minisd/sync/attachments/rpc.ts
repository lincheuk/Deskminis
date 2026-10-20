/**
 * F11A 附件同步的 RPC 面。
 *
 * 对端方法 sync.att.manifest / get / put：只在加密通道上的 remote 连接、且对端声明了 attachments 能力位时受理
 * （检查在引擎的 enter() 里，每个方法体开头都过）。装配处另逐个包 guardBusinessMethod（每次调用复查配对）。
 * 本机方法 attachments.status / retry / cancel / read：只许本机连接——它们回本机绝对路径与文件内容。
 */
import type { RpcMethods } from '../../rpc/server';
import { assertAuthMode } from '../../rpc/access';
import { AttachmentEngine } from './engine';

export function createAttachmentPeerMethods(engine: AttachmentEngine): RpcMethods {
  return {
    'sync.att.manifest': (p: unknown, conn) => engine.handleManifest(p, conn),
    'sync.att.get': (p: unknown, conn) => engine.handleGet(p, conn),
    'sync.att.put': (p: unknown, conn) => engine.handlePut(p, conn),
  };
}

export function createAttachmentLocalMethods(engine: AttachmentEngine): RpcMethods {
  return {
    'attachments.status': async (p: unknown, conn) => {
      assertAuthMode(conn, ['local'], 'attachments.status', `attachments.status 只允许本机连接，当前=${conn.authMode}`);
      return engine.status(AttachmentEngine.assertLocalArgs(p, false).sessionId);
    },
    'attachments.retry': async (p: unknown, conn) => {
      assertAuthMode(conn, ['local'], 'attachments.retry', `attachments.retry 只允许本机连接，当前=${conn.authMode}`);
      const a = AttachmentEngine.assertLocalArgs(p, true);
      return engine.retry(a.sessionId, a.name);
    },
    'attachments.cancel': async (p: unknown, conn) => {
      assertAuthMode(conn, ['local'], 'attachments.cancel', `attachments.cancel 只允许本机连接，当前=${conn.authMode}`);
      const a = AttachmentEngine.assertLocalArgs(p, true);
      return engine.cancel(a.sessionId, a.name);
    },
    'attachments.read': async (p: unknown, conn) => {
      assertAuthMode(conn, ['local'], 'attachments.read', `attachments.read 只允许本机连接，当前=${conn.authMode}`);
      // 读本机文件的名字规则比同步的宽一档：名字不合规、不同步的附件，用户照样打得开自己的那一份
      const a = AttachmentEngine.assertLocalArgs(p, true, true);
      return engine.read(a.sessionId, a.name);
    },
  };
}
