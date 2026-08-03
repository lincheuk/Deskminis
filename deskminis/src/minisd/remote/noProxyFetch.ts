import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici';

/**
 * M3 远程接入出流量专用 HTTP 客户端。
 *
 * 红线（设计 §3.4）：仅 M3 传输代码（relay 拨出、Tailscale 健康检查、对端连接）使用此模块。
 * providers 的 HTTPS 走全局 fetch（= undici 默认 Agent = 直连不走代理）。
 *
 * 这对优化线路中转站是正确且更快的选择——M4.5 实测（2026-08）：
 *   ai.nodetect.com 直连 80ms vs 走代理 466ms（直连快 5.8 倍）
 *   中转站是香港 CDN + 电信优化线路回国（tracert: 14.147.205.105 → 202.97.x → 23.147.52.x）
 * undici 默认不读 HTTP_PROXY 环境变量（与 Node http 模块不同），new Agent() 即 noProxy，
 * 全局 fetch 同理直连——provider 流量天然走直连，无需额外配置。
 *
 * 若用户改用境外直连端点（如直接 api.openai.com）需要代理，则需按 provider 的代理开关
 * （见 backlog，M4.5 非目标）——不能做成全局 dispatcher，否则会把中转站 80ms 变成 466ms。
 *
 * M3 出流量必须用 noProxyDispatcher（绕开系统代理）的安全理由：M3 链路是端到端加密的
 *   （relay 中继 + 对端直连），若被 SASE 全局代理截胡，加密会在代理处终止——
 *   「端到端加密」降级成「到代理终止」，违反 M3 安全模型。故 M3 出流量强制 noProxy，
 *   与 provider 直连是两套独立考量：provider 直连为速度（80ms），M3 noProxy 为安全。
 *
 * provider 路径禁止 import 此模块（有单测守卫：tests/remote-noProxyFetch.test.ts）——
 * noProxyDispatcher 是 M3 出流量专用，provider 走全局 fetch 直连即可。
 */
export const noProxyDispatcher = new Agent();

export async function noProxyFetch(url: string, init?: RequestInit): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: noProxyDispatcher });
}
