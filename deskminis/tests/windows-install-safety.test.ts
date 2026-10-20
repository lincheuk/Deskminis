import {describe,it,expect} from 'vitest';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const scripts=join(__dirname,'../scripts'),known=(entries:unknown[]=[],running:number[]=[])=>({state:'known',entries,running});
async function load(){return await import(pathToFileURL(join(scripts,'e2e-m5-packaging.mjs')).href);}
describe('F12 temporary installer refuses existing or unknown ownership before side effects',()=>{
 it.each([known([{location:'C:\\User installed\\DeskMinis'}]),known([], [12]),{state:'unknown',entries:[]},{state:'known',entries:[]}])('never invokes installer for unsafe preflight %#',async snapshot=>{
  const m=await load(),runs:unknown[]=[];const r=m.startTemporaryInstall('setup.exe','C:\\Temp\\ours',{inspect:()=>snapshot,spawn:(...a:unknown[])=>{runs.push(a);return {status:0};}});expect(r.started).toBe(false);expect(runs).toEqual([]);
 });
 it('empty installation state invokes the actual installer seam with temporary target',async()=>{
  const m=await load(),runs:any[]=[];const r=m.startTemporaryInstall('setup.exe','C:\\Temp\\ours',{inspect:()=>known(),spawn:(...a:unknown[])=>{runs.push(a);return {status:0};}});expect(r.started).toBe(true);expect(runs).toHaveLength(1);expect(runs[0][1]).toEqual(['/S','/D=C:\\Temp\\ours']);
 });
 it.each([known([{location:'C:\\User installed\\DeskMinis'}]),known([{location:'C:\\Temp\\ours'},{location:'C:\\Other'}]),known([{location:'C:\\Temp\\ours'}],[55]),{state:'unknown',entries:[]},known([])])('changed or unknown registration never starts an uninstaller %#',async snapshot=>{
  const m=await load(),copies:unknown[]=[],runs:any[]=[],records:any[]=[];
  const r=m.uninstallTemp('C:\\Temp\\ours','C:\\Temp',{exists:()=>true,inspect:()=>snapshot,copy:(...a:unknown[])=>copies.push(a),spawn:(...a:any[])=>{runs.push(a);return {status:0};},record:(...a:unknown[])=>records.push(a)});
  expect(r).toBe(false);expect(copies).toEqual([]);expect(runs.every(a=>a[0]==='reg')).toBe(true);expect(records.some(r=>r[1]===false)).toBe(true);
 });
});
