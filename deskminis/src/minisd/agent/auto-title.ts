import type { StreamRequest } from '../providers/types';

/** 送给命名请求的首条用户文本上限。取名只看得懂「这人要干什么」，
 *  用户粘一整篇需求文档进来时，后面几千字对标题毫无贡献，纯烧 token 和延迟。 */
const INPUT_LIMIT = 500;

/** 落库标题的硬上限。提示词里要的是 12 字，但模型不守约定是常态；
 *  左栏单行卡只有 212px 宽，没有这道闸一句话标题会把整行撑变形。 */
const TITLE_LIMIT = 20;

/** 模型爱把标题裹起来的各式引号——中英文成对符号一律剥掉。
 *  全局删而不是只删首尾：出现过「重构"登录"模块」这种半裹形态，只削首尾会留下孤引号。 */
const QUOTES = /["'“”‘’「」『』]/g;

/**
 * 组一次「给这轮对话取标题」的请求（纯函数，便于单测）。
 * 刻意不带历史、不带工具：命名只依据用户第一句话，带上历史等于把整个会话再发一遍。
 */
export function buildTitleRequest(userText: string): StreamRequest {
  return {
    messages: [{ role: 'user', parts: [{ type: 'text', value: userText.slice(0, INPUT_LIMIT) }] }],
    systemPrompt: '你是标题生成器。用不超过 12 个字概括用户任务，只输出标题本身，不要引号与句号',
    tools: [],
    maxTokens: 64,
    thinkingLevel: 'off',
  };
}

/**
 * 把模型吐的那串东西收拾成能进标题栏的文本；收拾不出像样的就返回 undefined
 * （调用方据此放弃改名、保留「新会话」——宁可不改，也不要把「好的，标题是：」写进左栏）。
 */
export function cleanTitle(raw: string): string | undefined {
  // 换行折成空格而不是直接删：模型偶尔回两行，删掉换行会把上下两行的词黏成一个怪词
  let t = raw.replace(/\s+/g, ' ').replace(QUOTES, '').trim();
  // 句号只削尾部：正文里的点是内容（v1.2、config.json），一并删掉会毁掉标题本身
  t = t.replace(/[。.]+$/, '').trim();
  if (!t) return undefined;
  return t.length > TITLE_LIMIT ? t.slice(0, TITLE_LIMIT) : t;
}
