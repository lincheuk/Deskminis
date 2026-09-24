/**
 * 请求体黄金快照（止血波 W2a-0，侦察号 S0b）——先冻结，再改 provider。
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ 不得为了变绿而重新生成下面的 GOLDEN 表，也不得改动夹具（改夹具等于重新生成）。 │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 为什么有这张表：W2a-3（新一代 Claude 的 beta 头与 drop_block）和 W2a-4（DeepSeek V4 回放
 * reasoning_content）都要改 anthropic.ts / openai.ts 的请求构建。两步都只许动目标模型
 * （claude-fable-5-1 / claude-mythos-5-1 / claude-opus-5-5 三个精确 id，deepseek-v4 族），
 * 这里列的其它模型的请求体必须逐字节不变——多一个键、换一个键序，中转和上游就可能 400，
 * 而这种回归靠 toMatchObject 类断言看不出来。所以对 JSON.stringify(body) 取 sha256 逐项比较。
 *
 * 为什么不用 vitest 快照：`vitest -u` 会把 .snap 整体静默改写，改动淹没在大 diff 里没人看；
 * 硬编码 hex 要改只能逐行手改，改哪一项一目了然。
 *
 * 红了怎么办：先查实现，不是改表。确属有意改变某个模型的请求（例如 W4c 改思考档位映射），
 * 只手改受影响的那几项，并在提交正文「有意翻红」逐条写明 key、旧值、新值、为什么。
 * 失败信息里带着实际发出的 JSON，对着它找差异。
 *
 * 覆盖面：
 * - OpenAI 兼容：gpt-5、deepseek-chat、deepseek-reasoner、deepseek-v3.2、qwen3-max、kimi-k2、glm-4.6
 *   × 四种请求形态 × flags（缺省、{reasoningEffort:false}）；直接调 buildOpenAIBody，
 *   另经 OpenAIProvider 的 fetchImpl 捕获实际发出的 body 与请求头，与同一张表比对。
 * - Anthropic：claude-sonnet-4-5、claude-opus-5、m × 四种请求形态；直接调 buildAnthropicBody，
 *   另经 AnthropicProvider 在缺省官方 / 显式官方（带尾斜杠）/ 第三方三种 baseUrl 下捕获实际请求：
 *   body 与同一项相等（非目标模型的请求体与 baseUrl 无关），请求头里没有 anthropic-beta。
 * - 每种形态里的 assistant 历史都带 reasoningContent（AgentMessage 现在还没有这个字段，
 *   用 as AgentMessage 写进去）：证明非 v4 模型的请求体忽略它，W2a-4 之后也必须继续忽略。
 * - 刻意不含 deepseek-v4 族和上面三个目标 Claude 模型：它们正是要改的对象，各自另有专测。
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { OpenAIProvider, buildOpenAIBody, type OpenAICompatFlags } from '../src/minisd/providers/openai';
import { AnthropicProvider, buildAnthropicBody } from '../src/minisd/providers/anthropic';
import type { FetchLike, StreamRequest } from '../src/minisd/providers/types';
import type { AgentMessage, AgentToolDefinition } from '../src/shared/types';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ─── 夹具（冻结的一部分，不得改动）──────────────────────────────────────────

const SYSTEM = '你是 DeskMinis，一个 Windows 桌面助手。回答用中文。';

/** 三种工具定义：带枚举的内置工具、普通内置工具、带 rawInputSchema 的 MCP 工具（嵌套原样透传）。 */
const TOOLS: AgentToolDefinition[] = [
  {
    name: 'shell_execute', description: '在工作区执行命令',
    parameters: {
      command: { type: 'string', description: '要执行的命令' },
      shell: { type: 'string', description: '使用的 shell', enumValues: ['powershell', 'cmd'] },
      tool_title: { type: 'string', description: '一句话摘要' },
    },
    required: ['command', 'tool_title'],
  },
  {
    name: 'file_read', description: '读取文件',
    parameters: {
      path: { type: 'string', description: '文件路径' },
      offset: { type: 'integer', description: '起始行' },
      tool_title: { type: 'string', description: '一句话摘要' },
    },
    required: ['path', 'tool_title'],
  },
  {
    name: 'mcp__docs__search', description: '搜索文档',
    parameters: { tool_title: { type: 'string', description: '一句话摘要' } },
    required: ['tool_title'],
    rawInputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: '查询' }, opts: { type: 'object', properties: { deep: { type: 'boolean' } } } },
      required: ['q'],
    },
  },
];

