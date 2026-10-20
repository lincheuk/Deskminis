/**
 * F08：文件检查点的 RPC 面。七个方法全部只许本机连接——对比接口会返回工作区外文件的内容，
 * 恢复与另存会改用户的文件；开放给已配对的远程设备是新的暴露面。
 * 装配处另逐个包 guardBusinessMethod（每次调用复查配对）。恢复、另存要带 confirm: true；没有任何强制选项。
 */
import { CHECKPOINT_RESTORE_MAX_ITEMS } from '../../shared/checkpoint';
import type { RpcMethods } from '../rpc/server';
import { assertAuthMode } from '../rpc/access';
import type { CheckpointService } from './restore';
import type { CheckpointStore } from './store';

const LOCAL_ONLY = '文件检查点只能在运行 DeskMinis 引擎的这台电脑上查看和恢复';

function sessionIdOf(p: unknown): string {
  const v = (p as { sessionId?: unknown } | null | undefined)?.sessionId;
  if (typeof v !== 'string' || v === '') throw new Error('缺少 sessionId');
  return v;
}
function idOf(p: unknown): string {
  const v = (p as { id?: unknown } | null | undefined)?.id;
  if (typeof v !== 'string' || v === '') throw new Error('缺少检查点 id');
  return v;
}
function idsOf(p: unknown): string[] {
  const v = (p as { ids?: unknown } | null | undefined)?.ids;
  if (!Array.isArray(v) || v.length === 0 || v.some(x => typeof x !== 'string' || x === '')) throw new Error('ids 必须是非空的检查点 id 数组');
  if (v.length > CHECKPOINT_RESTORE_MAX_ITEMS) throw new Error(`一次最多处理 ${CHECKPOINT_RESTORE_MAX_ITEMS} 条检查点`);
  return v as string[];
}
function assertConfirm(p: unknown, what: string): void {
  if ((p as { confirm?: unknown } | null | undefined)?.confirm !== true) throw new Error(`${what}需要明确确认（confirm: true）`);
}

export function createCheckpointMethods(
  svc: CheckpointService, store: CheckpointStore,
  deps: { audit?(eventType: string, payload: unknown, opts: { sessionId?: string }): void; warn?(msg: string, e?: unknown): void } = {},
): RpcMethods {
  const warn = deps.warn ?? ((msg: string, e?: unknown): void => { console.warn(msg, e); });
  return {
    'checkpoints.list': (p: unknown, conn) => { assertAuthMode(conn, ['local'], 'checkpoints.list', LOCAL_ONLY); return svc.list(sessionIdOf(p)); },
    'checkpoints.inspect': (p: unknown, conn) => { assertAuthMode(conn, ['local'], 'checkpoints.inspect', LOCAL_ONLY); return svc.inspect(sessionIdOf(p), idsOf(p)); },
    'checkpoints.diff': async (p: unknown, conn) => { assertAuthMode(conn, ['local'], 'checkpoints.diff', LOCAL_ONLY); return svc.diff(sessionIdOf(p), idOf(p)); },
    'checkpoints.restore': async (p: unknown, conn) => {
      assertAuthMode(conn, ['local'], 'checkpoints.restore', LOCAL_ONLY);
      assertConfirm(p, '恢复');
      return svc.restore(sessionIdOf(p), idsOf(p));
    },
    'checkpoints.saveCopy': (p: unknown, conn) => {
      assertAuthMode(conn, ['local'], 'checkpoints.saveCopy', LOCAL_ONLY);
      assertConfirm(p, '另存');
      const which = (p as { which?: unknown }).which;
      if (which !== 'before' && which !== 'after') throw new Error("which 必须是 'before' 或 'after'");
      return svc.saveCopy(sessionIdOf(p), idOf(p), which);
    },
    'checkpoints.usage': (_p: unknown, conn) => {
      assertAuthMode(conn, ['local'], 'checkpoints.usage', LOCAL_ONLY);
      // 进门先清理：界面看到的占用是清过的
      store.prune(0);
      return store.usage();
    },
    'checkpoints.setQuota': (p: unknown, conn) => {
      assertAuthMode(conn, ['local'], 'checkpoints.setQuota', LOCAL_ONLY);
      const quotaBytes = (p as { quotaBytes?: unknown } | null | undefined)?.quotaBytes;
      const prev = store.usage().quotaBytes;
      const usage = store.setQuota(quotaBytes as number);
      try { deps.audit?.('checkpoint.quota', { quotaBytes: usage.quotaBytes, prev }, {}); }
      catch (e) { warn('文件检查点：改容量的审计写入失败:', e); }
      return usage;
    },
  };
}
