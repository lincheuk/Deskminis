/** W3-cron（设计稿 §4.1；0.3.0 真机验证报告 §3.1）：定时任务改了间隔后「创建 / 保存」没反应、没有任何提示。
 *
 *  真机上的复现：新建任务把间隔从 30 改成 5 点「创建」没反应；不改间隔能建成；编辑已有任务改间隔点「保存」同样没反应。
 *  原因：间隔框是 <input v-model="fInterval" type="number">，Vue 3 的 v-model 遇到 type="number" 会把输入转成数字
 *  （@vue/runtime-dom 的 vModelText：castToNumber = number 修饰符 || type === 'number'）；fInterval 初值是字符串 '30'，
 *  用户一改就成了数字 5，StageCron 里的 fInterval.value.trim() 对数字抛 TypeError。这一句在 save() 构造参数时执行、
 *  在 try 之外，于是成了没人接的 Promise 拒绝——页面上的错误行不出现，渲染层也没有全局兜底，用户只觉得按钮坏了。
 *
 *  ① 纯函数 scheduleValueOf（src/renderer/src/lib/cron/form.ts）：间隔可能是数字、也可能是字符串（初值、编辑时回填、清空后），都要认；
 *  ② 源码守卫（.vue 不在 typecheck 覆盖范围内，按 SFC 解析器切出脚本段、剥掉注释再认）：
 *     save() 在 try 里才构造参数，出任何错都落到错误行；不再对 fInterval.value 直接调字符串方法；
 *     删除也兜住（同一页、同一类「操作没成功却没提示」）；间隔框的 min 与引擎的下限（5 分钟）一致。
 *  ③ W3-cronb（W3-cron 独立审查）：编辑时把助手、工作目录清空再保存，以前交的是 undefined，JSON 丢掉这个键，
 *     引擎 update 只写传来的字段，旧的助手与目录原样留着、也不报错——同一类「点了保存却没存上」。表单参数改由纯函数 cronInputOf 构造，
 *     清空交空串（引擎存成 NULL）；间隔加上限（525600 分钟，一年），输入框的 max 与引擎一致——以前填个天文数字能存，
 *     列表显示「下次 NaN-NaN」、永远不跑。
 *  时区钉在东八区（W3-cronb）：「只跑一次」按本地墙钟换 epoch 秒，断言写死的值；CI 跑在 UTC，不钉的话实现误按 UTC 解析也照样全绿。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cronInputOf, scheduleValueOf, type CronFormFields } from '../src/renderer/src/lib/cron/form';
import { sfcBlocks } from './sfc-blocks';

const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

// Node 运行中改 TZ 立即生效（同 tests/daily-log.test.ts）；构造 Date 的地方都在用例里，晚于这里
let savedTz: string | undefined;
beforeAll(() => { savedTz = process.env.TZ; process.env.TZ = 'Asia/Shanghai'; });
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

describe('① scheduleValueOf · 表单 → 调度值', () => {
  const base = { interval: '30' as string | number, cron: '0 9 * * *', once: '' };

  it('间隔是数字（type="number" 的 v-model 改过之后就是数字）：转成字符串，不抛', () => {
    expect(scheduleValueOf('interval', { ...base, interval: 5 })).toBe('5');
    expect(scheduleValueOf('interval', { ...base, interval: 120 })).toBe('120');
  });

  it('间隔是字符串（初值、编辑时回填的都是字符串）：去掉首尾空白', () => {
    expect(scheduleValueOf('interval', { ...base, interval: '30' })).toBe('30');
    expect(scheduleValueOf('interval', { ...base, interval: ' 45 ' })).toBe('45');
  });

  it('间隔清空（v-model 交回空串）：交空串，由引擎按「间隔最短 5 分钟」拒绝并说明', () => {
    expect(scheduleValueOf('interval', { ...base, interval: '' })).toBe('');
  });

  it('cron：去掉首尾空白', () => {
    expect(scheduleValueOf('cron', { ...base, cron: '  */5 * * * *  ' })).toBe('*/5 * * * *');
  });

  it('只跑一次：本地墙钟（datetime-local 的值）→ epoch 秒；没填交 NaN，由引擎拒绝', () => {
    // 东八区 2026-10-01 09:30 = UTC 01:30（按 UTC 解析会差 8 小时：1790847000）
    expect(scheduleValueOf('once', { ...base, once: '2026-10-01T09:30' })).toBe('1790818200');
    expect(scheduleValueOf('once', { ...base, once: '' })).toBe('NaN');
  });
});

