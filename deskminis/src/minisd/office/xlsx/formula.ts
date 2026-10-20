/** Parse an intentionally small formula grammar; never evaluate, access files or invoke Excel. */
import type {Workbook} from './model';
import {cellPosition,colName,fail} from './model';
interface Token {kind:'number'|'string'|'word'|'sheet'|'symbol';text:string}
const ARITY:Record<string,[number,number]>={SUM:[1,255],AVERAGE:[1,255],MIN:[1,255],MAX:[1,255],COUNT:[1,255],ROUND:[2,2],ABS:[1,1],IF:[2,3]};
function tokens(s:string):Token[]{
  const out:Token[]=[];let i=0;
  while(i<s.length){
    if(/\s/.test(s[i])){i++;continue;}
    const rest=s.slice(i);let m:RegExpExecArray|null;
    if((m=/^"(?:[^"]|"")*"/.exec(rest)))out.push({kind:'string',text:m[0]});
    else if((m=/^'(?:[^']|'')*'/.exec(rest)))out.push({kind:'sheet',text:m[0]});
    else if((m=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(rest)))out.push({kind:'number',text:m[0]});
    else if((m=/^\$?[A-Za-z_\u0080-\uffff][A-Za-z0-9_.$\u0080-\uffff]*/.exec(rest)))out.push({kind:'word',text:m[0]});
    else if((m=/^(?:<>|<=|>=|[+\-*/^&%=<>(),!:])/.exec(rest)))out.push({kind:'symbol',text:m[0]});
    else return fail(`公式含不支持的结构（位置 ${i+1}）；不支持外部链接、DDE、名称或网络函数`);
    i+=m[0].length;if(out.length>512)return fail('公式超过512个token');
  }
  return out;
}
function references(formula:string,current:number,book:Workbook):string[]{
  const ts=tokens(formula),refs:string[]=[];let at=0,depth=0;
  const peek=()=>ts[at]?.text;
  const take=(s:string)=>{if(peek()!==s)return fail(`公式期待 ${s}`);at++;};
  const add=(sheet:number,ref:string)=>{
    const p=cellPosition(ref);if(p.row>=10000||p.col>=256)return fail('公式引用超出10000行或256列');
    refs.push(`${sheet}!${colName(p.col)}${p.row+1}`);if(refs.length>10000)return fail('单个公式引用超过10000个单元格');return p;
  };
  function primary():void{
    if(++depth>64)return fail('公式嵌套超过64层');
    try{
      if(peek()==='+'||peek()==='-'){at++;primary();return;}
      if(peek()==='('){at++;expression();take(')');return;}
      const t=ts[at++];if(!t)return fail('公式缺少操作数');
      if(t.kind==='number'){if(!Number.isFinite(Number(t.text)))return fail('公式数值必须有限');return;}
      if(t.kind==='string')return;
      if(t.kind!=='word'&&t.kind!=='sheet')return fail('公式含不支持的操作数');
      if(peek()==='('){
        const limits=ARITY[t.text.toUpperCase()];if(!limits||t.kind==='sheet')return fail(`不支持的公式函数 ${t.text}`);
        at++;let args=0;if(peek()!==')'){do{expression();args++;if(peek()!==',')break;at++;}while(true);}take(')');
        if(args<limits[0]||args>limits[1])return fail(`公式函数 ${t.text} 的参数数量不正确`);return;
      }
      let sheet=current,ref=t.text;
      if(peek()==='!'){
        at++;const name=t.kind==='sheet'?t.text.slice(1,-1).replace(/''/g,"'"):t.text;
        sheet=book.sheets.findIndex(s=>s.name.toLowerCase()===name.toLowerCase());if(sheet<0)return fail(`公式引用不存在的工作表 ${name}`);
        const c=ts[at++];if(c?.kind!=='word')return fail('工作表引用缺少单元格');ref=c.text;
      }else if(t.kind==='sheet')return fail('引号工作表名之后必须有 !');
      const a=add(sheet,ref);
      if(peek()===':'){
        at++;const b=ts[at++];if(b?.kind!=='word')return fail('范围缺少结束单元格');
        const z=cellPosition(b.text);if(z.row>=10000||z.col>=256||z.row<a.row||z.col<a.col)return fail('公式范围越界或倒序');
        const size=(z.row-a.row+1)*(z.col-a.col+1);if(size>10000)return fail('公式范围超过10000个单元格');
        for(let r=a.row;r<=z.row;r++)for(let c=a.col;c<=z.col;c++)if(r!==a.row||c!==a.col)add(sheet,`${colName(c)}${r+1}`);
      }
    }finally{depth--;}
  }
  const precedence:Record<string,number>={'=':1,'<>':1,'<':1,'>':1,'<=':1,'>=':1,'&':2,'+':3,'-':3,'*':4,'/':4,'^':5};
  function expression(min=1):void{primary();while(peek()==='%')at++;while((precedence[peek()??'']??0)>=min){const p=precedence[peek()!]!;at++;expression(p+1);}}
  expression();if(at!==ts.length)return fail(`公式含多余内容 ${peek()}`);return [...new Set(refs)];
}
export function checkFormulas(book:Workbook):void{
  const formulas=new Map<string,{formula:string;sheet:number}>();
  book.sheets.forEach((s,i)=>s.rows.forEach((r,y)=>r.forEach((c,x)=>{if(c.type==='formula')formulas.set(`${i}!${colName(x)}${y+1}`,{formula:c.formula!,sheet:i});})));
  if(formulas.size>2000)return fail('工作簿超过2000个公式');
  const remaining=new Map<string,number>(),users=new Map<string,string[]>();let total=0;
  for(const [id,f]of formulas){const refs=references(f.formula,f.sheet,book);total+=refs.length;if(total>100000)return fail('工作簿公式引用超过100000个单元格');const deps=refs.filter(r=>formulas.has(r));remaining.set(id,deps.length);for(const d of deps)users.set(d,[...(users.get(d)??[]),id]);}
  const ready=[...remaining].filter(([,n])=>n===0).map(([id])=>id);let done=0;
  for(let i=0;i<ready.length;i++){done++;for(const id of users.get(ready[i])??[]){const n=remaining.get(id)!-1;remaining.set(id,n);if(!n)ready.push(id);}}
  if(done!==formulas.size)fail('公式存在直接或间接循环引用；请先消除循环');
}
