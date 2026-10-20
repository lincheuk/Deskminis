/** Read-only guards for the temporary NSIS acceptance run. Never remove a pre-existing installation. */
import {spawnSync} from 'node:child_process';
import {resolve,isAbsolute,join} from 'node:path';
export function readInstallations(guid,spawn=spawnSync){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guid))return {state:'unknown',reason:'invalid installer identity',entries:[]};
  const ps=process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe';
  const code=`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$items=@()
try {
  foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
      $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
      try {
        foreach($path in @('Software\\${guid}','Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}')) {
          $key=$base.OpenSubKey($path,$false)
          if($null -ne $key) {
            try {
              $items+=@{hive=[string]$hive;view=[string]$view;key=$path;kind=$(if($path -like '*\\Uninstall\\*'){'uninstall'}else{'installation'});location=[string]$key.GetValue('InstallLocation','');uninstallString=[string]$key.GetValue('UninstallString','')}
            } finally { $key.Dispose() }
          }
        }
      } finally { $base.Dispose() }
    }
  }
  $running=@(Get-CimInstance Win32_Process -Filter "Name='DeskMinis.exe'" | ForEach-Object { [int]$_.ProcessId })
  @{state='known';entries=@($items);running=@($running)} | ConvertTo-Json -Compress -Depth 5
} catch {
  @{state='unknown';reason=[string]$_.Exception.Message;entries=@($items)} | ConvertTo-Json -Compress -Depth 5
  exit 2
}`;
  const r=spawn(ps,['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1024*1024});
  if(!r||r.error||r.signal||r.status!==0)return {state:'unknown',reason:r?.error?.message??'registry inspection failed',entries:[]};
  try{const j=JSON.parse(r.stdout.replace(/^\uFEFF/,''));if(j.state!=='known'||!Array.isArray(j.entries)||!Array.isArray(j.running))throw Error('shape');return j;}catch{return {state:'unknown',reason:'registry inspection returned no reliable result',entries:[]};}
}
export function mayInstall(snapshot){
  if(snapshot?.state!=='known'||!Array.isArray(snapshot.entries)||!Array.isArray(snapshot.running))return {ok:false,reason:'Cannot inspect existing installation; no installer was started'};
  return snapshot.entries.length||snapshot.running.length?{ok:false,reason:'Existing installation registration or running DeskMinis found; no installer was started'}:{ok:true};
}
export function mayUninstall(snapshot,expectedDir){
  if(snapshot?.state!=='known'||!Array.isArray(snapshot.entries)||!snapshot.entries.length||!Array.isArray(snapshot.running)||snapshot.running.length)return {ok:false,reason:'Cannot prove temporary installation ownership, or DeskMinis is running; no uninstaller was started'};
  if(typeof expectedDir!=='string'||!isAbsolute(expectedDir))return {ok:false,reason:'Expected temporary installation must be an absolute path'};
  const same=p=>typeof p==='string'&&isAbsolute(p)&&resolve(p).toLowerCase()===resolve(expectedDir).toLowerCase();
  const expectedUninstaller=join(expectedDir,'Uninstall DeskMinis.exe');
  const ownEntry=e=>{if(!e)return false;if(e.kind===undefined||e.kind==='installation')return same(e.location);if(e.kind!=='uninstall')return false;const match=typeof e.uninstallString==='string'?/^"([^"]+)"(?:\s+\/(?:currentuser|allusers|S))*\s*$/i.exec(e.uninstallString):null;return (!e.location||same(e.location))&&!!match&&isAbsolute(match[1])&&resolve(match[1]).toLowerCase()===resolve(expectedUninstaller).toLowerCase();};
  const locationKnown=snapshot.entries.some(e=>e&&e.kind!=='uninstall'&&same(e.location));
  return locationKnown&&snapshot.entries.every(ownEntry)?{ok:true}:{ok:false,reason:'Registration no longer points to this temporary installation; no uninstaller was started'};
}