/** 夹具里写进 assistant 历史的推理文本。任何一个出现在请求体里都说明字段被带出去了。 */
const REASONING_MARKS = ['R-TEXT-推理甲', 'R-TOOL-推理乙', 'R-IMAGE-推理丙', 'R-HIGH-推理丁'] as const;

interface Shape { id: 'text' | 'tool' | 'image' | 'thinkHigh'; label: string; req: StreamRequest }

const SHAPES: Shape[] = [
  {
    id: 'text', label: '纯文本',
    req: {
      systemPrompt: SYSTEM, tools: TOOLS, maxTokens: 8192, thinkingLevel: 'off',
      messages: [
        { role: 'user', parts: [{ type: 'text', value: '把这句话翻成英文：今天天气不错。' }] },
        { role: 'assistant', parts: [{ type: 'text', value: 'The weather is nice today.' }], reasoningContent: REASONING_MARKS[0] } as AgentMessage,
        { role: 'user', parts: [{ type: 'text', value: '再正式一点。' }] },
      ],
    },
  },
  {
    id: 'tool', label: '工具回合',
    req: {
      systemPrompt: SYSTEM, tools: TOOLS, maxTokens: 8192, thinkingLevel: 'off',
      messages: [
        { role: 'user', parts: [{ type: 'text', value: '看看 notes 目录里有什么，再读 a.md。' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'text', value: '我先列目录，再读文件。' },
            { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir notes","tool_title":"列目录"}', description: '列出 notes 目录' } },
            { type: 'toolUse', value: { toolUseId: 'T2', name: 'file_read', input: '{"path":"notes/a.md","tool_title":"读文件"}' } },
          ],
          reasoningContent: REASONING_MARKS[1],
        } as AgentMessage,
        {
          role: 'user',
          parts: [
            { type: 'toolResult', value: { toolUseId: 'T1', output: 'a.md\r\nb.md', success: true, status: 'success' } },
            { type: 'toolResult', value: { toolUseId: 'T2', output: '文件不存在：notes/a.md', success: false, status: 'failed' } },
          ],
        },
      ],
    },
  },
  {
    id: 'image', label: '带图',
    req: {
      systemPrompt: SYSTEM, tools: TOOLS, maxTokens: 8192, thinkingLevel: 'off',
      messages: [
        { role: 'user', parts: [{ type: 'text', value: '我要发一张报错截图给你。' }] },
        { role: 'assistant', parts: [{ type: 'text', value: '好的，请发。' }], reasoningContent: REASONING_MARKS[2] } as AgentMessage,
        {
          role: 'user',
          parts: [
            { type: 'text', value: '这张截图里报了什么错？' },
            { type: 'imageData', value: { mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==' } },
          ],
        },
      ],
    },
  },
  {
    id: 'thinkHigh', label: '思考 high',
    req: {
      systemPrompt: SYSTEM, tools: TOOLS, maxTokens: 8192, thinkingLevel: 'high',
      messages: [
        { role: 'user', parts: [{ type: 'text', value: '统计 notes 目录下的文件数。' }] },
        {
          role: 'assistant',
          parts: [
            // 带签名的思考块：Anthropic 走 enabled + budget_tokens 分支（不触发旧数据降级），OpenAI 兼容端点丢弃它
            { type: 'thinking', value: { text: '先列目录再数。', signature: 'sig-golden-1' } },
            { type: 'toolUse', value: { toolUseId: 'T9', name: 'shell_execute', input: '{"command":"dir /b notes","tool_title":"列目录"}' } },
          ],
          reasoningContent: REASONING_MARKS[3],
        } as AgentMessage,
        { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T9', output: 'a.md\r\nb.md\r\nc.md', success: true, status: 'success' } }] },
      ],
    },
  },
];

const OPENAI_MODELS = ['gpt-5', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2', 'qwen3-max', 'kimi-k2', 'glm-4.6'] as const;
const FLAG_SETS: { id: 'default' | 'noEffort'; label: string; flags: OpenAICompatFlags | undefined }[] = [
  { id: 'default', label: 'flags 缺省', flags: undefined },
  { id: 'noEffort', label: '{reasoningEffort:false}', flags: { reasoningEffort: false } },
];
const ANTHROPIC_MODELS = ['claude-sonnet-4-5', 'claude-opus-5', 'm'] as const;
const ANTHROPIC_BASES: { label: string; baseUrl: string | undefined; url: string }[] = [
  { label: '官方（缺省 baseUrl）', baseUrl: undefined, url: 'https://api.anthropic.com/v1/messages' },
  { label: '官方（显式，带尾斜杠）', baseUrl: 'https://api.anthropic.com/', url: 'https://api.anthropic.com/v1/messages' },
  { label: '第三方中转', baseUrl: 'https://relay.example.com', url: 'https://relay.example.com/v1/messages' },
];

const openaiKey = (model: string, shape: Shape['id'], flags: 'default' | 'noEffort') => `openai|${model}|${shape}|${flags}`;
const anthropicKey = (model: string, shape: Shape['id']) => `anthropic|${model}|${shape}`;

// ─── 黄金表（sha256(JSON.stringify(body))，W2a-0 时的实现冻结；不得重新生成）──────────
// thinkingLevel 为 off 的三种形态不发 reasoning_effort，两种 flags 的请求体本来就相同，同值是预期；
// 只有「思考 high」一行两种 flags 不同（缺省带 reasoning_effort:"high"，{reasoningEffort:false} 不带）。
// Anthropic 一项同时约束三种 baseUrl：非目标模型的请求体与端点无关。
// 夹具里的字符串都写在单行里（CRLF 用 \r\n 转义）：Windows 检出时即便换行符被转换，哈希也不变。
const GOLDEN: Record<string, string> = {
  'openai|gpt-5|text|default': '160b2823c92db8b8330187d978af2689324db0ff2a0722e7b3e34e2202638d70',
  'openai|gpt-5|text|noEffort': '160b2823c92db8b8330187d978af2689324db0ff2a0722e7b3e34e2202638d70',
  'openai|gpt-5|tool|default': 'db2f583a61e07001f071b396c3cef32c2aef9a0179a997f5c1617fb1769b6a6f',
  'openai|gpt-5|tool|noEffort': 'db2f583a61e07001f071b396c3cef32c2aef9a0179a997f5c1617fb1769b6a6f',
  'openai|gpt-5|image|default': 'a9f24835bbc6c913df0f38d6869c76b255c58d9772702894413cd2e2823f8dfc',
  'openai|gpt-5|image|noEffort': 'a9f24835bbc6c913df0f38d6869c76b255c58d9772702894413cd2e2823f8dfc',
  'openai|gpt-5|thinkHigh|default': '552f9d824e65c648defec07b62e735d734eb05d7252da29d748bd2a7aa6f28ba',
  'openai|gpt-5|thinkHigh|noEffort': 'dab34374db9e92c6d58123c392361f8ea64916b027a4ef1ba0dbdfa4b3138b99',

  'openai|deepseek-chat|text|default': '6c8219951041400dbc06c3b8f2cddda7f3d89f6e9eda91ab162bb8b20f50ffb1',
  'openai|deepseek-chat|text|noEffort': '6c8219951041400dbc06c3b8f2cddda7f3d89f6e9eda91ab162bb8b20f50ffb1',
  'openai|deepseek-chat|tool|default': '6a1442386934439e5dda26780cd0b58c6b6bc96bf7a6b6704396d587a75dc3c4',
  'openai|deepseek-chat|tool|noEffort': '6a1442386934439e5dda26780cd0b58c6b6bc96bf7a6b6704396d587a75dc3c4',
  'openai|deepseek-chat|image|default': 'ad57a89f68a7c313c865869188cc9c3ac33f79244a95136e2784c513b97c3563',
  'openai|deepseek-chat|image|noEffort': 'ad57a89f68a7c313c865869188cc9c3ac33f79244a95136e2784c513b97c3563',
  'openai|deepseek-chat|thinkHigh|default': 'a08d7d86020361f34a4478aecaed1ea88c79acc41d1c4fef3f0f55e97b586e82',
  'openai|deepseek-chat|thinkHigh|noEffort': 'd0af48430524eeeff3902084231e7193c4827ff9b9366e596bfce57852b832b0',

  'openai|deepseek-reasoner|text|default': 'f201c8cb038b2a9eca36714b81aefd41fb226f48a42710a5107f11824c7f72e7',
  'openai|deepseek-reasoner|text|noEffort': 'f201c8cb038b2a9eca36714b81aefd41fb226f48a42710a5107f11824c7f72e7',
  'openai|deepseek-reasoner|tool|default': '3db45e0d028f6b7837f200c798daa458f6ffcc2cf197e5e2f54bed57ec04640a',
  'openai|deepseek-reasoner|tool|noEffort': '3db45e0d028f6b7837f200c798daa458f6ffcc2cf197e5e2f54bed57ec04640a',
  'openai|deepseek-reasoner|image|default': '05be47c2f084040da29f28f71af64f0c5b27ccd334d81e6e648201449cbb82b1',
  'openai|deepseek-reasoner|image|noEffort': '05be47c2f084040da29f28f71af64f0c5b27ccd334d81e6e648201449cbb82b1',
  'openai|deepseek-reasoner|thinkHigh|default': '15358f75ee4809c1b85406d215ca1e699fb33f0c4bc3aa9c6a6098eb334a4b31',
  'openai|deepseek-reasoner|thinkHigh|noEffort': '3e522298a099539da67a0c91ec046fdc7f9285b33764b7fd363c0a33c4a66c0e',

  'openai|deepseek-v3.2|text|default': 'ac096109d9cbba322877b4ba3f88e1dcc2052e579c1a52217bcfb86f81f681c0',
  'openai|deepseek-v3.2|text|noEffort': 'ac096109d9cbba322877b4ba3f88e1dcc2052e579c1a52217bcfb86f81f681c0',
  'openai|deepseek-v3.2|tool|default': '6c8979208844ca3a66abb6eed316ef057f4de9e550342cf5e50015bf91c9a59b',
  'openai|deepseek-v3.2|tool|noEffort': '6c8979208844ca3a66abb6eed316ef057f4de9e550342cf5e50015bf91c9a59b',
  'openai|deepseek-v3.2|image|default': '9799d777a3f509b76090d306b05220a9b2ea05fd155b0a71d224ef79719b1266',
  'openai|deepseek-v3.2|image|noEffort': '9799d777a3f509b76090d306b05220a9b2ea05fd155b0a71d224ef79719b1266',
  'openai|deepseek-v3.2|thinkHigh|default': '313029be7ce14332e2b8cc25f16266a25f3c1ebcb3a8c6c12b68056cd078ec1d',
  'openai|deepseek-v3.2|thinkHigh|noEffort': 'eef02b3c6241a826afb6170b6244456bd4f6f0c2e99ea720b1f20015dc8db341',

  'openai|qwen3-max|text|default': '034a6a35ddad3e753fcbe39e75c3dea032d1a9129fbd96437162deb5c5b31ac5',
  'openai|qwen3-max|text|noEffort': '034a6a35ddad3e753fcbe39e75c3dea032d1a9129fbd96437162deb5c5b31ac5',
  'openai|qwen3-max|tool|default': '1327340f0fd7183ad88087e2991df7bc0cc1900b7929b825b45a628515825c8c',
  'openai|qwen3-max|tool|noEffort': '1327340f0fd7183ad88087e2991df7bc0cc1900b7929b825b45a628515825c8c',
  'openai|qwen3-max|image|default': '2716009ff46d0b4dd60a78cbc96083bb9aa51e420652a9ab301588a816a687cf',
  'openai|qwen3-max|image|noEffort': '2716009ff46d0b4dd60a78cbc96083bb9aa51e420652a9ab301588a816a687cf',
  'openai|qwen3-max|thinkHigh|default': 'b8e99f7b8f1ce8d4237af2f608f7f477b6067d10171762cf11d9aa5aae92b089',
  'openai|qwen3-max|thinkHigh|noEffort': '44fd28d7744d75b223b9d1422f4cf25f25918118d388222a59d854f6e1a61edf',

  'openai|kimi-k2|text|default': 'ea364673da3637aa3454f2c8e863247f0a1c086908bfa1c90561a41a78f4c33d',
  'openai|kimi-k2|text|noEffort': 'ea364673da3637aa3454f2c8e863247f0a1c086908bfa1c90561a41a78f4c33d',
  'openai|kimi-k2|tool|default': '5c6efc50db4822546e0906b3f4fff6c0637cfcea8225f83d173d8c2886a18397',
  'openai|kimi-k2|tool|noEffort': '5c6efc50db4822546e0906b3f4fff6c0637cfcea8225f83d173d8c2886a18397',
  'openai|kimi-k2|image|default': '6995b26f2768c6d8d2fec4468a67ff9ed275d4d0d5ab841e98976ba3b83f2749',
  'openai|kimi-k2|image|noEffort': '6995b26f2768c6d8d2fec4468a67ff9ed275d4d0d5ab841e98976ba3b83f2749',
  'openai|kimi-k2|thinkHigh|default': '305af395dd7eae5e2a7cd120319c5e34ee8c3918475179549108e2f3e67632fc',
  'openai|kimi-k2|thinkHigh|noEffort': '53c96c2ac1b4466fae794d0f65fdd8892d3e405f98ec7160d4a353665d382172',

  'openai|glm-4.6|text|default': '9dfca89c290c4ac8e098b63397679db0b2db3e677f508ceef6f0bbb23b2ff077',
  'openai|glm-4.6|text|noEffort': '9dfca89c290c4ac8e098b63397679db0b2db3e677f508ceef6f0bbb23b2ff077',
  'openai|glm-4.6|tool|default': 'bebb275299bf4681d68ba7fccae8829e6812725d06ce117a733925bdc3edc1c0',
  'openai|glm-4.6|tool|noEffort': 'bebb275299bf4681d68ba7fccae8829e6812725d06ce117a733925bdc3edc1c0',
  'openai|glm-4.6|image|default': '802ad22fc41d13722ffc7920d61e5eec18f3a529ff4dd7db0bf9657cff105b4c',
  'openai|glm-4.6|image|noEffort': '802ad22fc41d13722ffc7920d61e5eec18f3a529ff4dd7db0bf9657cff105b4c',
  'openai|glm-4.6|thinkHigh|default': 'cc7615db394bedc83b77b91791b35d995deddfaf658e4e527483e3e3ef67b0f6',
  'openai|glm-4.6|thinkHigh|noEffort': '1d49da7f466f36210f183384bf774526d3c6a886182f01883f54a0334e855bef',

  'anthropic|claude-sonnet-4-5|text': 'c823f97b76b4b7a4f2ded0b84afd81e2409ab131aaf28a654f498bc5edde5501',
  'anthropic|claude-sonnet-4-5|tool': '497e9fa8fbac2e83af360fd384343310f22c1177154e7efafba22d70242e2dc4',
  'anthropic|claude-sonnet-4-5|image': 'b2ec76036e1a2529df4dfc5ca94b53d2d3a761cd1283a5f33102423b0911865e',
  'anthropic|claude-sonnet-4-5|thinkHigh': 'ee02adf3f661de86a2f6790a70e869018bc3d22640a7708a25c16f5fc6f631bf',

  'anthropic|claude-opus-5|text': '4622b2093ea4c9419d66fa04be7b5aab98c6bb645c13ad9d8cffb2e55ef82090',
  'anthropic|claude-opus-5|tool': '607cf21423c4fe1764be419ffc41912d623797011bce90413e14e8a68248e004',
  'anthropic|claude-opus-5|image': '6fb87f441f77e2a41f50b58b3ac0d75f717958ed3de995c6be4658ac1b46fea3',
  'anthropic|claude-opus-5|thinkHigh': '7fbf1c6d9d13d6576dd2f0533d5107c7a3be1e21892d1d67e6a2847360c0af3f',

  'anthropic|m|text': '3870bb104520a8364bf7fcb048dd3aa473549befa114cc39160679fe8d71d050',
  'anthropic|m|tool': '33ce561dd961948fb18fb4a80e050aaf9df36d6b174a238d875a3b93bdc4b453',
  'anthropic|m|image': 'a3e35ad0737682b115a432c5125654aa04704dc00ac084d2b9aa09fac76afbc2',
  'anthropic|m|thinkHigh': '416186f7c529df0d967419d20e8f517633c077aa23432802332572eef4c8d35d',
};

// ─── 捕获实际发出的请求 ─────────────────────────────────────────────────────

interface Captured { url: string; headers: Record<string, string>; body: string }

/** fetchImpl 记下 url / 请求头 / body，回一段最小的合法 SSE 让 provider 正常收尾。
 *  请求头经 new Headers 归一化：实现改用 Headers 实例或换键名大小写也照样认得。 */
function capturingFetch(sse: string, out: Captured[]): FetchLike {
  return (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) for (const [k, v] of new Headers(init.headers as HeadersInit)) headers[k] = v;
    out.push({ url: String(input), headers, body: typeof init?.body === 'string' ? init.body : '' });
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as FetchLike;
}

const OPENAI_SSE = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) void _;
}

/** 请求体里不得出现 reasoningContent 的任何痕迹（键名或夹具里的推理文本）。 */
function expectNoReasoningLeak(json: string, where: string): void {
  expect(json, `${where}：出现了 reasoning_content`).not.toContain('reasoning_content');
  expect(json, `${where}：出现了 reasoningContent`).not.toContain('reasoningContent');
  for (const mark of REASONING_MARKS) expect(json, `${where}：推理文本「${mark}」被带进了请求体`).not.toContain(mark);
}

// ─── OpenAI 兼容 ───────────────────────────────────────────────────────────

describe('OpenAI 兼容：buildOpenAIBody 请求体逐字节冻结', () => {
  for (const model of OPENAI_MODELS) for (const shape of SHAPES) for (const f of FLAG_SETS) {
    const key = openaiKey(model, shape.id, f.id);
    it(`${model} · ${shape.label} · ${f.label}`, () => {
      const json = JSON.stringify(buildOpenAIBody(shape.req, model, f.flags));
      expectNoReasoningLeak(json, key);
      expect(sha256(json), `${key} 请求体变了，实际发出：${json}`).toBe(GOLDEN[key]);
    });
  }
});

describe('OpenAI 兼容：OpenAIProvider 实际发出的请求', () => {
  for (const model of OPENAI_MODELS) for (const f of FLAG_SETS) {
    it(`${model} · ${f.label}：body 与黄金表同项，请求头不变`, async () => {
      const calls: Captured[] = [];
      const p = new OpenAIProvider({ apiKey: 'k', modelId: model, baseUrl: 'https://relay.example.com/v1/', fetchImpl: capturingFetch(OPENAI_SSE, calls), compat: f.flags });
      for (const shape of SHAPES) await drain(p.streamAgentMessage(shape.req));
      expect(calls).toHaveLength(SHAPES.length);
      SHAPES.forEach((shape, i) => {
        const key = openaiKey(model, shape.id, f.id);
        expect.soft(calls[i].url).toBe('https://relay.example.com/v1/chat/completions');
        expect.soft(calls[i].headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer k' });
        expect.soft(sha256(calls[i].body), `${key} 实际发出：${calls[i].body}`).toBe(GOLDEN[key]);
      });
    });
  }
});

// ─── Anthropic ─────────────────────────────────────────────────────────────

describe('Anthropic 非目标模型：buildAnthropicBody 请求体逐字节冻结', () => {
  for (const model of ANTHROPIC_MODELS) for (const shape of SHAPES) {
    const key = anthropicKey(model, shape.id);
    it(`${model} · ${shape.label}`, () => {
      const json = JSON.stringify(buildAnthropicBody(shape.req, model));
      expectNoReasoningLeak(json, key);
      expect(json, `${key}：非目标模型不得带 block_binding`).not.toContain('block_binding');
      expect(sha256(json), `${key} 请求体变了，实际发出：${json}`).toBe(GOLDEN[key]);
    });
  }
});

describe('Anthropic 非目标模型：官方 / 第三方 baseUrl 实际发出的请求', () => {
  for (const model of ANTHROPIC_MODELS) for (const base of ANTHROPIC_BASES) {
    it(`${model} · ${base.label}：无 anthropic-beta 头，body 与黄金表同项`, async () => {
      const calls: Captured[] = [];
      const p = new AnthropicProvider({ apiKey: 'k', modelId: model, baseUrl: base.baseUrl, fetchImpl: capturingFetch(ANTHROPIC_SSE, calls) });
      for (const shape of SHAPES) await drain(p.streamAgentMessage(shape.req));
      expect(calls).toHaveLength(SHAPES.length);
      SHAPES.forEach((shape, i) => {
        const key = anthropicKey(model, shape.id);
        expect.soft(calls[i].url).toBe(base.url);
        expect.soft(Object.keys(calls[i].headers), `${key}：非目标模型不得带 anthropic-beta`).not.toContain('anthropic-beta');
        expect.soft(calls[i].headers).toEqual({ 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
        expect.soft(sha256(calls[i].body), `${key} 实际发出：${calls[i].body}`).toBe(GOLDEN[key]);
      });
    });
  }
});

// ─── 表与夹具自检 ───────────────────────────────────────────────────────────

describe('黄金表与夹具自检', () => {
  it('黄金表的键与矩阵一一对应：没有缺项，也没有无人比对的死项', () => {
    const expected = [
      ...OPENAI_MODELS.flatMap(m => SHAPES.flatMap(s => FLAG_SETS.map(f => openaiKey(m, s.id, f.id)))),
      ...ANTHROPIC_MODELS.flatMap(m => SHAPES.map(s => anthropicKey(m, s.id))),
    ].sort();
    expect(Object.keys(GOLDEN).sort()).toEqual(expected);
    for (const [k, v] of Object.entries(GOLDEN)) expect(v, k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('每种形态的 assistant 历史都真带 reasoningContent（否则「非 v4 忽略它」的证明是空的）', () => {
    const seen: string[] = [];
    for (const shape of SHAPES) {
      const assistants = shape.req.messages.filter(m => m.role === 'assistant');
      expect(assistants.length, shape.id).toBeGreaterThan(0);
      for (const m of assistants) {
        const rc = (m as AgentMessage & { reasoningContent?: unknown }).reasoningContent;
        expect(typeof rc, shape.id).toBe('string');
        seen.push(rc as string);
      }
    }
    expect(seen.sort()).toEqual([...REASONING_MARKS].sort());
  });

  it('矩阵里没有 deepseek-v4 族，也没有三个绑定控制目标模型（它们是 W2a-3 / W2a-4 要改的对象）', () => {
    for (const m of OPENAI_MODELS) expect(m).not.toMatch(/(?:^|\/)deepseek-v4(?:$|[^0-9])/i);
    for (const m of ANTHROPIC_MODELS) expect(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5']).not.toContain(m);
  });
});
