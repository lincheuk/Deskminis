/** renderer 源码守卫（.vue 不在 typecheck 覆盖内，照抄 renderer-provider-settings.test.ts 的纯文本守卫）：
 *  ProviderSettings「网络搜索」分区：kind 下拉（未配置/brave/tavily/searxng）+ 密钥 password 输入不回填
 *  + searxng baseUrl 输入与 JSON 格式提示；接线经 stores/chat.ts → RPC search.provider.get/set。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
// T6e-3 重指：网络搜索分区从旧 ProviderSettings 独立成了 ui/settings/SecSearch.vue
const vue = fs.readFileSync(path.join(root, 'src/renderer/src/ui/settings/SecSearch.vue'), 'utf8');
const chatStore = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');
const permCopy = fs.readFileSync(path.join(root, 'src/renderer/src/lib/perm/copy.ts'), 'utf8');

describe('SecSearch 网络搜索分区（renderer 源码守卫）', () => {
  it('分区标题「网络搜索」+ kind 四 option（未配置/brave/tavily/searxng）', () => {
    expect(vue).toContain('网络搜索');
    // 锚**四种取值都在**，不锚 option 的写法：新页面用 v-for 渲 KINDS 常量表，
    // 逐条写死 <option value="brave"> 那种断言锚的是实现不是意图（红线 9）。
    for (const k of ['none', 'tavily', 'brave', 'searxng']) {
      expect(vue, `缺 ${k}`).toMatch(new RegExp(`v:\\s*'${k}'`));
    }
  });

  it('brave/tavily 分支：apiKey 用 password 输入且不回填（已配置态提示留空保持不变）', () => {
    // 密钥输入必须 type="password" 且绑定的是搜索分区专用状态，加载时只置空不回显
    expect(vue).toMatch(/v-model="apiKey"/);
    expect(vue).toContain('type="password"');
    // 密钥永不回填：sync() 只置空不回显（后端也只回 hasKey 布尔）
    expect(vue).toMatch(/apiKey\.value = ''/);
    expect(vue).toMatch(/留空 = 保持原密钥/); // 已配置态的占位提示
  });

  it('searxng 分支：baseUrl 输入 + 「实例需开启 JSON 输出格式」提示', () => {
    expect(vue).toMatch(/v-model="baseUrl"/);
    // 这句不是装饰：SearXNG 默认不开 JSON 输出，不开就只回 HTML、搜索静默失败
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
