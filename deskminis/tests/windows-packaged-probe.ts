/** Actual packaged utilityProcess + loopback fixtures. No formal data, real keys or UI automation. */
import fs from 'node:fs';import {createRequire} from 'node:module';
const rawFs:typeof fs=process.versions.electron?createRequire(import.meta.url)('original-fs'):fs;import {join,resolve,dirname} from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createServer} from 'node:http';
import {Lab,until} from './proc-lifecycle-fixture';import {eventsOf,cardsOf,readDb} from './run-ledger-fixture';
const value=(key:string)=>{const i=process.argv.indexOf(key);return i<0?undefined:process.argv[i+1];},app=value('--app'),evidence=value('--evidence');
if(!app||!evidence)throw Error('--app and --evidence required');const dir=resolve(evidence);if(fs.existsSync(dir))throw Error('New evidence directory required');fs.mkdirSync(dir,{recursive:true});
const checks:any[]=[],report:any={application:{},checks,model:'loopback scripted fixture, not a real API',ui:'unverified',cleanup:[]};
const save=()=>fs.writeFileSync(join(dir,'probe.json'),JSON.stringify(report,null,2)),check=(id:string,expected:any,actual:any)=>{const ok=JSON.stringify(expected)===JSON.stringify(actual);checks.push({id,expected,actual,ok});save();assert(ok,id+' '+JSON.stringify(actual));};
const lab=await Lab.open();let httpHits=0;const server=createServer((_q,res)=>{httpHits++;res.end('F12-local-network-fixture');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const port=(server.address() as {port:number}).port;let seq=900;
async function rpc(method:string,params:any={}){const r=await lab.c!.call(method,params);if(r.error)throw Error(method+': '+r.error.message);return r.result;}
async function session(title:string){const s=await rpc('chat.sessions.create',{title}),ws=join(lab.root,'f12-'+s.id.slice(0,8));fs.mkdirSync(ws);await rpc('workspace.set',{sessionId:s.id,root:ws});return {id:s.id,ws};}
async function invoke(sid:string,name:string,input:any){const tag='S'+(++seq);lab.scripts[tag]=[{tools:[{name,input:{...input,tool_title:'F12 '+name}}]},{text:'F12 完成'}];void rpc('chat.prompt',{sessionId:sid,text:`[[${tag}]] 执行固定本地测试`});await until('tool end',()=>eventsOf(lab.c!,sid).some(e=>e.kind==='toolEnd'),45000);const result=eventsOf(lab.c!,sid).filter(e=>e.kind==='toolEnd').at(-1);return result;}
try{
 const ref=await lab.startGui(resolve(app));report.application={mainPid:ref.hostChild!.pid,utilityPid:ref.pid,host:ref.host,executable:resolve(app),exeSha256:createHash('sha256').update(fs.readFileSync(resolve(app))).digest('hex'),asarSha256:createHash('sha256').update(rawFs.readFileSync(join(dirname(resolve(app)),'resources/app.asar'))).digest('hex'),temporaryUserData:true,temporaryData:true};save();
 check('actual-utilityProcess','h3',ref.host);
 const assistant=await rpc('assistants.create',{name:'F12 夹具助手',rules:'只执行固定本地验收夹具'}),assistantId=assistant.id;assert(assistantId,'test assistant missing');
 const job=await rpc('cron.create',{name:'F12 定时任务字段验收',prompt:'[[S999]] F12 固定任务',scheduleKind:'interval',scheduleValue:'30',assistantId,workspaceRoot:lab.root});
 check('cron-create-fields',[assistantId,lab.root],[job.assistantId,job.workspaceRoot]);
 const edited=await rpc('cron.update',{id:job.id,name:'F12 已编辑',scheduleValue:'45',workspaceRoot:join(lab.root,'edited')});check('cron-edit',['F12 已编辑','45',join(lab.root,'edited')],[edited.name,edited.scheduleValue,edited.workspaceRoot]);
 const cleared=await rpc('cron.update',{id:job.id,assistantId:'',workspaceRoot:''});check('cron-clear',[null,null],[cleared.assistantId??null,cleared.workspaceRoot??null]);
 const stored=readDb(lab.dataDir,'SELECT assistant_id,workspace_root FROM cron_jobs WHERE id=?',job.id)[0];check('cron-clear-persisted',[null,null],[stored.assistant_id,stored.workspace_root]);report.cron={id:job.id,fieldsCleared:true};save();
 const specs:any={docx:{title:'F12 文档',blocks:[{kind:'para',text:'F12 可重载办公文件'}]},xlsx:{sheets:[{name:'F12',rows:[['F12 可重载办公文件',241]]}]},pptx:{slides:[{title:'F12 可重载办公文件',bullets:['中文可编辑内容']}]}};
 report.artifacts=[];
 for(const [ext,spec]of Object.entries(specs)){
  const s=await session('F12 '+ext+' 产出'),path=join(s.ws,'f12.'+ext);lab.allow.add(s.id);
  const written=await invoke(s.id,'office_write',{path,content:JSON.stringify(spec)});check(ext+'-actual-write',true,written?.success);assert(written.output.includes('内容核验：通过'));assert(written.output.includes('版式核验：未核验'));
  const readSession=await session('F12 '+ext+' 重读');lab.allow.add(readSession.id);const read=await invoke(readSession.id,'office_read',{path});check(ext+'-actual-reload',true,read?.success);assert(read.output.includes('F12 可重载办公文件'));
  const bytes=fs.readFileSync(path),dest=join(dir,'f12.'+ext);fs.copyFileSync(path,dest);report.artifacts.push({ext,path:dest,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});save();
 }
 const grep=await session('F12 灾难正则取消');fs.writeFileSync(join(grep.ws,'redos.txt'),'a'.repeat(40)+'!');
 if(process.argv.includes('--interactive')){fs.writeFileSync(join(dir,'ready.json'),JSON.stringify({mainPid:ref.hostChild!.pid,utilityPid:ref.pid,cronId:job.id,artifacts:report.artifacts},null,2));console.log('READY '+dir);await until('interactive regex go',()=>fs.existsSync(join(dir,'start-regex')),1200000);}
 const tag='S'+(++seq);lab.scripts[tag]=[{tools:[{name:'file_grep',input:{pattern:'(a+)+$',tool_title:'F12 灾难正则'}}]},{text:'完成'}];void rpc('chat.prompt',{sessionId:grep.id,text:`[[${tag}]] 搜索固定夹具`});
 await until('grep started',()=>eventsOf(lab.c!,grep.id).some(e=>e.kind==='toolStart'),15000);const start=Date.now();await new Promise(r=>setTimeout(r,350));
 const health:number[]=[];let cancelledAt=0;fs.writeFileSync(join(dir,'regex-running.json'),JSON.stringify({startedAt:start}));
 for(let i=0;i<25;i++){const before=Date.now();await rpc('cron.list');health.push(Date.now()-before);if(!process.argv.includes('--interactive')||fs.existsSync(join(dir,'cancel-regex'))||Date.now()-start>8000)break;await new Promise(r=>setTimeout(r,250));}
 cancelledAt=Date.now();await rpc('chat.cancel',{sessionId:grep.id});await until('grep cancelled',()=>eventsOf(lab.c!,grep.id).some(e=>e.kind==='toolEnd'),10000);
 const end=eventsOf(lab.c!,grep.id).filter(e=>e.kind==='toolEnd').at(-1);check('catastrophic-regex-cancel','[已取消]',end?.output);check('engine-rpc-during-regex',true,health.every(ms=>ms<1500));report.regex={startedAt:start,cancelledAt,endedAt:Date.now(),rpcLatenciesMs:health,ui:'record screenshot timing separately'};save();
 const network=await session('F12 联网权限验收');const command=`Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${port}/fixture' | Select-Object -ExpandProperty Content`,netTag='S'+(++seq);lab.scripts[netTag]=[{tools:[{name:'shell_execute',input:{command,tool_title:'F12 仅回环联网'}}]},{text:'完成'}];void rpc('chat.prompt',{sessionId:network.id,text:`[[${netTag}]] 执行本地联网夹具`});
 await until('network permission request',()=>cardsOf(lab.c!,network.id).length>0,20000);check('no-network-before-approval',0,httpHits);
 const card=cardsOf(lab.c!,network.id).at(-1)!;report.permission={sessionId:network.id,pending:true,command,networkHitsBefore:0};save();
 if(process.argv.includes('--interactive')){fs.writeFileSync(join(dir,'permission-ready.json'),JSON.stringify({sessionId:network.id,command}));console.log('PERMISSION READY');await until('permission observed',()=>fs.existsSync(join(dir,'allow-network')),80000);}
 await rpc('permission.respond',{requestId:card.params.requestId,decision:'allow-once'});await until('network tool end',()=>eventsOf(lab.c!,network.id).some(e=>e.kind==='toolEnd'),45000);const netEnd=eventsOf(lab.c!,network.id).filter(e=>e.kind==='toolEnd').at(-1);check('network-after-approval',1,httpHits);check('network-command-success',true,netEnd?.success);report.permission={...report.permission,pending:false,networkHitsAfter:httpHits};save();
 if(process.argv.includes('--interactive')){fs.writeFileSync(join(dir,'finish-ready'),String(Date.now()));console.log('UI FINISH READY');await until('UI review complete',()=>fs.existsSync(join(dir,'finish')),1200000);}
 report.forcedMainExit=true;lab.killHost();await until('utility exit after main kill',()=>lab.observer.exited(ref.pid),60000);check('main-kill-utility-exits',true,lab.observer.exited(ref.pid));report.application.utilityExit=lab.observer.held.get(ref.pid);await until('main exit observed',()=>lab.observer.exited(ref.hostChild!.pid!),60000);report.application.mainExit=lab.observer.held.get(ref.hostChild!.pid!);report.status='PASS';
}catch(e){report.status='FAIL';report.error=e instanceof Error?e.stack:String(e);console.error(report.error);}
finally{await lab.settle();await lab.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));report.cleanup=lab.cleanup;save();}
console.log(JSON.stringify({status:report.status,checks:checks.length,failed:checks.filter(c=>!c.ok).length,evidence:dir}));process.exit(report.status==='PASS'?0:1);
