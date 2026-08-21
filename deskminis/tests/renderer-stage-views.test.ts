/**
 * T5 · 四个占位视图接入守卫（读 .vue 源码文本，与 renderer-* 先例一致）
 *
 * T 波换壳时 settings / cron / assistants / devices 四个视图留了一句
 * 「这个视图在下一步接入」的占位——**没有设置页就配不了 provider，应用等于不能用**。
 * 这条守卫钉死：占位文案不许再出现，每个视图必须指向真实组件。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(__dirname, '../src/renderer/src/ui/');
const read = (p: string): string => readFileSync(join(UI, p), 'utf8').replace(/\r\n/g, '\n');
const shell = read('AppShell.vue');

describe('T5 — 视图接入', () => {
  it('AppShell 不再有占位分支', () => {
    expect(shell).not.toContain('这个视图在下一步接入');
    expect(shell).not.toMatch(/class="todo"/);
  });

  it('五个视图各自挂到真实组件上', () => {
    for (const c of ['StageSettings', 'StageAssistants', 'StageCron', 'StageDevices', 'StageSearch']) {
      expect(existsSync(join(UI, `${c}.vue`))).toBe(true);
      expect(shell).toContain(`import ${c} from './${c}.vue'`);
      expect(shell).toContain(`<${c}`);
    }
  });
});

describe('T5 — 设置页覆盖面（少一节就有功能进不去）', () => {
  const s = read('StageSettings.vue');
  it('模型 / 权限 / 技能 / MCP / 搜索 / 外观 / 关于 七节都在', () => {
    for (const k of ['models', 'perm', 'skills', 'mcp', 'search', 'look', 'about']) {
      expect(s).toContain(`'${k}'`);
    }
  });
  it('provider 增删改与设默认全部接线（配不了模型 = 应用不能用）', () => {
    const m = read('settings/SecModels.vue');
    for (const fn of ['createProvider', 'updateProvider', 'deleteProvider', 'setDefaultProvider', 'fetchProviderModels']) {
      expect(m).toContain(fn);
    }
  });
  it('API Key 输入框是 password 型，且不回显已存密钥', () => {
    const m = read('settings/SecModels.vue');
    expect(m).toMatch(/type="password"/);
    // 后端 provider.instances.list 不回明文 key；界面上要说明「留空 = 不改」
    expect(m).toMatch(/留空/);
  });
});

describe('T5 — 定时 / 助手 / 设备 三视图接线', () => {
  it('定时视图能建、能删、能立即跑', () => {
    const c = read('StageCron.vue');
    for (const fn of ['createCronJob', 'deleteCronJob', 'runCronNow']) expect(c).toContain(fn);
  });
  it('助手视图能建、能改、能删', () => {
    const a = read('StageAssistants.vue');
    for (const fn of ['createAssistant', 'updateAssistant', 'deleteAssistant']) expect(a).toContain(fn);
  });
  it('设备视图能发起配对、能解绑，且配对码可见', () => {
    const d = read('StageDevices.vue');
    for (const fn of ['beginPairing', 'unpair']) expect(d).toContain(fn);
    expect(d).toMatch(/pairingSession/);
  });
});

describe('T5 — 更新状态文案必须对得上主进程的 status 值', () => {
  /** 第一版照 electron-updater 的**事件名**写了映射（'update-available' 等），
   *  实拍下来一条都对不上，界面直接漏出原始状态串。这条守卫钉住两边一致。 */
  it('main/index.ts 里出现的每个 status 值，SecAbout 都有中文文案', () => {
    const main = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8');
    const about = read('settings/SecAbout.vue');
    const statuses = [...main.matchAll(/updateState = \{\s*status:\s*'([a-z-]+)'/g)].map(m => m[1]);
    expect(statuses.length).toBeGreaterThan(4);
    for (const s of new Set(statuses)) expect(about).toContain(`${s}:`);
  });
});
