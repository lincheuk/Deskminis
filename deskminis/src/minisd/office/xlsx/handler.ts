import type {OfficeFormatHandler} from '../format';
import {normalizeXlsx} from './model';
import {renderXlsx} from './build';
import {verifyXlsxContent} from './content-check';
import {refuseXlsxOverwrite} from './inspect';
export const xlsxHandler:OfficeFormatHandler={
  format:'xlsx',app:'Excel',
  help:{brief:'xlsx 只整份生成新工作簿；支持显式类型、有限公式、基本样式，外来或修改的工作簿请另存',
    content:'xlsx={"sheets":[{"name":"预算","rows":[["品名","金额"],["甲",{"type":"number","value":100,"numFmt":"¥#,##0.00"}],["合计",{"type":"formula","formula":"SUM(B2:B2)","numFmt":"¥#,##0.00"}]],"colWidths":[20,18],"headerRows":1,"freeze":{"rows":1,"columns":0}}]}；string/number/boolean/null 或对象type=text/number/date/boolean/formula/error/blank；日期YYYY-MM-DD；公式只支持A1引用、范围、基本运算、SUM/AVERAGE/MIN/MAX/COUNT/ROUND/ABS/IF，拒绝外部链接和循环；字符串即使以=开头也仍是文本；公式未计算，不接受缓存value；格式General/0/0.00/#,##0.00/¥#,##0.00/0%/0.00%/yyyy-mm-dd/@，wrap布尔值；最多32表/10000行/256列/50000格/2000公式'},
  plan(spec){const model=normalizeXlsx(spec),bytes=renderXlsx(model),formulas=model.sheets.reduce((n,s)=>n+s.rows.flat().filter(c=>c.type==='formula').length,0);
    return {summary:`Excel 工作簿，${model.sheets.length} 张表`,bytes,notes:formulas?[`公式尚未计算，${formulas} 个公式的结果未经核验；请在Excel中重算。`]:[],verifyContent:subject=>verifyXlsxContent(bytes,model,subject)};
  },
  refuseOverwrite:refuseXlsxOverwrite,
  readNote(doc){return doc.sheets?.some(s=>s.cells.some(r=>r.some(c=>c.type==='formula'||c.unsupported)))?'（公式只读出原表达式和已有缓存，未重新计算；不支持的共享/数组公式未展开。office_write 不能在原工作簿上编辑，复杂工作簿请另存。）':undefined;},
  toText(doc){const out:string[]=[];for(const s of doc.sheets??[]){out.push(`## 工作表：${s.name}（${s.rows.length} 行）`);for(const r of s.rows)out.push(r.join('\t'));out.push('');}return out.join('\n').trim();},
};
