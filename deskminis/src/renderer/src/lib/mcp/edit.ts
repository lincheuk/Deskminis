/** W1a-7：MCP 编辑表单 → mcp.servers.upsert / mcp.servers.test 的载荷（纯函数，单测见 tests/renderer-mcp-edit.test.ts）。
 *
 *  为什么抽成纯模块：.vue 不在 typecheck 覆盖内，表单转载荷这段一旦写错就是静默丢配置——
 *  原先 SecMcp 整条提交：参数按空格切（`C:\Program Files\x` 被拆成两段）、固定塞 enabled:true
 *  （停用的服务器一保存就被重新启用）、表单里没有的 env / headers / cwd / 超时整条丢掉、note 为空是 undefined
 *  （过 JSON 被丢，备注清不掉）。后端 W1a-6 已改成补丁语义：没给的键保留、给了的覆盖、null 删键、
 *  renameFrom 原位改名。表单这边只需要做到「只提交改过的字段」，逻辑放在这里直测，SecMcp 只剩接线。 */

export type McpTransport = 'stdio' | 'streamable-http';

/** 表单里的样子：参数是多行文本，一行一个 */
export interface McpForm {
  name: string; transport: McpTransport; command: string; args: string; url: string; note: string;
}

/** 打开编辑时的原条目快照（列表条目里表单认得的那几项）。
 *  env / headers / cwd / 超时 / 停用不在表单里，也不必在这里：补丁语义下不提交就是保留。 */
export interface McpOrig {
  name: string; transport: McpTransport; command?: string; args?: string[]; url?: string; note?: string;
}

/** 参数一行一个：带空格的路径原样占一行，不需要任何引号规则 */
export function argsToText(args: readonly string[] | undefined): string {
  return (args ?? []).join('\n');
}

/** 按行切（CRLF 也认：从别处粘进来的文本常带 \r），每行去首尾空白，空行丢掉 */
export function textToArgs(text: string): string[] {
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/** 编辑时回填表单。buildMcpUpsert 判断「改没改」就是拿表单现值与这里回填的值比，所以回填只能在这一处写。 */
export function formFromOrig(o: McpOrig): McpForm {
  return {
    name: o.name, transport: o.transport, command: o.command ?? '', args: argsToText(o.args),
    url: o.url ?? '', note: o.note ?? '',
  };
}

/** 新建（orig 为 undefined）交完整条目；编辑只交改过的字段。
 *  「改过」= 框里的原始文本与 formFromOrig 回填的不同，比的是没去空白的原文：
 *  - 参数框没动就不提交 args——原参数里有换行、首尾空格这种按行表示不了的，只要不碰就原样留着；
 *  - 手改 servers.json 留下首尾空白的命令或备注，不会因为打开再保存就被悄悄改写。
 *  提交的值才去空白。任何情况下都不带 enabled：启停只归列表行的开关管，
 *  表单一旦带上，停用的服务器编辑一次就被重新启用（W1a 之前正是如此）。 */
export function buildMcpUpsert(orig: McpOrig | undefined, form: McpForm): Record<string, unknown> {
  const name = form.name.trim();
  const note = form.note.trim();
  const family = (p: Record<string, unknown>): void => {
    if (form.transport === 'stdio') { p.command = form.command.trim(); p.args = textToArgs(form.args); }
    else p.url = form.url.trim();
  };
  if (!orig) {
    const p: Record<string, unknown> = { name, transport: form.transport };
    family(p);
    if (note) p.note = note;
    return p;
  }

  const was = formFromOrig(orig);
  const p: Record<string, unknown> = { name };
  // 改名走 renameFrom：后端原位换键、一次写盘。原先是先删旧条目再 upsert，upsert 一失败旧条目就没了
  if (name !== orig.name) p.renameFrom = orig.name;
  if (form.transport !== orig.transport) {
    // 换传输类型：后端会整族清掉旧族字段，新族字段要交全
    p.transport = form.transport;
    family(p);
  } else if (form.transport === 'stdio') {
    if (form.command !== was.command) p.command = form.command.trim();
    if (form.args !== was.args) p.args = textToArgs(form.args);
  } else if (form.url !== was.url) {
    p.url = form.url.trim();
  }
  // 清空备注发 null：undefined 过 JSON-RPC 会被丢掉，后端只认 null 是「删掉这个键」
  if (form.note !== was.note) p.note = note === '' ? null : note;
  return p;
}

/** 同名新建在前端拦（设计稿 §2）：后端 upsert 是补丁语义，用已有的名字「添加」会合并进旧条目——
 *  新填的命令盖掉旧的，旧的 env 却留着，两边都不是用户想要的。后端不加控制键，因为市场同名时正是更新流程。
 *  编辑不拦：名字没变是在改它自己；改成别人的名字由后端报「已存在同名 MCP server」。
 *  返回空串表示没问题。 */
export function duplicateNameError(orig: McpOrig | undefined, name: string, existing: readonly string[]): string {
  if (orig) return '';
  const n = name.trim();
  return existing.includes(n) ? `已有同名服务器「${n}」，请换个名字或编辑它` : '';
}
