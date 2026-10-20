import {it,expect} from 'vitest';import fs from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const asar=createRequire(join(__dirname,'../package.json'))('@electron/asar'),load=()=>import(pathToFileURL(join(__dirname,'../scripts/windows-package-binding.mjs')).href);
it.each(['valid','code-tamper','bridge-tamper','missing-code','added-code','version-tamper'])('F12 verifies actual ASAR package bytes: %s',async scenario=>{
 const runtime=process as any,previousNoAsar=runtime.noAsar;runtime.noAsar=true;
 const root=fs.mkdtempSync(join(tmpdir(),'dm-f12-binding-')),app=join(root,'repo/deskminis'),staged=join(root,'archive-input'),resources=join(root,'package/resources'),archive=join(resources,'app.asar');
 const write=(path:string,data:string)=>{fs.mkdirSync(join(path,'..'),{recursive:true});fs.writeFileSync(path,data);};
 try{
  const pkg=JSON.stringify({name:'deskminis',version:'0.3.0',main:'out/main/index.js',dependencies:{'better-sqlite3':'^12.0.0'}});
  for(const file of ['out/main/index.js','out/main/minisd.js','out/renderer/index.html','resources/tray.png','package.json']){const bytes=file==='package.json'?pkg:'fixed:'+file;write(join(app,file),bytes);write(join(staged,file),bytes);}
  for(const [source,dest]of [['src/minisd/bridge-cli.mjs','bridge-cli.mjs'],['scripts/bridge-node.cmd','bridge-node.cmd'],['../LICENSE','LICENSE.txt'],['../THIRD-PARTY-NOTICES.md','THIRD-PARTY-NOTICES.md']]){write(join(app,source),'fixed:'+source);write(join(resources,dest),'fixed:'+source);}
  if(scenario==='code-tamper')write(join(staged,'out/main/minisd.js'),'different behavior');
  if(scenario==='bridge-tamper')write(join(resources,'bridge-node.cmd'),'wrong bridge');
  if(scenario==='missing-code')fs.unlinkSync(join(staged,'out/main/minisd.js'));
  if(scenario==='added-code')write(join(staged,'out/main/extra.js'),'unexpected code');
  if(scenario==='version-tamper')write(join(staged,'package.json'),pkg.replace('0.3.0','0.1.1'));
  await asar.createPackage(staged,archive);const m=await load();
  if(['missing-code','added-code','version-tamper'].includes(scenario))expect(()=>m.verifyPackageBinding(app,resources)).toThrow(/differs/);
  else expect(m.verifyPackageBinding(app,resources).ok).toBe(scenario==='valid');
 }finally{try{const resolved=resolve(root);if(!resolved.startsWith(resolve(tmpdir())+'\\'))throw Error('Unsafe fixture cleanup');fs.rmSync(resolved,{recursive:true,force:true});}finally{runtime.noAsar=previousNoAsar;}}
});
