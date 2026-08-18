// 按模型族操作纪律块（M4 Task 3）：按 modelId 正则分派不同纪律块，防止模型声称完成却不调工具。
// 降级切换 provider 后，systemPrompt 工厂轮内用新 modelId 调本函数 → stable 缓存 miss 重建（Task 2 已保证）。

// 国产模型族（qwen/deepseek/glm/kimi 等）多走 OpenAI 兼容端点，行为短板同属一家：
// 同样会「声称完成却不调工具」，并入 OPENAI_FAMILY 共用同一份通用纪律块——
// 措辞分族并无收益，只会让最常用的模型拿不到任何纪律约束。
const OPENAI_FAMILY = /^(gpt-|codex-|grok-|o\d|qwen|deepseek|glm|kimi|minimax|doubao|hunyuan|ernie|moonshot)/i;
const GOOGLE_FAMILY = /^(gemini-|gemma)/i;
const ANTHROPIC_FAMILY = /^claude-/i;

// tool_title 中文句三族同文：国际模型冒烟观察到英文 title，参数 description 措辞对模型约束力弱，
// 纪律块必须正面点名；不在各族块里改写措辞——同文便于全局搜索与同步维护。
const OPENAI_DISCIPLINE = `操作纪律：当任务需要读写文件或执行命令时，必须调用对应工具完成，不要只描述计划或声称已完成却未调用工具。若现成工具可用则直接用，不要建议用户绕路手动操作。调用工具时 tool_title 参数一律用 5-10 字中文短语概括本次操作。`;
const GOOGLE_DISCIPLINE = `操作纪律：调用工具时确保参数完整准确，不要遗漏必要参数。需要执行操作时直接调用工具，不要仅输出计划文本。调用工具时 tool_title 参数一律用 5-10 字中文短语概括本次操作。`;
const ANTHROPIC_DISCIPLINE = `操作纪律：使用工具完成任务，工具调用与文本回复可并行。不要在未调用工具的情况下声称已完成操作。调用工具时 tool_title 参数一律用 5-10 字中文短语概括本次操作。`;

/**
 * 按 modelId 分派操作纪律块。
 * @param modelId 当前 activeSlot.provider.modelId（降级切换后传新 modelId）
 * @param config 提示层配置（discipline.toolUseEnforcement === false 时关闭）
 * @returns 纪律块文本（配置关闭时返回空串；未知模型回落 OPENAI_DISCIPLINE）
 */
export function buildDisciplineBlock(modelId: string, config: { toolUseEnforcement?: boolean }): string {
  if (config.toolUseEnforcement === false) return '';
  if (OPENAI_FAMILY.test(modelId)) return OPENAI_DISCIPLINE;
  if (GOOGLE_FAMILY.test(modelId)) return GOOGLE_DISCIPLINE;
  if (ANTHROPIC_FAMILY.test(modelId)) return ANTHROPIC_DISCIPLINE;
  // 未知模型族回落通用块而非空串：目标用户大量使用国产/自建模型，返回空串等于对
  // 最需要纪律约束的模型完全不设防；OPENAI_DISCIPLINE 措辞通用（「必须调工具、
  // 别只描述计划」），对任何模型都无害——最坏情况是多一段无关痛痒的提示，远好过漏防。
  return OPENAI_DISCIPLINE;
}
