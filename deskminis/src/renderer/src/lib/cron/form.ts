/** 定时任务表单 → 调度值（W3-cron；0.3.0 真机验证报告 §3.1）。纯函数，不碰 Vue，单测直接跑（tests/cron-form.test.ts）。
 *
 *  间隔框是 <input v-model type="number">：Vue 3 的 v-model 遇到 type="number" 会把输入转成数字
 *  （@vue/runtime-dom 的 vModelText：castToNumber = number 修饰符 || type === 'number'），清空时又交回空串；
 *  初值与编辑时回填的是字符串。所以间隔可能是数字也可能是字符串——以前直接 .trim()，用户一改间隔就抛 TypeError，
 *  「创建 / 保存」毫无反应。合法与否交给引擎（cron/schedule.ts 的 validateSchedule，报错是中文），这里只负责转成字符串。 */
export type CronFormKind = 'interval' | 'once' | 'cron';

export interface CronFormValues {
  /** 分钟数：数字（v-model 转过的）或字符串（初值、回填、清空后的空串） */
  interval: string | number;
  /** 5 段 cron 表达式 */
  cron: string;
  /** datetime-local 的值（本地墙钟）；没填是空串 */
  once: string;
}

/** 表单 → 调度值字符串：interval=分钟数、cron=表达式、once=epoch 秒（没填或不合法交 'NaN'，由引擎拒绝）。 */
export function scheduleValueOf(kind: CronFormKind, form: CronFormValues): string {
  if (kind === 'interval') return String(form.interval).trim();
  if (kind === 'cron') return form.cron.trim();
  const ms = form.once ? new Date(form.once).getTime() : NaN;
  return String(Math.floor(ms / 1000));
}
