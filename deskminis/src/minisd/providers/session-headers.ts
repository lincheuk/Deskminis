import type { RequestSession } from './types';

/** N23：目录解析结果（含手动指定）或官方Go地址任一命中即可。 */
export function isOpenCodeGo(baseUrl: string, catalogProviderId?: string): boolean {
  if (catalogProviderId === 'opencode-go') return true;
  try {
    const url = new URL(baseUrl);
    return url.hostname === 'opencode.ai'
      && (url.pathname.startsWith('/zen/go/') || url.pathname.startsWith('/inference/go/'));
  } catch { return false; }
}

/** 只影响传输头，不进入模型请求正文；无会话的请求不声明会话或客户端身份。 */
export function sessionHeaders(baseUrl: string, session?: RequestSession): Record<string, string> {
  if (!session?.id || !isOpenCodeGo(baseUrl, session.catalogProviderId)) return {};
  const version = process.env.DESKMINIS_APP_VERSION?.trim();
  return {
    'x-opencode-session': session.id,
    'User-Agent': version ? `DeskMinis/${version}` : 'DeskMinis',
  };
}