describe('③ cronInputOf · 表单 → cron.create / cron.update 的参数', () => {
  const form = (over: Partial<CronFormFields> = {}): CronFormFields => ({
    name: '巡检', prompt: '检查工作区', interval: 30, cron: '0 9 * * *', once: '', assistant: 'A1', workspace: 'C:\\ws', ...over,
  });

  it('名称、指令、调度照交；调度值经 scheduleValueOf（间隔是数字也认）', () => {
    expect(cronInputOf('interval', form())).toEqual({
      name: '巡检', prompt: '检查工作区', scheduleKind: 'interval', scheduleValue: '30', assistantId: 'A1', workspaceRoot: 'C:\\ws',
    });
    expect(cronInputOf('cron', form({ cron: ' 0 9 * * 1 ' })).scheduleValue).toBe('0 9 * * 1');
  });

  it('助手选「不指定」、工作目录清空：交空串，不交 undefined——经 JSON 送到引擎之后键还在（引擎按空串清掉）', () => {
    const input = cronInputOf('interval', form({ assistant: '', workspace: '' }));
    expect(input.assistantId).toBe('');
    expect(input.workspaceRoot).toBe('');
    const wire = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    expect(wire).toHaveProperty('assistantId', '');
    expect(wire).toHaveProperty('workspaceRoot', '');
  });
});

describe('② StageCron.vue · 保存与删除出错都要落到错误行', () => {
  const { script, template } = sfcBlocks(read('src/renderer/src/ui/StageCron.vue'), 'StageCron.vue');
  /** 从 name 函数的签名起，到第一个顶格的右花括号为止 */
  const fn = (name: string): string => {
    const at = script.search(new RegExp(`(?:async )?function ${name}\\(`));
    if (at < 0) return '';
    const end = script.indexOf('\n}', at);
    return end < 0 ? '' : script.slice(at, end + 2);
  };

  it('save()：参数在 try 里才构造（cronInputOf 在 try 之后），任何异常都进 catch', () => {
    const body = fn('save');
    expect(body, '找不到 function save(').not.toBe('');
    const iTry = body.search(/\btry\s*\{/);
    const iBuild = body.search(/cronInputOf\(/);
    expect(iTry, 'save() 里没有 try').toBeGreaterThan(-1);
    expect(iBuild, 'save() 没有经 cronInputOf 构造参数（清空的助手与目录要交空串）').toBeGreaterThan(iTry);
    expect(body, 'save() 里不再自己拼 assistantId / workspaceRoot').not.toMatch(/assistantId\s*:/);
    expect(body).toMatch(/catch\s*\(\s*e\s*\)\s*\{\s*err\.value\s*=/);
  });

  it('不再对 fInterval.value 直接调字符串方法（type="number" 改过之后它是数字）', () => {
    expect(script).not.toMatch(/fInterval\.value\s*\??\.\s*(?:trim|toLowerCase|split|replace)\(/);
    expect(script).not.toMatch(/\(\s*fInterval\.value\s+as\s+string\s*\)\s*\??\.\s*(?:trim|toLowerCase|split|replace)\(/);
  });

  it('onDelete()：删除失败也落到错误行（以前没有 try，失败时同样毫无提示）', () => {
    const body = fn('onDelete');
    expect(body, '找不到 function onDelete(').not.toBe('');
    expect(body).toMatch(/\btry\s*\{[\s\S]*deleteCronJob\(/);
    expect(body).toMatch(/catch\s*\(\s*e\s*\)\s*\{\s*err\.value\s*=/);
  });

  it('间隔框的 min 与引擎的下限一致（5 分钟）：浏览器自带的校验先拦，提示框就地告诉用户', () => {
    const minimum = /if \(n < (\d+)\) throw new Error\('间隔最短/.exec(read('src/minisd/cron/schedule.ts'))?.[1];
    expect(minimum, 'schedule.ts 里找不到间隔下限').toBeTruthy();
    expect(template).toMatch(new RegExp(`<input v-model="fInterval"[^>]*type="number"[^>]*min="${minimum}"`));
  });

  it('间隔框的 max 与引擎的上限一致（W3-cronb）：天文数字先被浏览器拦下，提示里也写着上限', () => {
    const maximum = /if \(n > (\w+)\) throw new Error\(`?'?间隔最长/.exec(read('src/minisd/cron/schedule.ts'))?.[1];
    expect(maximum, 'schedule.ts 里找不到间隔上限').toBeTruthy();
    const value = /^\d+$/.test(maximum!) ? maximum! : new RegExp(`const ${maximum} = ([\\d_]+);`).exec(read('src/minisd/cron/schedule.ts'))?.[1]?.replace(/_/g, '');
    expect(value, `schedule.ts 里找不到 ${maximum} 的值`).toBeTruthy();
    expect(template).toMatch(new RegExp(`<input v-model="fInterval"[^>]*type="number"[^>]*max="${value}"`));
    expect(template).toMatch(/最长/);
  });
});
