import {it,expect} from 'vitest';import fs from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';
const load=()=>import(pathToFileURL(join(__dirname,'../scripts/windows-package-stage.mjs')).href);
it('F12 packaging copies a junction target into an independent physical dependency tree',async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),'dm-f12-stage-')),app=join(root,'source/deskminis'),deps=join(root,'locked-deps'),link=join(app,'node_modules');const write=(path:string,bytes:string)=>{fs.mkdirSync(resolve(path,'..'),{recursive:true});fs.writeFileSync(path,bytes);};
 try{
  for(const f of ['package.json','package-lock.json','electron-builder.yml','out/main/minisd.js','resources/tray.png','build/icon.ico','src/minisd/bridge-cli.mjs','scripts/bridge-node.cmd'])write(join(app,f),'fixed:'+f);
  for(const f of ['LICENSE','THIRD-PARTY-NOTICES.md'])write(join(app,'..',f),'fixed:'+f);
  write(join(deps,'dummy/package.json'),'version from locked installation');fs.symlinkSync(deps,link,'junction');
  const m=await load(),p=m.preparePackageStage(app,join(root,'stage')),copied=join(p.stagedApp,'node_modules/dummy/package.json');
  expect(fs.lstatSync(join(p.stagedApp,'node_modules')).isSymbolicLink()).toBe(false);expect(fs.readFileSync(copied,'utf8')).toBe('version from locked installation');
  fs.writeFileSync(join(deps,'dummy/package.json'),'original dependency changed');expect(fs.readFileSync(copied,'utf8')).toBe('version from locked installation');
  expect(fs.readFileSync(join(p.stagedApp,'out/main/minisd.js'),'utf8')).toBe('fixed:out/main/minisd.js');
  expect(()=>m.preparePackageStage(app,join(root,'stage'))).toThrow(/new directory/);
 }finally{if(fs.existsSync(link)&&fs.lstatSync(link).isSymbolicLink())fs.rmdirSync(link);if(!resolve(root).startsWith(resolve(tmpdir())+'\\'))throw Error('Unsafe cleanup');fs.rmSync(root,{recursive:true,force:true});}
});
