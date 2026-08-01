/** 发送时把已落盘附件转文本尾注（MU2b Task 6，设计 §5.5）：
 *  `\n[附件] attachments/paste-1.png\n[附件] attachments/paste-2.png` 形态；空数组 → ''。
 *  路径为会话相对路径（main attachments:save handler 返回值），模型经 file_read 可读。 */
export function attachNote(paths: string[]): string {
  return paths.map(p => `\n[附件] ${p}`).join('');
}
