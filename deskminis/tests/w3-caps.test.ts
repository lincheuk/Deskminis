/** W3复核留下的两个反例；只测现有真实管理器。 */
import {expect,it} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpManager} from '../src/minisd/mcp/manager';
import {McpServersStore} from '../src/minisd/mcp/config';
import {MinisPaths} from '../src/minisd/paths';
import {ToolRegistry} from '../src/minisd/tools/registry';
import {ChatStore} from '../src/minisd/store/chat-store';
import {openDb} from '../src/minisd/store/db';
const info=(name:string)=>({name,inputSchema:{type:'object',properties:{}}});
const names=(prefix:string,n:number)=>Array.from({length:n},(_,i)=>prefix+String(i).padStart(2,'0'));
function reserve(registry:ToolRegistry,name:string){registry.register({definition:{name,description:'synthetic collision',parameters:{},required:[]},execute:async()=>({success:true,output:'ok'})});}

it('两台两原因合计只列30个名字，后组保留等N个',async()=>{
  const db=openDb(':memory:'),chat=new ChatStore(db),sid=chat.createSession().id;
  const store=new McpServersStore(new MinisPaths(mkdtempSync(join(tmpdir(),'dm-w3-total-')))),registry=new ToolRegistry();
  const lists:Record<string,string[]>={};
  for(const server of['alpha','bravo']){
    store.upsert({name:server,command:'synthetic',enabled:true});
    const collisions=names(server+'_collision_',8);for(const n of collisions)reserve(registry,'mcp__'+server+'__'+n);
    lists[server]=[...names(server+'_load_',40),...collisions,...names(server+'_limit_',10)];
  }
  const mgr=new McpManager({store,chatStore:chat,registry,factories:e=>({closed:false,onNotification:undefined,connect:async()=>{},dispose:()=>{},callTool:async()=>({}),listTools:async()=>lists[e.name].map(info)})});
  try{
    await mgr.ensureForRun();for(const s of mgr.statuses())expect(s).toMatchObject({toolCount:40,truncated:18,limitSkipped:expect.arrayContaining(names(s.name+'_limit_',10)),collisionSkipped:expect.arrayContaining(names(s.name+'_collision_',8))});
    const block=mgr.omissionBlock(sid),listed=[...block.matchAll(/"((?:alpha|bravo)_(?:limit|collision)_\d+)"/g)].map(m=>m[1]);
    expect(listed).toEqual([...names('alpha_limit_',10),...names('alpha_collision_',8),...names('bravo_limit_',10),...names('bravo_collision_',2)]);
    expect(listed).toHaveLength(30);expect(block).toContain('等 8 个');expect(block).not.toContain('"bravo_collision_02"');
  }finally{await mgr.disposeAll();db.close();}
});

it('同时重名且超每台40时，只记重名不记上限',async()=>{
  const db=openDb(':memory:'),store=new McpServersStore(new MinisPaths(mkdtempSync(join(tmpdir(),'dm-w3-order-')))),registry=new ToolRegistry();
  store.upsert({name:'alpha',command:'synthetic',enabled:true});reserve(registry,'mcp__alpha__collision');
  const mgr=new McpManager({store,chatStore:new ChatStore(db),registry,factories:()=>({closed:false,onNotification:undefined,connect:async()=>{},dispose:()=>{},callTool:async()=>({}),listTools:async()=>[...names('loaded_',40),'collision','limit'].map(info)})});
  try{await mgr.ensureForRun();expect(mgr.statuses()[0]).toMatchObject({toolCount:40,truncated:2,collisionSkipped:['collision'],limitSkipped:['limit']});}finally{await mgr.disposeAll();db.close();}
});
