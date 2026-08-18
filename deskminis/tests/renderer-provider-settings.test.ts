/** renderer 源码守卫（.vue 不在 typecheck 覆盖内，照抄 renderer-settings-modal.test.ts 的纯文本守卫）：
 *  ProviderSettings「获取列表」按钮 + modelId datalist 下拉 + kind 补 gemini/ollama option，
 *  接线经 stores/chat.ts 的 fetchProviderModels → RPC provider.models.fetch。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const vue = fs.readFileSync(path.join(root, 'src/renderer/src/components/ProviderSettings.vue'), 'utf8');
const chatStore = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');

describe('ProviderSettings 获取模型列表（renderer 源码守卫）', () => {
  it('ProviderSettings.vue：modelId 挂 datalist + 获取列表按钮走 provider.models.fetch + kind 四 option', () => {
    expect(vue).toContain('<datalist id="model-id-list">');
    expect(vue).toContain('list="model-id-list"');
    expect(vue).toContain('获取列表');
    expect(vue).toContain('provider.models.fetch');
    expect(vue).toContain('<option value="anthropic">');
    expect(vue).toContain('<option value="openai-compat">');
    expect(vue).toContain('<option value="gemini">');
    expect(vue).toContain('<option value="ollama">');
  });

  it('ProviderSettings.vue：失败静默回退手输——清空选项、仅 console.warn、不弹错误', () => {
    expect(vue).toContain('console.warn');
    expect(vue).toContain('modelOptions.value = []'); // 失败清空选项，手输回退是一等路径
  });

  it('stores/chat.ts：fetchProviderModels action 一行式 rpc.call', () => {
    expect(chatStore).toContain('fetchProviderModels');
    expect(chatStore).toContain('provider.models.fetch');
  });
});
