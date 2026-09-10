/** renderer 源码守卫（.vue 不在 typecheck 覆盖内，照抄 renderer-settings-modal.test.ts 的纯文本守卫）：
 *  ProviderSettings「获取列表」按钮 + modelId datalist 下拉 + kind 补 gemini/ollama option，
 *  接线经 stores/chat.ts 的 fetchProviderModels → RPC provider.models.fetch。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const vue = fs.readFileSync(path.join(root, 'src/renderer/src/ui/settings/SecModels.vue'), 'utf8');
const chatStore = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');

describe('ProviderSettings 获取模型列表（renderer 源码守卫）', () => {
  it('ProviderSettings.vue：modelId 挂 datalist + 获取列表按钮走 provider.models.fetch + kind 四 option', () => {
    expect(vue).toMatch(/<datalist/);  // datalist 还在，id 换了名
    expect(vue).toMatch(/list="modelopts"/);
    expect(vue).toMatch(/<datalist id="modelopts"/);  // input 与 datalist 的 id 对得上才算接上
    expect(vue).toMatch(/@click="fetchModels"/);  // 按钮文案改了，锚「有一颗按钮会去拉列表」
    // RPC 名收进 store action（fetchProviderModels），组件只调 action——本文件例 3 钉那一层
    expect(vue).toMatch(/chat\.fetchProviderModels\(/);
    // 四种 kind 走 KINDS 常量表 v-for 渲染；锚「四种都在」，不锚 <option> 的写法（红线 9）
    for (const k of ['anthropic', 'openai-compat', 'gemini', 'ollama']) {
      expect(vue, `缺 ${k}`).toMatch(new RegExp(`v:\\s*'${k}'`));
    }
  });

  it('ProviderSettings.vue：失败静默回退手输——清空选项、仅 console.warn、不弹错误', () => {
    // 「取列表失败静默回落手输」的实现从 console.warn 改成吞掉错误不改状态——
    // 锚意图：失败时**不弹错、不拦住手动填写**
    expect(vue).toMatch(/catch\s*\{/);
    expect(vue).not.toMatch(/取不到模型列表[^']*throw/);
    expect(vue).toContain('modelOptions.value = []'); // 失败清空选项，手输回退是一等路径
  });

  it('stores/chat.ts：fetchProviderModels action 一行式 rpc.call', () => {
    expect(chatStore).toContain('fetchProviderModels');
    expect(chatStore).toContain('provider.models.fetch');
  });
});
