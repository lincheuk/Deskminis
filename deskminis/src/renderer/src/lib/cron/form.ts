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

/** 整张表单（W3-cronb）：调度三格之外，还有名称、指令、助手（空串 = 不指定）、工作目录（空串 = 默认）。 */
export interface CronFormFields extends CronFormValues {
  name: string;
  prompt: string;
  assistant: string;
  workspace: string;
}

/** 表单 → cron.create / cron.update 的参数（W3-cronb；W3-cron 独立审查）。
 *  助手与工作目录清空时交空串，不交 undefined：参数经 JSON 送到引擎，undefined 的键会被丢掉，
 *  而引擎 update 只写传来的字段——以前清空了点保存，旧的助手与目录原样留着，也不报错。
 *  引擎把空串存成 NULL（cron/store.ts 的 create 与 update 都是 trim() || null）。 */
export function cronInputOf(kind: CronFormKind, f: CronFormFields): {
  name: string; prompt: string; scheduleKind: CronFormKind; scheduleValue: string; assistantId: string; workspaceRoot: string;
} {
  return {
    name: f.name, prompt: f.prompt,
    scheduleKind: kind, scheduleValue: scheduleValueOf(kind, f),
    assistantId: f.assistant, workspaceRoot: f.workspace,
  };
}
