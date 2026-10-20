import {describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentMessage,ContentPart,RawMessage} from '../src/shared/types';
import {userPartWithOrigin,carryInputOrigin,verbatimUserTextPart,fullyCoveredInputIds,observeInputRequest} from '../src/minisd/agent/input-provenance';
import {toAgentMessage} from '../src/minisd/agent/agent-message';
import {buildRequestMessages,flattenToolHistory,shapeMessagesForSlot} from '../src/minisd/agent/loop';
import {previewSummaryMessage} from '../src/minisd/agent/compact';
import {buildAnthropicBody} from '../src/minisd/providers/anthropic';
import {buildOpenAIBody} from '../src/minisd/providers/openai';
import {buildGeminiBody} from '../src/minisd/providers/gemini';
import {Gate} from './scheduler-fixture';

const raw=(id:string,parts:ContentPart[],at=1):RawMessage=>({id,sessionId:'S',role:'user',parts,createdAt:at,updatedAt:at,sortOrder:at,streamInterruptCount:0});
const message=(parts:ContentPart[]):AgentMessage=>({role:'user',parts});
const ids=(messages:AgentMessage[])=>[...fullyCoveredInputIds(messages)].sort();
describe('F07 request provenance',()=>{
  it('P1 same text and even a shared raw part object cannot borrow another message identity',()=>{
    const shared:ContentPart={type:'text',value:'same text'};
    const a=raw('a',[shared]),b=raw('b',[shared]);const pa=userPartWithOrigin(a,0),pb=userPartWithOrigin(b,0);
    expect(pa).not.toBe(pb);expect(ids([message([pa])])).toEqual(['a']);expect(ids([message([pb])])).toEqual(['b']);
    expect(ids([message([{type:'text',value:'same text'}])])).toEqual([]);
    expect(JSON.stringify(message([pa]))).toBe('{"role":"user","parts":[{"type":"text","value":"same text"}]}');
  });
  it('P2 receipt requires all original parts; missing/placeholder images never complete a text+image input',()=>{
    const r=raw('a',[{type:'text',value:'read this'},{type:'mediaRef',value:{id:'img',relativePath:'attachments/a.png',mimeType:'image/png'}}]);
    const t=userPartWithOrigin(r,0),image=userPartWithOrigin(r,1);
    expect(ids([message([t])])).toEqual([]);
    expect(ids([message([t,{type:'text',value:'[image omitted]'}])])).toEqual([]);
    expect(ids([message([t,carryInputOrigin(image,{type:'imageData',value:{mimeType:'image/png',base64:'aGVsbG8='}})])])).toEqual(['a']);
  });
  it('P3 F03 verbatim carried turns retain distinct full-source coverage; invented summary text proves none',()=>{
    const history=[raw('old',[{type:'text',value:'older instruction'}],1),raw('a',[{type:'text',value:'first\nline'}],2),raw('b',[{type:'text',value:'same'}],3),raw('c',[{type:'text',value:'same'}],4)];
    const carried=previewSummaryMessage(history,3,undefined);
    expect(ids([carried])).toEqual(['a','b','c']);expect(ids([message([{type:'text',value:'summary mentions older instruction'}])])).toEqual([]);
    const images=raw('img',[{type:'text',value:'caption'},{type:'mediaRef',value:{id:'i',relativePath:'attachments/i.png',mimeType:'image/png'}}]);
    expect(ids([message([verbatimUserTextPart(images,'prefix\n')])])).toEqual([]);
  });
  it('P4 actual image synthesis carries source, missing files/header previews/capability placeholders do not',()=>{
    const root=mkdtempSync(join(tmpdir(),'dm-f07-p4-'));
    writeFileSync(join(root,'ok.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9hUAAAAASUVORK5CYII=','base64'));
    const r=raw('img',[{type:'text',value:'caption'},{type:'mediaRef',value:{id:'i',relativePath:'ok.png',mimeType:'image/png'}}]);
    const input=[toAgentMessage(r)],resolve=(rel:string)=>join(root,rel);
    const full=buildRequestMessages(input,new Map(),resolve);
    expect(ids(full)).toEqual(['img']);expect(ids(buildRequestMessages(input,new Map(),()=>join(root,'missing.png')))).toEqual([]);
    expect(ids(buildRequestMessages(input,new Map(),resolve,{headerOnly:true}))).toEqual([]);
    expect(ids(shapeMessagesForSlot(full,{imagePlaceholder:true,sendTools:true},'no-image'))).toEqual([]);
    expect(r.parts[1].type).toBe('mediaRef');
  });
  it('P5 flatten separators preserve whole original text and all three real protocol builders send it',()=>{
    const r=raw('a',[{type:'text',value:'first input'},{type:'toolResult',value:{toolUseId:'x',output:'result',success:true,status:'success'}},{type:'text',value:'second\ninput'}]);
    // Only real user text parts can be inputs; include a fully sourced second message after a tool result.
    const a=raw('b',[{type:'text',value:'second\ninput'}]);const t=toAgentMessage(a).parts[0];
    const flattened=flattenToolHistory([message([{type:'toolResult',value:{toolUseId:'x',output:'result',success:true,status:'success'}},t])]);
    expect(ids(flattened)).toEqual(['b']);expect(flattened[0].parts[1].value).toBe('\nsecond\ninput');
    const req={messages:flattened,tools:[],maxTokens:100,thinkingLevel:'off' as const};
    for(const body of [buildAnthropicBody(req,'claude'),buildOpenAIBody(req,'gpt'),buildGeminiBody(req,'gemini')]){
      const json=JSON.stringify(body);expect(json).toContain('second\\ninput');expect(json).not.toContain('messageId');expect(json).not.toContain('historyMessageId');
    }
    expect(ids([toAgentMessage(r)])).toEqual([]); // tool result is not falsely treated as fully carried raw input
  });
  it('P6 creating or starting a pending iterator does not confirm receipt before the first result',async()=>{
    const gate=new Gate();let requests=0,receipts=0;
    const source={async *[Symbol.asyncIterator](){requests++;await gate.opened;yield 'first';}};
    const wrapped=observeInputRequest(source,()=>receipts++);const it=wrapped[Symbol.asyncIterator]();
    expect(requests).toBe(0);const pending=it.next();expect(requests).toBe(1);expect(receipts).toBe(0);
    gate.open();expect(await pending).toEqual({done:false,value:'first'});expect(receipts).toBe(1);
    await it.next();expect(receipts).toBe(1);
  });
  it('P7 synchronous/startup rejection and cancellation leave delivery unconfirmed',async()=>{
    let receipts=0;
    const failing={async *[Symbol.asyncIterator](){throw Error('before response');yield 'never';}};
    await expect(observeInputRequest(failing,()=>receipts++)[Symbol.asyncIterator]().next()).rejects.toThrow('before response');
    const c=new AbortController(),g=new Gate();
    const pending=observeInputRequest({async *[Symbol.asyncIterator](){await g.opened;yield 'late';}},()=>receipts++,c.signal)[Symbol.asyncIterator]().next();
    c.abort();g.open();await pending;expect(receipts).toBe(0);
  });
  it('P8 observer failure neither retries nor suppresses content and early return closes the original reader',async()=>{
    let starts=0,closed=0;
    const source={async *[Symbol.asyncIterator](){starts++;try{yield 'first';yield 'second';}finally{closed++;}}};
    const it=observeInputRequest(source,()=>{throw Error('receipt storage failed');})[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({done:false,value:'first'});await it.return!();expect(starts).toBe(1);expect(closed).toBe(1);
  });
  it('P9 return/throw reaches the original iterator without creating a second stream',async()=>{
    let throws=0,returns=0,created=0;
    const source={ [Symbol.asyncIterator](){created++;return {async next(){return {done:false,value:'v'};},async return(){returns++;return {done:true,value:''};},async throw(){throws++;return {done:true,value:'handled'};}};}};
    const it=observeInputRequest(source,()=>{})[Symbol.asyncIterator]();await it.next();expect(await it.throw!(Error('x'))).toEqual({done:true,value:'handled'});
    await it.return!();expect({throws,returns,created}).toEqual({throws:1,returns:1,created:1});
  });
});
