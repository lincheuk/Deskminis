import {expect,it} from 'vitest';
import {sessionMarkdown} from '../src/renderer/src/lib/session-markdown';
const exported=new Date(2026,9,19,13,20),at=(h:number,m:number,s=0)=>new Date(2026,9,19,h,m,s).getTime()/1000;
const text=(value:string)=>({type:'text',value}),tool=(id:string,name:string,input:string)=>({type:'toolUse',value:{toolUseId:id,name,input}}),result=(id:string,success:boolean,status='success')=>({type:'toolResult',value:{toolUseId:id,success,status,output:'工具输出秘密全文'}});
it('完整期望逐字：孤立助手、附件、正文/连续工具顺序、结果载体、两种推理、未知/缺失结果、用时与空回答回合',()=>{
 const rows=[
 {role:'assistant',createdAt:at(12,50),parts:[text('开场 **正文**')],reasoningContent:'开场思考秘密'},
 {role:'user',createdAt:at(12,54),parts:[text('**你好**\r\n第二行'),text('不导出第二个用户正文'),{type:'mediaRef',value:{relativePath:'attachments/x.png',originalFileName:'a.png'}},{type:'mediaRef',value:{relativePath:'attachments/b.pdf'}}]},
 {role:'assistant',createdAt:at(12,54,1),parts:[{type:'thinking',value:{text:'thinking秘密',signature:'sig'}},text('先看这段。\n\n```ts\nconst a = 1;\n```'),tool('t1','file_read','{"tool_title":"读文件","path":"输入秘密"}'),tool('t2','shell_execute','{"tool_title":"检查命令"}')],reasoningContent:'真实推理秘密'},
 {role:'user',createdAt:at(12,54,20),parts:[result('t1',true),result('t2',false,'failed')],errorInfo:'错误字段秘密'},
 {role:'assistant',createdAt:at(12,54,24),parts:[text('随后正文。')]},
 {role:'assistant',createdAt:at(12,54,40),parts:[tool('t3','shell_execute','{"tool_title":"执行命令"}'),tool('t4','missing_result','bad-json')],reasoningContent:'No reasoning available.'},
 {role:'user',createdAt:at(12,55,12),parts:[result('t3',false,'unknown')]},
 {role:'user',createdAt:at(13,0),parts:[text('另一个问题')]},
 {role:'assistant',createdAt:at(12,59),parts:[{type:'thinking',value:{text:'最后思考秘密'}},text('完成。')],errorInfo:'最后错误秘密'},
 {role:'user',createdAt:at(13,2),parts:[text('这轮没有回答')]},
 {role:'assistant',createdAt:at(13,2,1),parts:[{type:'thinking',value:{text:'仅思考也没有助手正文'}}]},
 {role:'user',createdAt:at(13,3),parts:[text('下一轮仍未收到回答')]},
 {role:'user',createdAt:at(13,3,10),parts:[result('no-content',false,'failed')]},
 ];const before=JSON.stringify(rows);
 const expected='# 方案讨论\n\n> 由 DeskMinis 导出 · 2026-10-19 13:20\n\n## DeskMinis\n\n开场 **正文**\n\n## 你 · 2026-10-19 12:54\n\n**你好**\n第二行\n\n附件：a.png、b.pdf\n\n## DeskMinis · 用时 1 分 12 秒\n\n先看这段。\n\n```ts\nconst a = 1;\n```\n\n- 工具：读文件（成功）\n- 工具：检查命令（失败）\n\n随后正文。\n\n- 工具：执行命令（已中断）\n- 工具：missing_result（已中断）\n\n## 你 · 2026-10-19 13:00\n\n另一个问题\n\n## DeskMinis\n\n完成。\n\n## 你 · 2026-10-19 13:02\n\n这轮没有回答\n\n## 你 · 2026-10-19 13:03\n\n下一轮仍未收到回答\n';
 expect(sessionMarkdown(rows,'方案讨论',exported)).toBe(expected);expect(JSON.stringify(rows)).toBe(before);
});
it('空会话与空标题',()=>expect(sessionMarkdown([],'',exported)).toBe('# 新会话\n\n> 由 DeskMinis 导出 · 2026-10-19 13:20\n\n（这个会话还没有消息）\n'));
it('仅附件用户，路径末段兼容两种分隔符，无后继不造用时',()=>expect(sessionMarkdown([{role:'user',createdAt:at(12,54),parts:[{type:'mediaRef',value:{relativePath:'attachments/a.png'}},{type:'mediaRef',value:{relativePath:'attachments\\b.pdf'}},{type:'mediaRef',value:{}}]}],'附件',exported)).toBe('# 附件\n\n> 由 DeskMinis 导出 · 2026-10-19 13:20\n\n## 你 · 2026-10-19 12:54\n\n附件：a.png、b.pdf\n'));
it.each([[0.4,'不到 1 秒'],[59,'59 秒'],[60,'1 分'],[3599,'59 分 59 秒'],[3600,'1 小时'],[3725,'1 小时 2 分']] as const)('用时复用C3 %s', (seconds,label)=>{const t=at(12,0);const value=sessionMarkdown([{role:'user',createdAt:t,parts:[text('q')]},{role:'assistant',createdAt:t+1,parts:[text('a')]},{role:'user',createdAt:t+seconds,parts:[result('x',true)]}],'t',exported);expect(value).toContain('## DeskMinis · 用时 '+label+'\n');expect(value.match(/## 你/g)).toHaveLength(1);});
it('缺少或非有限时间不写用时；正文原样，换行统一LF',()=>{const value=sessionMarkdown([{role:'user',parts:[text('q\r\nx')]},{role:'assistant',createdAt:NaN,parts:[text('  a\r\nb  '),tool('x','fallback','{}'),tool('y','n','{"tool_title":"跨行\\n标题"}')]}],'',exported);expect(value).toContain('## DeskMinis\n\n  a\nb  \n\n- 工具：fallback（已中断）\n- 工具：跨行 标题（已中断）');expect(value).not.toContain('用时');expect(value).not.toContain('\r');});

it('没有助手正文或工具行的回合不写空DeskMinis标题',()=>{
 const rows=[{role:'user',createdAt:at(12,54),parts:[text('问题')]},{role:'assistant',createdAt:at(12,54,1),parts:[text(''),{type:'thinking',value:{text:'只剩思考'}}]},{role:'user',createdAt:at(12,55),parts:[result('x',false,'failed')]}];
 expect(sessionMarkdown(rows,'空回答',exported)).toBe('# 空回答\n\n> 由 DeskMinis 导出 · 2026-10-19 13:20\n\n## 你 · 2026-10-19 12:54\n\n问题\n');
});
