import type { AuthMode, RpcMethods } from './server';
import { assertAuthMode } from './access';
import { guardBusinessMethod } from '../remote';

export type RpcAccess = 'business' | { readonly authModes: readonly AuthMode[] };

/** Access is declared for every registration, including groups added late. */
export class RpcMethodRegistry {
  private readonly entries: RpcMethods = Object.create(null);
  constructor(private readonly isPaired: (fingerprint: string) => boolean) {}

  register(group: RpcMethods, access: RpcAccess | ((name: string) => RpcAccess)): void {
    const methods = Object.entries(group);
    for (const [name] of methods) {
      if (Object.hasOwn(this.entries, name)) throw new Error(`RPC 方法重复注册: ${name}`);
    }
    // Prepare the whole group before publishing it: a rejected registration adds nothing.
    const guarded = methods.map(([name, method]) => {
      const policy = typeof access === 'function' ? access(name) : access;
      const handler: RpcMethods[string] = policy === 'business'
        ? guardBusinessMethod(method, name, this.isPaired)
        : (params, conn) => { assertAuthMode(conn, policy.authModes, name); return method(params, conn); };
      return [name, handler] as const;
    });
    for (const [name, method] of guarded) this.entries[name] = method;
  }

  /** The server receives a frozen copy; subsequent registration cannot overwrite it. */
  get methods(): RpcMethods { return Object.freeze({ ...this.entries }); }
}
