import { createRequire } from 'node:module';
import { BlockList, isIP } from 'node:net';

const nativeRequire = createRequire(import.meta.url);
const direct = new BlockList();
for (const [address, prefix] of [
  ['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12],
  ['192.168.0.0', 16], ['169.254.0.0', 16],
] as const) direct.addSubnet(address, prefix, 'ipv4');
direct.addAddress('::1', 'ipv6');
direct.addSubnet('fc00::', 7, 'ipv6');
const isDirectAddress = direct.check.bind(direct);

/** 本机与局域网不依赖系统代理的绕过名单；BlockList 同时识别 IPv4 映射的 IPv6。 */
export function isDirectUrl(input: Parameters<typeof fetch>[0]): boolean {
  const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const family = isIP(host);
  return family !== 0 && isDirectAddress(host, family === 6 ? 'ipv6' : 'ipv4');
}

/** Electron 引擎走 Chromium 的系统代理；CLI/单测保留原出口，目录可注入原环境变量出口。
 *  不改全局 dispatcher，也不接管同步与配对的连接。fallback 延迟构造，Electron 不读取代理环境变量。 */
export function createOutboundFetch(fallback?: () => typeof fetch): typeof fetch {
  let fallbackFetch: typeof fetch | undefined;
  return (input, init) => {
    if (process.versions.electron && process.type === 'utility') {
      if (isDirectUrl(input)) return globalThis.fetch(input, init);
      const { net } = nativeRequire('electron') as typeof import('electron');
      return net.fetch(input instanceof URL ? input.href : input, init);
    }
    return (fallback ? (fallbackFetch ??= fallback()) : globalThis.fetch)(input, init);
  };
}

export const outboundFetch = createOutboundFetch();
