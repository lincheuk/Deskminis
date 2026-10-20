import fs from 'node:fs';import {join,resolve,dirname,normalize} from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..'),sha=b=>createHash('sha256').update(b).digest('hex');
const asar=createRequire(join(app,'package.json'))('@electron/asar');
function walk(root,prefix=''){return fs.readdirSync(join(root,prefix),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(root,join(prefix,e.name)):[join(prefix,e.name).replace(/\\/g,'/')]).sort();}
export function verifyPackageBinding(application,resources,extract=asar.extractFile,list=asar.listPackage,stat=asar.statFile){
 const archive=join(resources,'app.asar'),records=[],check=(file,source,actual)=>{records.push({file,sha256:sha(source),packagedSha256:sha(actual),size:source.length,match:source.equals(actual)});};
 const expected=walk(join(application,'out')).map(f=>'out/'+f),actual=list(archive).map(f=>f.replace(/^[/\\]+/,'').replace(/\\/g,'/')).filter(f=>f.startsWith('out/')&&!stat(archive,normalize(f)).files).sort();
 if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Packaged build output file set differs');
 for(const file of [...expected,...walk(join(application,'resources')).map(f=>'resources/'+f)])check(file,fs.readFileSync(join(application,file)),extract(archive,normalize(file)));
 for(const [source,dest]of [['src/minisd/bridge-cli.mjs','bridge-cli.mjs'],['scripts/bridge-node.cmd','bridge-node.cmd'],['../LICENSE','LICENSE.txt'],['../THIRD-PARTY-NOTICES.md','THIRD-PARTY-NOTICES.md']])check(dest,fs.readFileSync(join(application,source)),fs.readFileSync(join(resources,dest)));
 const sourcePackage=JSON.parse(fs.readFileSync(join(application,'package.json'),'utf8')),packagedPackage=JSON.parse(extract(archive,'package.json').toString('utf8'));
 for(const field of ['name','version','main','dependencies'])if(JSON.stringify(sourcePackage[field])!==JSON.stringify(packagedPackage[field]))throw Error('Packaged metadata differs: '+field);
 return {ok:records.every(r=>r.match),records,asarSha256:sha(fs.readFileSync(archive)),metadataMatched:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const arg=k=>{const i=process.argv.indexOf(k);return i<0?undefined:process.argv[i+1];},dist=arg('--dist'),head=arg('--head'),output=arg('--output');if(!dist||!head||!output||fs.existsSync(output))throw Error('New --output, --dist and --head required');
 const git=process.env.DESKMINIS_VERIFY_GIT??'git',current=spawnSync(git,['-C',resolve(app,'..'),'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true});if(current.status!==0||current.stdout.trim()!==head)throw Error('Source HEAD changed');
 const proof={head,...verifyPackageBinding(app,join(resolve(dist),'win-unpacked/resources'))};fs.writeFileSync(output,JSON.stringify(proof,null,2));console.log(JSON.stringify({head,ok:proof.ok,files:proof.records.length,asarSha256:proof.asarSha256}));process.exit(proof.ok?0:1);
}
