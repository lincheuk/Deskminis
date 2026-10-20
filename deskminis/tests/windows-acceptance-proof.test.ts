import {describe,it,expect} from 'vitest';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const scripts=join(__dirname,'../scripts'),load=async(name:string)=>await import(pathToFileURL(join(scripts,name)).href),guid='5a773664-46cc-5c78-b3d9-3d4aa76fed64';
describe('F12 read-only installation discovery fails closed',()=>{
 it.each([undefined,{status:1,stdout:'{"state":"known","entries":[],"running":[]}'},{status:null,signal:'SIGTERM',stdout:'{}'},{status:0,error:Error('spawn failed'),stdout:'{}'},{status:0,stdout:'invalid JSON'},{status:0,stdout:'{"state":"known","entries":[],"running":null}'},{status:0,stdout:'{"state":"unknown","entries":[],"running":[]}'}])('unsafe inspection %# blocks both installer and uninstaller',async result=>{
  const m=await load('windows-install-safety.mjs'),snapshot=m.readInstallations(guid,()=>result);expect(snapshot.state).toBe('unknown');expect(m.mayInstall(snapshot).ok).toBe(false);expect(m.mayUninstall(snapshot,'C:\\Temp\\ours').ok).toBe(false);
 });
 it('BOM-prefixed known empty Windows result permits installation only',async()=>{
  const m=await load('windows-install-safety.mjs'),snapshot=m.readInstallations(guid,()=>({status:0,stdout:'\uFEFF{"state":"known","entries":[],"running":[]}'}));expect(m.mayInstall(snapshot).ok).toBe(true);expect(m.mayUninstall(snapshot,'C:\\Temp\\ours').ok).toBe(false);
 });
 it('invalid identity never starts PowerShell',async()=>{const m=await load('windows-install-safety.mjs');let called=false;expect(m.readInstallations('------------------------------------',()=>{called=true;}).state).toBe('unknown');expect(called).toBe(false);});
 it('unknown empty registration remains unsafe even when arrays are present',async()=>{const m=await load('windows-install-safety.mjs');expect(m.mayInstall({state:'unknown',entries:[],running:[]}).ok).toBe(false);});
 it('relative registration that resolves to the expected directory is still unsafe',async()=>{const m=await load('windows-install-safety.mjs');expect(m.mayUninstall({state:'known',entries:[{location:'owned'}],running:[]},join(process.cwd(),'owned')).ok).toBe(false);});
 it.each(['',null,'Temp\\ours','C:\\Temp\\ours-other'])('uninstall rejects unreliable registration %#',async location=>{const m=await load('windows-install-safety.mjs');expect(m.mayUninstall({state:'known',entries:[{location}],running:[]},'C:\\Temp\\ours').ok).toBe(false);});
 it('null entry cannot crash or bypass ownership guard',async()=>{const m=await load('windows-install-safety.mjs');expect(m.mayUninstall({state:'known',entries:[null],running:[]},'C:\\Temp\\ours').ok).toBe(false);});
 it('Windows casing and trailing separator refer to the same owned installation',async()=>{const m=await load('windows-install-safety.mjs');expect(m.mayUninstall({state:'known',entries:[{location:'c:\\TEMP\\ours\\'}],running:[]},'C:\\Temp\\ours').ok).toBe(true);});
});
describe('F12 actual NSIS uninstall registration without InstallLocation',()=>{
 const dir='C:\\Temp\\ours',installation={kind:'installation',location:dir},uninstall={kind:'uninstall',location:'',uninstallString:'"C:\\Temp\\ours\\Uninstall DeskMinis.exe" /currentuser'};
 it('proves the location key and the quoted NSIS uninstaller path together',async()=>{const m=await load('windows-install-safety.mjs');expect(m.mayUninstall({state:'known',entries:[installation,uninstall],running:[]},dir).ok).toBe(true);});
 it.each(['other-uninstaller','relative-uninstaller','extra-command','other-location','missing-location-key','unknown-kind'])('refuses uncertain NSIS ownership: %s',async scenario=>{
  const m=await load('windows-install-safety.mjs'),u={...uninstall};let entries:any[]=[installation,u];
  if(scenario==='other-uninstaller')u.uninstallString='"C:\\Other\\Uninstall DeskMinis.exe" /currentuser';
  if(scenario==='relative-uninstaller')u.uninstallString='"Uninstall DeskMinis.exe" /currentuser';
  if(scenario==='extra-command')u.uninstallString+=' & other-command';
  if(scenario==='other-location')u.location='C:\\Other';
  if(scenario==='missing-location-key')entries=[u];
  if(scenario==='unknown-kind')entries=[{kind:'unknown',location:dir}];
  expect(m.mayUninstall({state:'known',entries,running:[]},dir).ok).toBe(false);
 });
});
describe('F12 actual uninstall seam requires complete post-uninstall cleanup',()=>{
 it.each([{state:'known',entries:[{kind:'uninstall',location:'',uninstallString:'"C:\\Temp\\ours\\Uninstall DeskMinis.exe" /currentuser'}],running:[]},{state:'unknown',entries:[],running:[]}])('does not report cleanup success for unreliable remaining state %#',async remaining=>{
  const m=await load('e2e-m5-packaging.mjs');let uninstalled=false,inspections=0,started=0;const records:any[]=[];
  const result=m.uninstallTemp('C:\\Temp\\ours','C:\\Temp',{inspect:()=>++inspections===1?{state:'known',entries:[{location:'C:\\Temp\\ours'}],running:[]}:remaining,exists:(path:string)=>path.endsWith('DeskMinis.exe')?!uninstalled:true,copy:()=>undefined,spawn:(file:string,args:string[])=>{if(file==='reg')return {status:args[1]==='HKCU\\Software'?0:1};started++;uninstalled=true;return {status:0};},record:(...a:any[])=>records.push(a)});
  expect(started).toBe(1);expect(result).toBe(false);expect(records.some(r=>r[1]===false&&r[2].includes('Post-uninstall'))).toBe(true);
 });
});
const ids=['actual-utilityProcess','cron-create-fields','cron-edit','cron-clear','cron-clear-persisted','docx-actual-write','docx-actual-reload','xlsx-actual-write','xlsx-actual-reload','pptx-actual-write','pptx-actual-reload','catastrophic-regex-cancel','engine-rpc-during-regex','no-network-before-approval','network-after-approval','network-command-success','main-kill-utility-exits'];
const proof=()=>({status:'PASS',checks:ids.map(id=>({id,ok:true})),application:{executable:'C:\\Temp\\our-app\\DeskMinis.exe',host:'h3',mainPid:42,utilityPid:43,temporaryUserData:true,temporaryData:true,utilityExit:{exitedUtc:1720000000000}},artifacts:['docx','xlsx','pptx'].map(ext=>({ext,sha256:'a'.repeat(64),size:2000})),cleanup:[]});
describe('F12 packaged acceptance requires actual complete evidence',()=>{
 it('accepts a full observed packaged run',async()=>{const m=await load('windows-probe-verdict.mjs');expect(m.packagedProbeVerdict({status:0},proof(),proof().application.executable).ok).toBe(true);});
 it('zero exit with no proof fails',async()=>{const m=await load('windows-probe-verdict.mjs');expect(m.packagedProbeVerdict({status:0},undefined,proof().application.executable).ok).toBe(false);});
 it.each(['missing-cancel','duplicate-check','different-exe','unobserved-exit','cleanup-kill','no-pptx','failed-check','formal-data'])('rejects counterfeit success: %s',async scenario=>{
  const m=await load('windows-probe-verdict.mjs'),p:any=proof();
  if(scenario==='missing-cancel')p.checks=p.checks.filter((c:any)=>c.id!=='catastrophic-regex-cancel');
  if(scenario==='duplicate-check')p.checks.push(p.checks[0]);
  if(scenario==='different-exe')p.application.executable='C:\\Other\\DeskMinis.exe';
  if(scenario==='unobserved-exit')delete p.application.utilityExit;
  if(scenario==='cleanup-kill')p.cleanup.push({pid:43,how:'Process.Kill'});
  if(scenario==='no-pptx')p.artifacts.pop();
  if(scenario==='failed-check')p.checks[3].ok=false;
  if(scenario==='formal-data')p.application.temporaryData=false;
  expect(m.packagedProbeVerdict({status:0},p,proof().application.executable).ok).toBe(false);
 });
 it('failed child cannot be laundered by a PASS report',async()=>{const m=await load('windows-probe-verdict.mjs');expect(m.packagedProbeVerdict({status:1},proof(),proof().application.executable).ok).toBe(false);});
});
