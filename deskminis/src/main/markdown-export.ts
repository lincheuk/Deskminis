/** W10：建议名只作为文件名，目录由系统另存为对话框决定。80个Unicode字符，不拆代理对。 */
export function markdownFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '').trim().replace(/[.\s]+$/g, '');
  const name = Array.from(clean).slice(0, 80).join('').trim().replace(/[.\s]+$/g, '');
  return (name || 'DeskMinis 会话') + '.md';
}
