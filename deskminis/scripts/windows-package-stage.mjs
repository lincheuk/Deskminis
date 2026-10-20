import fs from 'node:fs';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';
/** npm Arborist treats a node_modules junction as a linked dependency graph. Package from a physical copy. */
export function preparePackageStage(app,stage){
 const root=resolve(stage);if(fs.existsSync(root))throw Error('Package stage must be a new directory');fs.mkdirSync(root,{recursive:true});const stagedApp=join(root,'deskminis'),records=[],sha=b=>createHash('sha256').update(b).digest('hex');fs.mkdirSync(stagedApp);
 const copy=(source,dest)=>{if(fs.lstatSync(source).isDirectory()){for(const entry of fs.readdirSync(source))copy(join(source,entry),join(dest,entry));}else{if(fs.lstatSync(source).isSymbolicLink())throw Error('Source packaging input is a link: '+source);fs.mkdirSync(resolve(dest,'..'),{recursive:true});const bytes=fs.readFileSync(source);fs.writeFileSync(dest,bytes);records.push({source,dest,sha256:sha(bytes),size:bytes.length});}};
 for(const file of ['package.json','package-lock.json','electron-builder.yml','out','resources','build','src/minisd/bridge-cli.mjs','scripts/bridge-node.cmd'])copy(join(app,file),join(stagedApp,file));
 for(const file of ['LICENSE','THIRD-PARTY-NOTICES.md'])copy(join(app,'..',file),join(root,file));
 const originalDependencies=fs.realpathSync(join(app,'node_modules')),dependencies=join(stagedApp,'node_modules');fs.cpSync(originalDependencies,dependencies,{recursive:true,dereference:false});
 if(fs.lstatSync(dependencies).isSymbolicLink()||fs.realpathSync(dependencies).toLowerCase()!==dependencies.toLowerCase())throw Error('Package stage dependencies are not physical');
 return {stagedApp,originalDependencies,physicalDependencies:true,records};
}
