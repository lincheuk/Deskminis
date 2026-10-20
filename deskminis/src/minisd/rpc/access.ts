import type { AuthMode, RpcConnection } from './server';

/** One auth-mode check; callers retain their existing domain-specific errors. */
export function assertAuthMode(conn: RpcConnection | undefined, allowed: readonly AuthMode[], what: string, message?: string): void {
  const mode = conn?.authMode;
  if (mode === undefined || !allowed.includes(mode)) {
    throw new Error(message ?? `${what} 需要 authMode=${allowed.join('/')}，当前=${mode}`);
  }
}
