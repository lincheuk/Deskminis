import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici';

/**
 * M3 远程接入出流量专用 HTTP 客户端。
 *
 * 红线（设计 §3.4）：仅 M3 传输代码（relay 拨出、Tailscale 健康检查、对端连接）使用此模块。
 * providers 的 HTTPS 必须继续走全局 fetch（尊重系统代理——否则国内用户没代理打不到 OpenAI）。
 * provider 路径禁止 import 此模块（有单测守卫：tests/remote-noProxyFetch.test.ts）。
 *
 * undici 默认不读 HTTP_PROXY 环境变量（与 Node http 模块不同），new Agent() 即 noProxy。
 * 这确保 M3 的对端/中继连接绕开用户系统代理，避免 SASE 全局代理把
 * 「端到端加密」截胡成「到代理终止」。
 */
export const noProxyDispatcher = new Agent();

export async function noProxyFetch(url: string, init?: RequestInit): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: noProxyDispatcher });
}
