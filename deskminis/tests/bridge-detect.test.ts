import { describe, it, expect } from 'vitest';
import { detectBridgeTriggers } from '../src/minisd/bridge/detect';

describe('detectBridgeTriggers', () => {
  it('完整桥调用形态：& $env 两参形态与 node 形态都识别', () => {
    expect(detectBridgeTriggers('& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" windows-screenshot capture')).toEqual(['bridge-screenshot']);
    expect(detectBridgeTriggers('node "$env:MINIS_BRIDGE_CLI" windows-notify show --title x')).toEqual(['bridge-notify']);
  });

  it('裸 windows-<tool> action 形态：clipboard 读/写、device、open、speak', () => {
    expect(detectBridgeTriggers('windows-clipboard get')).toEqual(['bridge-clipboard-read']);
    expect(detectBridgeTriggers('windows-clipboard set --text x')).toEqual(['bridge-clipboard-write']);
    expect(detectBridgeTriggers('& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" windows-device info')).toEqual(['bridge-device']);
    expect(detectBridgeTriggers('windows-open open --target https://example.com')).toEqual(['bridge-open']);
    expect(detectBridgeTriggers('windows-speak say --text 你好')).toEqual(['bridge-speak']);
  });

  it('一条命令两段桥调用（; 连接）→ 两 kind 都出，按出现顺序', () => {
    expect(detectBridgeTriggers('windows-clipboard get; windows-screenshot capture')).toEqual(['bridge-clipboard-read', 'bridge-screenshot']);
  });

  it('同 kind 重复出现只报一次（去重保序）', () => {
    expect(detectBridgeTriggers('windows-clipboard get; windows-clipboard get')).toEqual(['bridge-clipboard-read']);
  });

  it('非桥命令 → 空数组', () => {
    expect(detectBridgeTriggers('Get-ChildItem')).toEqual([]);
    expect(detectBridgeTriggers('')).toEqual([]);
  });

  it('无 action 段或未知 action → 空数组', () => {
    expect(detectBridgeTriggers('node "$env:MINIS_BRIDGE_CLI"')).toEqual([]);
    expect(detectBridgeTriggers('& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" windows-notify')).toEqual([]);
    expect(detectBridgeTriggers('windows-notify frobnicate')).toEqual([]);
    expect(detectBridgeTriggers('windows-notify --help')).toEqual([]);
  });

  it('大小写不敏感', () => {
    expect(detectBridgeTriggers('WINDOWS-CLIPBOARD GET')).toEqual(['bridge-clipboard-read']);
    expect(detectBridgeTriggers('Windows-Notify Show --Title x')).toEqual(['bridge-notify']);
  });
});
