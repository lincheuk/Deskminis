import {resolve} from 'node:path';
/** A zero exit alone cannot prove that the expected packaged acceptance actually ran. */
export function packagedProbeVerdict(result,proof,expectedExe){
  const no=reason=>({ok:false,reason});
  if(!result||result.error||result.signal||result.status!==0)return no('Packaged probe process failed');
  if(proof?.status!=='PASS'||!Array.isArray(proof.checks)||proof.checks.some(c=>c?.ok!==true))return no('Packaged proof missing, failed or incomplete');
  const required=['actual-utilityProcess','cron-create-fields','cron-edit','cron-clear','cron-clear-persisted','docx-actual-write','docx-actual-reload','xlsx-actual-write','xlsx-actual-reload','pptx-actual-write','pptx-actual-reload','catastrophic-regex-cancel','engine-rpc-during-regex','no-network-before-approval','network-after-approval','network-command-success','main-kill-utility-exits'];
  if(!required.every(id=>proof.checks.filter(c=>c.id===id).length===1))return no('Expected packaged behaviors were not all executed exactly once');
  const a=proof.application;
  if(typeof a?.executable!=='string'||resolve(a.executable).toLowerCase()!==resolve(expectedExe).toLowerCase()||!a.temporaryUserData||!a.temporaryData||a.host!=='h3'||!Number.isInteger(a.mainPid)||!Number.isInteger(a.utilityPid)||a.mainPid===a.utilityPid||!Number.isFinite(a.utilityExit?.exitedUtc))return no('Actual isolated utilityProcess identity or exit proof missing');
  if(!Array.isArray(proof.artifacts)||proof.artifacts.length!==3||!['docx','xlsx','pptx'].every(ext=>proof.artifacts.filter(v=>v.ext===ext&&/^[a-f0-9]{64}$/.test(v.sha256)&&v.size>0).length===1))return no('Office artifact evidence missing');
  if(!Array.isArray(proof.cleanup)||proof.cleanup.length)return no('Probe required cleanup intervention or left processes unresolved');
  return {ok:true,reason:'17 packaged behavior checks and observed process exit passed'};
}
