/**
 * W1b-4（cross.md missing：删除的渲染端配套）：NavRail 会话菜单的「删除」有进行中状态，失败原因落在菜单里。
 *
 * 后端删除改成「先中止、等收尾（最长 10 秒）再删」，停不下来就报错不删。旧的 onDelete 没有 try/catch
 * 也没有进行中状态：等待期间按钮毫无反应，失败则是一次未处理拒绝，界面上就是「点了删除没反应」。
 *
 * .vue 不在 typecheck 覆盖内，这里是源码守卫：先剥注释再认调用形态（模板剥 <!-- -->，脚本剥块注释与行注释），
 * 否则注释里留一句原文就能把断言喂饱（交接 §2 第 10 条）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments';

const src = readFileSync(join(__dirname, '../src/renderer/src/ui/NavRail.vue'), 'utf8').replace(/\r\n/g, '\n');
const script = stripComments(src.slice(src.indexOf('<script'), src.indexOf('</script>')));
const tpl = src.slice(src.indexOf('<template>'), src.lastIndexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '');
const css = src.slice(src.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');

/** 取一个函数的函数体（到下一个顶层 function / const 声明为止，够用：NavRail 的函数都不嵌套声明）。 */
function fnBody(name: string): string {
  const start = script.search(new RegExp(`(?:async\\s+)?function ${name}\\(`));
  if (start < 0) return '';
  const rest = script.slice(start + 1);
  const end = rest.search(/\n(?:async\s+)?function |\nconst |\ntype /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('W1b-4 NavRail 删除中状态与报错', () => {
  const body = fnBody('onDelete');

  it('onDelete：先把这一行记为删除中，try 里 await chat.deleteSession，catch 把原因记在这一行名下，finally 只摘这一行', () => {
    expect(body).not.toBe('');
    const setIdx = body.search(/deletingIds\.value\.add\(id\)/);
    const tryIdx = body.search(/\btry\s*\{/);
    const callIdx = body.search(/await chat\.deleteSession\(id\)/);
    const catchIdx = body.search(/\bcatch\s*\(e\)\s*\{/);
    const finIdx = body.search(/\bfinally\s*\{/);
    expect(setIdx).toBeGreaterThan(-1);
    expect(tryIdx).toBeGreaterThan(setIdx);
    expect(callIdx).toBeGreaterThan(tryIdx);
    expect(catchIdx).toBeGreaterThan(callIdx);
    expect(finIdx).toBeGreaterThan(catchIdx);
    expect(body.slice(catchIdx, finIdx)).toMatch(/deleteErrs\.value\[id\]\s*=\s*e instanceof Error \? e\.message : String\(e\)/);
    expect(body.slice(finIdx)).toMatch(/deletingIds\.value\.delete\(id\)/);
  });

  // 审查逮到的回归：全局闸 `if (deletingId.value) return;` 让 A 删除中（最长 10 秒）去 B 行点「删除」毫无反应——
  // 按钮可点、不发请求、不提示。后端 chat.sessions.delete 逐会话 stopRun，并发删不同会话本来就没问题，闸改成按行。
  it('防连点按行：同一行删除中再点不重复发；别的行照常删（没有全局闸）；成功后只收自己这一行的菜单', () => {
    expect(body).toMatch(/if \(deletingIds\.value\.has\(id\)\) return;/);
    expect(script).not.toMatch(/if \(deletingIds?\.value(?:\.size)?\) return/);
    expect(body).toMatch(/if \(menuFor\.value === id\) \{\s*menuFor\.value = '';\s*confirmDelete\.value = '';\s*\}/);
  });

  // 允许并发删之后，A 删除中去 B 行开菜单是正常路径：A 的失败原因要留到用户回 A 行看见为止，换行开菜单不能把它清掉
  it('报错记在各行名下：换行开菜单不清别行的报错；只有收起自己这一行、点取消或重删时才清', () => {
    const toggle = fnBody('toggleMenu');
    expect(toggle).toMatch(/if \(menuFor\.value === id\) delete deleteErrs\.value\[id\];/);
    expect(toggle).not.toMatch(/deleteErrs\.value\s*=/);
    expect(fnBody('cancelDelete')).toMatch(/confirmDelete\.value = '';\s*delete deleteErrs\.value\[id\];/);
    expect(body.slice(0, body.search(/\btry\s*\{/))).toMatch(/delete deleteErrs\.value\[id\];/);
  });

  it('模板：删除中这一行两颗按钮都禁用，删除钮改字「删除中…」，并交代在等任务停下；禁用只看这一行', () => {
    const del = /<button class="mi danger" type="button"[^>]*@click\.stop="onDelete\(s\.id\)"[^>]*>([^<]*)<\/button>/.exec(tpl);
    expect(del, '缺删除确认钮').not.toBeNull();
    expect(del![0]).toMatch(/:disabled="deletingIds\.has\(s\.id\)"/);
    expect(del![1]).toMatch(/\{\{\s*deletingIds\.has\(s\.id\) \? '删除中…' : '删除'\s*\}\}/);
    const cancel = /<button class="mi" type="button"[^>]*>取消<\/button>/.exec(tpl);
    expect(cancel?.[0] ?? '').toMatch(/:disabled="deletingIds\.has\(s\.id\)"/);
    expect(cancel?.[0] ?? '').toMatch(/@click\.stop="cancelDelete\(s\.id\)"/);
    expect(tpl).toMatch(/<div v-if="deletingIds\.has\(s\.id\)" class="mask t-aux">[^<]*停[^<]*<\/div>/);
    expect(tpl).not.toMatch(/:disabled="!!deletingId|deletingIds\.size/);
  });

  it('模板：报错落在这一行的菜单里（与重命名同一种 .smenu-err），不在确认态里也显示', () => {
    const errIdx = tpl.search(/<div v-if="deleteErrs\[s\.id\]" class="smenu-err">\{\{ deleteErrs\[s\.id\] \}\}<\/div>/);
    const waitIdx = tpl.search(/<div v-if="deletingIds\.has\(s\.id\)" class="mask t-aux">/);
    expect(errIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeGreaterThan(-1);
    // 报错行在确认态的 <template v-else> 之外：回到这一行时确认态已被 toggleMenu 复位，报错也要看得见
    expect(tpl.slice(waitIdx, errIdx)).toMatch(/<\/template>/);
  });

  it('禁用态看得出来（不是只有 cursor）', () => {
    const rules = [...css.matchAll(/\.mi:disabled[^{]*\{([^}]*)\}/g)].map(x => x[1]).join('\n');
    expect(rules).toMatch(/opacity:/);
  });
});

// xvfb 实拍逮到的（W1b-4）：删掉的是唯一一个、且正在跑的会话时，run 被中止后 loop 报的「已取消」先于删除完成到达，
// 写进 lastError / eventNotes；删完落到欢迎页，欢迎页的输入卡照样顶着这条已删会话的错误。
// 落到别的会话时 open() 换会话会清掉这组临时态，落到欢迎页的分支以前只清了 activeId 与 messages。
describe('W1b-4 store.deleteSession：落到欢迎页时清掉被删会话的临时态', () => {
  const chatCode = stripComments(readFileSync(join(__dirname, '../src/renderer/src/stores/chat.ts'), 'utf8').replace(/\r\n/g, '\n'));
  const del = (chatCode.split(/\n {4}async deleteSession\(id: string\) \{/)[1] ?? '').split(/\n {4}(?:async )?[a-zA-Z]+\(/)[0];
  const elseBranch = del.slice(del.search(/\belse \{/));

  it('else 分支（没有别的会话可落）清 lastError / eventNotes / running 与降级、压缩、卸载、流式态', () => {
    expect(del).not.toBe('');
    expect(elseBranch.startsWith('else {')).toBe(true);
    for (const re of [
      /this\.activeId = ''/, /this\.messages = \[\]/,
      /this\.lastError = ''/, /this\.retryNote = ''/, /this\.running = false/,
      /this\.eventNotes = \[\]/, /this\.fallbackState = null/, /this\.compactedState = null/, /this\.offloadedState = null/,
      /this\.streamingText = ''/, /this\.streamingThinking = ''/, /this\.toolCards = \[\]/,
    ]) expect(elseBranch).toMatch(re);
  });
});
