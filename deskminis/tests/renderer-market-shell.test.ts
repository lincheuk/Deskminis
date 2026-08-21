/**
 * V7 · 扩展市场在新壳里的落位 + **安全闸守卫**。
 *
 * 市场是唯一会把第三方代码装进本机的入口，安全规则不是装饰：
 * malicious 条目根本不给点、warn 必须勾确认、manualOnly 转禁用态、
 * env 声明里的 isSecret 走 password 输入。这条守卫钉死它们在重做后仍然成立。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(__dirname, '../src/renderer/src/ui/');
const read = (p: string): string => readFileSync(join(UI, p), 'utf8').replace(/\r\n/g, '\n');

describe('V7 — 市场落位', () => {
  it('作为舞台视图存在并接进外壳与导航', () => {
    expect(existsSync(join(UI, 'StageMarket.vue'))).toBe(true);
    const shell = read('AppShell.vue');
    expect(shell).toContain("import StageMarket from './StageMarket.vue'");
    expect(shell).toContain('<StageMarket');
    expect(read('NavRail.vue')).toContain("'market'");
  });
  it('搜索 / 分页 / 详情 / 已装比对 / 更新检查五条 RPC 都在', () => {
    const m = read('StageMarket.vue');
    for (const r of ['market.search', 'market.detail', 'market.installed', 'market.installPlan', 'market.install', 'market.sources.list', 'market.checkUpdates']) {
      expect(m).toContain(`'${r}'`);
    }
  });
  it('搜索防抖 + 竞态闸（迟到的旧页不得覆盖新查询）', () => {
    const m = read('StageMarket.vue');
    expect(m).toMatch(/setTimeout/);
    expect(m).toMatch(/seq !== searchSeq/);
  });
});

describe('V7 — 安全闸（一条都不许丢）', () => {
  const m = read('StageMarket.vue');
  it('malicious 根本不开确认卡', () => {
    expect(m).toMatch(/verdict === 'malicious'\)\s*return/);
  });
  it('warn 必须勾确认才能装', () => {
    expect(m).toContain('warnAck');
    expect(m).toMatch(/verdict !== 'warn' \|\| warnAck/);
  });
  it('manualOnly 不给装', () => expect(m).toContain('manualOnly'));
  it('必填 env 没填齐不给装；更新流排除已存值', () => {
    expect(m).toContain('envMissingNow');
    expect(m).toContain('envPrefilled');
  });
  it('isSecret 的 env 走 password 输入', () => {
    expect(m).toMatch(/isSecret \? 'password'/);
  });
  it('install 必须显式 confirm', () => {
    expect(m).toMatch(/confirm:\s*true/);
  });
});

describe('V7 — 空结果要说真原因', () => {
  it('源全都连不上时，空态说的是「连不上」而不是「换个词试试」', () => {
    const m = read('StageMarket.vue');
    expect(m).toContain('allUnreachable');
    expect(m).toMatch(/reachable !== 'ok'/);
    expect(m).toContain('连不上市场');
  });
});
