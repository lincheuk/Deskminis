/** renderer 源码守卫（.vue 不在 typecheck 覆盖内，照抄 renderer-provider-settings.test.ts 的纯文本守卫）：
 *  ProviderSettings「网络搜索」分区：kind 下拉（未配置/brave/tavily/searxng）+ 密钥 password 输入不回填
 *  + searxng baseUrl 输入与 JSON 格式提示；接线经 stores/chat.ts → RPC search.provider.get/set。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const vue = fs.readFileSync(path.join(root, 'src/renderer/src/components/ProviderSettings.vue'), 'utf8');
const chatStore = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');
const permCopy = fs.readFileSync(path.join(root, 'src/renderer/src/lib/perm/copy.ts'), 'utf8');

describe('ProviderSettings 网络搜索分区（renderer 源码守卫）', () => {
  it('分区标题「网络搜索」+ kind 四 option（未配置/brave/tavily/searxng）', () => {
    expect(vue).toContain('网络搜索');
    expect(vue).toContain('<option value="none">未配置</option>');
    expect(vue).toContain('<option value="brave">');
    expect(vue).toContain('<option value="tavily">');
    expect(vue).toContain('<option value="searxng">');
  });

  it('brave/tavily 分支：apiKey 用 password 输入且不回填（已配置态提示留空保持不变）', () => {
    // 密钥输入必须 type="password" 且绑定的是搜索分区专用状态，加载时只置空不回显
    expect(vue).toContain('v-model="searchApiKey"');
    expect(vue).toContain('type="password"');
    expect(vue).toContain('searchApiKey.value = \'\''); // 加载/保存后清空——密钥永不回填
    expect(vue).toContain('留空 = 保持不变'); // 已配置态的占位提示（锚点：不回显旧密钥）
  });

  it('searxng 分支：baseUrl 输入 + 「实例需开启 JSON 输出格式」提示', () => {
    expect(vue).toContain('v-model="searchBaseUrl"');
    expect(vue).toContain('实例需开启 JSON 输出格式');
  });

  it('stores/chat.ts：fetchSearchProvider/saveSearchProvider 走 search.provider.get/set', () => {
    expect(chatStore).toContain('search.provider.get');
    expect(chatStore).toContain('search.provider.set');
  });

  it('权限卡文案：web-search 类目有中文标题', () => {
    expect(permCopy).toContain(`'web-search': '请求网络搜索'`);
  });
});
