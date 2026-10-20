import { describe, expect, it } from 'vitest';
import { humanizeError } from '../src/renderer/src/lib/eventnote/copy';
describe('N23 Chromium网络错误短句', () => {
  it.each(['ERR_PROXY_CONNECTION_FAILED','ERR_TUNNEL_CONNECTION_FAILED','ERR_PROXY_AUTH_UNSUPPORTED','ERR_NO_SUPPORTED_PROXIES','ERR_MANDATORY_PROXY_CONFIGURATION_FAILED'])('%s代理提示', code => expect(humanizeError('网络错误: Error: net::'+code)).toBe('代理连接失败：检查系统代理是否在运行'));
  it.each(['ERR_CONNECTION_REFUSED','ERR_CONNECTION_RESET','ERR_CONNECTION_CLOSED','ERR_CONNECTION_TIMED_OUT','ERR_NAME_NOT_RESOLVED','ERR_INTERNET_DISCONNECTED','ERR_TIMED_OUT','ERR_NETWORK_CHANGED','ERR_ADDRESS_UNREACHABLE','ERR_EMPTY_RESPONSE','ERR_SOCKET_NOT_CONNECTED'])('%s网络提示', code => expect(humanizeError('网络错误: Error: net::'+code)).toBe('网络连接失败'));
  it.each([['fetch failed','网络连接失败'],['ENOTFOUND example.com','网络连接失败'],['403 RegionError','该模型在当前网络所在地区不可用（403）：检查系统代理'],['403 balance insufficient','余额不足或额度受限（403）'],['401 invalid key','API Key 无效或过期'],['net::ERR_CERT_AUTHORITY_INVALID','net::ERR_CERT_AUTHORITY_INVALID']])('%s保留原分类', (raw,expected) => expect(humanizeError(raw)).toBe(expected));
});
