#!/usr/bin/env node
/** Repeatable local Windows acceptance. Exit zero means automated steps passed, not release readiness. */
import fs from 'node:fs';import {join,resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import os from 'node:os';
import {preparePackageStage} from './windows-package-stage.mjs';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..'),repo=resolve(app,'..'),value=k=>{const i=process.argv.indexOf(k);return i<0?undefined:process.argv[i+1];},has=k=>process.argv.includes(k),evidence=value('--evidence');
if(process.platform!=='win32'||!evidence){console.error('Use on Windows: node scripts/verify-windows.mjs --evidence <new directory> [--package] [--install] [--npm-cli <npm-cli.js>]');process.exit(2);}
const out=resolve(evidence);if(fs.existsSync(out)){console.error('Evidence directory already exists; choose a new directory');process.exit(2);}fs.mkdirSync(out,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex'),git=process.env.DESKMINIS_VERIFY_GIT??'git',steps=[];
const gitRun=args=>{const r=spawnSync(git,['-C',repo,...args],{encoding:'utf8',windowsHide:true,timeout:15000});if(r.status!==0)throw Error('Git inspection failed');return r.stdout.trim();};
function snapshot(){const r=spawnSync(git,['-C',repo,'ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8',windowsHide:true,timeout:15000});if(r.status!==0)throw Error('Git source inspection failed');return [...new Set(r.stdout.split('\0').filter(Boolean))].sort().filter(f=>fs.existsSync(join(repo,f))&&fs.statSync(join(repo,f)).isFile()).map(f=>({file:f,sha256:sha(fs.readFileSync(join(repo,f)))}));}
const head=gitRun(['rev-parse','HEAD']),dirty=gitRun(['status','--porcelain']),sources=snapshot();
const sourceDigest=sha(Buffer.from(JSON.stringify(sources))),pkg=JSON.parse(fs.readFileSync(join(app,'package.json'))),lock=JSON.parse(fs.readFileSync(join(app,'package-lock.json')));
const env={...process.env,PATH:join(out,'bin')+';'+join(app,'node_modules/.bin')+';'+dirname(process.execPath)+';'+process.env.PATH,CSC_IDENTITY_AUTO_DISCOVERY:'false'};
for(const key of Object.keys(env))if(/^CSC_|^WIN_CSC_|^ELECTRON_RUN_AS_NODE$/.test(key)&&key!=='CSC_IDENTITY_AUTO_DISCOVERY')delete env[key];
fs.mkdirSync(join(out,'bin'));const npmCli=value('--npm-cli');if(npmCli){if(!fs.existsSync(npmCli))throw Error('npm CLI missing');fs.writeFileSync(join(out,'bin/npm.cmd'),`@"${process.execPath}" "${resolve(npmCli)}" %*\r\n`);}
const report={head,dirty:!!dirty,sourceDigest,sources,environment:{platform:process.platform,os:os.release(),arch:process.arch,node:process.version},packageSha256:sha(fs.readFileSync(join(app,'package.json'))),lockSha256:sha(fs.readFileSync(join(app,'package-lock.json'))),steps,unverified:['second real Windows device pairing/sync','paid real model endpoints: no supplied key','historical 0.1.1 installer upgrade','other Windows/Office versions','independent review'],releaseReady:false};
function save(){fs.writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));}
function execute(label,file,args,extra={},timeout=1200000,cwd=app){
 const log=join(out,label+'.txt'),fd=fs.openSync(log,'wx'),started=new Date().toISOString();let r;
 try{r=spawnSync(file,args,{cwd,env:{...env,...extra},stdio:['ignore',fd,fd],windowsHide:true,timeout});}finally{fs.closeSync(fd);}
 const step={label,file,args,cwd,started,ended:new Date().toISOString(),exit:r.status,error:r.error?.message??null,status:r.status===0&&!r.error?'PASS':'FAIL',log};steps.push(step);save();console.log(label+' '+step.status+' exit='+r.status);return step;
}
const electron=join(app,'node_modules/electron/dist/electron.exe'),nodeEnv={ELECTRON_RUN_AS_NODE:'1'};
const native=execute('native-abi',electron,['-e',"const D=require('better-sqlite3');const db=new D(':memory:');const row=db.prepare('select 1 as ok').get();db.close();require('@napi-rs/keyring');console.log(JSON.stringify({node:process.version,electron:process.versions.electron,abi:process.versions.modules,sqlite:row.ok,keyringLoaded:true}));"],nodeEnv,30000);
const versions=Object.keys({...pkg.dependencies,...pkg.devDependencies}).map(name=>{const expected=lock.packages['node_modules/'+name]?.version;let actual;try{actual=JSON.parse(fs.readFileSync(join(app,'node_modules',name,'package.json'))).version;}catch{}return {name,expected,actual,match:expected===actual};});
fs.writeFileSync(join(out,'locked-direct-dependencies.json'),JSON.stringify(versions,null,2));steps.push({label:'locked-direct-dependencies',status:versions.every(v=>v.match)?'PASS':'FAIL',exit:versions.every(v=>v.match)?0:1});save();
if(native.status==='PASS'){
 execute('full',electron,['node_modules/vitest/vitest.mjs','run','--maxWorkers=4','--reporter=default','--reporter=json','--outputFile.json='+join(out,'vitest.json')],{...nodeEnv,DESKMINIS_TEST_CLIPBOARD:'1'});
 if(fs.existsSync(join(out,'vitest.json'))){const j=JSON.parse(fs.readFileSync(join(out,'vitest.json')));report.tests={success:j.success,files:j.testResults.length,suites:j.numTotalTestSuites,passed:j.numPassedTests,failed:j.numFailedTests,skipped:j.numPendingTests,total:j.numTotalTests};}
}else steps.push({label:'full',status:'UNVERIFIED',reason:'native ABI unavailable'});
execute('typecheck',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json']);
execute('build',process.execPath,['node_modules/electron-vite/bin/electron-vite.js','build']);
const unchanged=gitRun(['rev-parse','HEAD'])===head&&sha(Buffer.from(JSON.stringify(snapshot())))===sourceDigest;
steps.push({label:'source-unchanged',status:unchanged?'PASS':'FAIL',exit:unchanged?0:1});save();
if(has('--install')&&!has('--package')){steps.push({label:'installer-selection',status:'FAIL',reason:'--install requires --package'});}
if(has('--package')){
 if(dirty||steps.some(s=>s.status==='FAIL'))steps.push({label:'package',status:'FAIL',reason:'Requires clean reviewed checkout and passing source/native checks'});
 else{
  const dist=join(out,'dist'),packageStage=preparePackageStage(app,value('--package-stage')??join(out,'build-repo'));report.packageStage=packageStage;save();
  execute('package',process.execPath,[join(packageStage.stagedApp,'node_modules/electron-builder/cli.js'),'--win','--x64','--publish','never','--config.directories.output='+dist],{},1800000,packageStage.stagedApp);
  if(steps.at(-1).status==='PASS'){
   execute('release-files',process.execPath,['scripts/verify-release.mjs','--dist',dist]);
   execute('package-binding',process.execPath,['scripts/windows-package-binding.mjs','--dist',dist,'--head',head,'--output',join(out,'package-binding.json')]);
   execute('package-composition',process.execPath,['scripts/windows-package-composition.mjs','--dist',dist,'--output',join(out,'package-composition.json')]);
   if(fs.existsSync(join(out,'package-composition.json')))report.packageComposition=JSON.parse(fs.readFileSync(join(out,'package-composition.json'),'utf8'));
   if(!steps.some(s=>s.status==='FAIL'))execute('m5-packaging',process.execPath,['scripts/e2e-m5-packaging.mjs'],{DESKMINIS_M5_UNPACKED:join(dist,'win-unpacked'),DESKMINIS_M5_SETUP:has('--install')?join(dist,`DeskMinis-${pkg.version}-Setup.exe`):join(out,'not-requested.exe'),DESKMINIS_M5_PROBE_DIR:join(out,'packaged-behavior')});
   report.artifacts=fs.readdirSync(dist).filter(f=>fs.statSync(join(dist,f)).isFile()).map(file=>({file,sha256:sha(fs.readFileSync(join(dist,file))),size:fs.statSync(join(dist,file)).size}));
   if(!has('--install'))report.unverified.push('temporary installer run was not selected');
  }
 }
}else report.unverified.push('package and installer not selected in this run');
report.sourceUnchangedAtEnd=gitRun(['rev-parse','HEAD'])===head&&sha(Buffer.from(JSON.stringify(snapshot())))===sourceDigest;steps.push({label:'source-unchanged-at-end',status:report.sourceUnchangedAtEnd?'PASS':'FAIL',exit:report.sourceUnchangedAtEnd?0:1});
report.automatedPassed=!steps.some(s=>s.status==='FAIL');save();console.log(JSON.stringify({head,sourceDigest,automatedPassed:report.automatedPassed,releaseReady:false,evidence:out}));process.exit(report.automatedPassed?0:1);
