// 按模型族操作纪律块（M4 Task 3）：按 modelId 正则分派不同纪律块，防止模型声称完成却不调工具。
// 降级切换 provider 后，systemPrompt 工厂轮内用新 modelId 调本函数 → stable 缓存 miss 重建（Task 2 已保证）。

const OPENAI_FAMILY = /^(gpt-|codex-|grok-|o\d)/i;
const GOOGLE_FAMILY = /^(gemini-|gemma)/i;
const ANTHROPIC_FAMILY = /^claude-/i;

const OPENAI_DISCIPLINE = `操作纪律：当任务需要读写文件或执行命令时，必须调用对应工具完成，不要只描述计划或声称已完成却未调用工具。若现成工具可用则直接用，不要建议用户绕路手动操作。`;
const GOOGLE_DISCIPLINE = `操作纪律：调用工具时确保参数完整准确，不要遗漏必要参数。需要执行操作时直接调用工具，不要仅输出计划文本。`;
const ANTHROPIC_DISCIPLINE = `操作纪律：使用工具完成任务，工具调用与文本回复可并行。不要在未调用工具的情况下声称已完成操作。`;

/**
 * 按 modelId 分派操作纪律块。
 * @param modelId 当前 activeSlot.provider.modelId（降级切换后传新 modelId）
 * @param config 提示层配置（discipline.toolUseEnforcement === false 时关闭）
 * @returns 纪律块文本（未知模型或配置关闭时返回空串）
 */
export function buildDisciplineBlock(modelId: string, config: { toolUseEnforcement?: boolean }): string {
  if (config.toolUseEnforcement === false) return '';
  if (OPENAI_FAMILY.test(modelId)) return OPENAI_DISCIPLINE;
  if (GOOGLE_FAMILY.test(modelId)) return GOOGLE_DISCIPLINE;
  if (ANTHROPIC_FAMILY.test(modelId)) return ANTHROPIC_DISCIPLINE;
  return '';
}
