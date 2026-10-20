/** 只过滤已见过的占位句；原始推理仍由 store 和数据库保留。 */
const PLACEHOLDER = 'no reasoning available.';
export function isReasoningPlaceholder(text: string): boolean {
  const value = text.trim().toLowerCase();
  return value === PLACEHOLDER || value === PLACEHOLDER.slice(0, -1);
}

/** 流式前缀先不画，分歧的第一帧就恢复真实思考。 */
export function showLiveReasoning(text: string): boolean {
  const value = text.trim().toLowerCase();
  return value !== '' && !PLACEHOLDER.startsWith(value);
}
