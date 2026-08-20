/** K2 守卫：定时任务前端——人话调度描述纯模块 + 面板/店面接线源文本断言
 *  （设计稿 2026-08-20-cron-design.md §5）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { describeSchedule } from '../src/renderer/src/lib/cron/describe';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

describe('describeSchedule（人话描述，描述不了就给原表达式不硬编）', () => {
  it('interval：分钟与整小时两档', () => {
    expect(describeSchedule('interval', '30')).toBe('每 30 分钟');
    expect(describeSchedule('interval', '120')).toBe('每 2 小时');
  });
  it('once：本地时刻一次', () => {
    const sec = Math.floor(new Date(2026, 11, 31, 9, 5).getTime() / 1000);
    expect(describeSchedule('once', String(sec))).toBe('2026-12-31 09:05 一次');
  });
  it('cron 常见形：每天/每周X/工作日/每 n 分钟/整点', () => {
    expect(describeSchedule('cron', '0 9 * * *')).toBe('每天 09:00');
    expect(describeSchedule('cron', '30 18 * * 5')).toBe('每周五 18:30');
    expect(describeSchedule('cron', '0 9 * * 1-5')).toBe('工作日 09:00');
    expect(describeSchedule('cron', '*/15 * * * *')).toBe('每 15 分钟');
    expect(describeSchedule('cron', '5 * * * *')).toBe('每小时的第 5 分');
  });
  it('描述不了的形态回落原表达式；坏表达式也回落原文（描述器不抛）', () => {
    expect(describeSchedule('cron', '0 9 1,15 * *')).toBe('cron: 0 9 1,15 * *');
    expect(describeSchedule('cron', 'not a cron')).toBe('cron: not a cron');
  });
});

describe('K2 接线守卫', () => {
  it('store：cronJobs 状态 + 刷新/CRUD/runNow + cron.changed 订阅', () => {
    const s = read('src/renderer/src/stores/chat.ts');
    expect(s).toContain('cronJobs: [] as UiCronJob[]');
    expect(s).toContain("await rpc.call('cron.list')");
    expect(s).toContain("rpc.on('cron.changed'");
    expect(s).toMatch(/cron\.delete',\s*\{\s*id[^}]*confirm:\s*true/);
    expect(s).toContain("'cron.runNow'");
  });

  it('App：工作台「定时」tab（market 全局 tab 成例：懒挂载 + 不随会话重置）', () => {
    const app = read('src/renderer/src/App.vue');
    expect(app).toMatch(/\{ id: 'cron', label: '定时', panel: 'cron', closable: false/);
    expect(app).toContain("<div v-show=\"rightTab === 'cron'\" class=\"rfill\"><CronPanel v-if=\"visited.cron\" /></div>");
    expect(app).toMatch(/visited = reactive\(\{[^}]*cron: false/);
  });

  it('CronPanel：CRUD/立即运行/启停接线 + 删除二次确认 + 运行边界与权限文案', () => {
    const p = read('src/renderer/src/components/CronPanel.vue');
    expect(p).toContain('createCronJob');
    expect(p).toContain('updateCronJob');
    expect(p).toContain('deleteCronJob');
    expect(p).toContain('runCronNow');
    expect(p).toContain('confirmDelete');
    expect(p).toContain('describeSchedule');
    // §0 两条裁定的用户可见面：不假装 24/7；无人值守权限语义说清
    expect(p).toContain('应用运行时');
    expect(p).toMatch(/90\s*秒.*自动拒绝/);
    // 最近会话跳转（chat.open）
    expect(p).toContain('chat.open(');
  });
});
