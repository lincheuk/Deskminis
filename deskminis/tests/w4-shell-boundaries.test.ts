import {it,expect,vi,afterEach} from 'vitest';
import {classifyShellCommand,PermissionGatewayImpl} from '../src/minisd/tools/permissions';
import {makeShellTool,ShellManager} from '../src/minisd/tools/shell';import {MinisPaths} from '../src/minisd/paths';
const gated=[String.raw`Get-Content ..\minis.db`,String.raw`type './..'\secret`,'dir ..','rg foo ../private',
 String.raw`gci $HOME\Documents`,String.raw`type '$HO'"ME"\secret`,String.raw`dir ~\docs`,String.raw`rg foo ~/docs`,String.raw`dir %USERPROFILE%\docs`,String.raw`type C:\appDATA\x`,String.raw`Get-Content C:\App'Da'ta\x`,
 String.raw`type DESKMI~1\minis.db`,String.raw`gci PROGRA~1/`,String.raw`Get-Content PROGRA'~'1./x`,String.raw`dir C:\*\data`,String.raw`rg foo src?\child`,String.raw`gci 'src*'\child`];
gated.push('Get-Content -Path:..', String.raw`dir C:..\private`, String.raw`dir "C:\My * Projects\child"`, String.raw`gci 'C:\My ? Projects'\child`);
const readonly=['dir','rg foo src','git status','Get-Content README.md','dir *.ts',String.raw`rg foo src\*.ts`,'git log HEAD~1','git log main..feature','git diff HEAD~2',String.raw`rg '*.ts' src\file.ts`];
it.each(gated)('%s falls back to ask-once; full still allows',async command=>{
 expect(classifyShellCommand(command)).toBe('gated');const asked=vi.fn(async()=> 'allow-once' as const);const gw=new PermissionGatewayImpl(asked);const req={kind:'shell' as const,detail:command,sessionId:'S',toolTitle:'test'};
 expect(await gw.check(req)).toBe('allow');expect(await gw.check(req)).toBe('allow');expect(asked).toHaveBeenCalledTimes(2);asked.mockClear();gw.applyPreset('full');expect(await gw.check(req)).toBe('allow');expect(asked).not.toHaveBeenCalled();
});
it.each(readonly)('%s remains readonly without asking',async command=>{expect(classifyShellCommand(command)).toBe('readonly');const asked=vi.fn(async()=> 'deny' as const);expect(await new PermissionGatewayImpl(asked).check({kind:'shell',detail:command,sessionId:'S',toolTitle:'test'})).toBe('allow');expect(asked).not.toHaveBeenCalled();});
afterEach(()=>vi.restoreAllMocks());
it.each([[0,1],[-5,1],[0.5,1],[3601,3600],[3600,3600],[1,1],[NaN,120],[Infinity,120],[-Infinity,120],[undefined,120]] as const)('timeout %s uses actual %s seconds with adjustment notice',async(requested,seconds)=>{
 const manager=new ShellManager();const run=vi.spyOn(manager,'run').mockResolvedValue({output:'result',exitCode:0,durationMs:7});
 const input:any={command:'dir',tool_title:'test'};if(requested!==undefined)input.timeout_seconds=requested;
 const tool=makeShellTool(manager);const r=await tool.execute(input,{sessionId:'S',paths:new MinisPaths('synthetic'),permissions:new PermissionGatewayImpl(async()=> 'deny')});
 expect(run).toHaveBeenCalledWith('S',expect.any(String),'dir',seconds*1000,undefined);expect(r.success).toBe(true);
 if(requested!==undefined&&requested!==seconds){expect(r.output.startsWith('timeout_seconds='+String(requested))).toBe(true);expect(r.output.split('\n')[0]).toContain('已按 '+seconds+' 秒执行');}
 else expect(r.output).toBe('result\n[exit=0, 7ms]');await manager.disposeAll();
});
