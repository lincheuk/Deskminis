import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {buildDocx, buildXlsx, buildPptx} from '../src/minisd/office/build';
import {writeZip, readZip, listZipSync, readZipEntrySync, ZipSyncError, ZIP_MAX_ENTRIES} from '../src/minisd/office/zip';

const one = () => writeZip([{path:'test.xml',data:Buffer.from('汉字 '.repeat(1000))}]);
const central = (b: Buffer) => b.readUInt32LE(b.length-6);
describe('T7 bounded synchronous ZIP inspection', () => {
  const cases: [string,()=>Buffer][] = [
    ['docx',()=>buildDocx({blocks:[]})],['xlsx',()=>buildXlsx({sheets:[{name:'空表',rows:[]}]})],['pptx',()=>buildPptx({slides:[{title:""}]})],
    ['manual',()=>writeZip([{path:'dir/',data:Buffer.alloc(0)},{path:'a.xml',data:Buffer.from('XML')},{path:'b.bin',data:Buffer.from([0,1,255])}])],
    ...['foreign-word','deskminis-resaved'].map(name => [name,()=>readFileSync(join(__dirname,`fixtures/office/${name}.docx`))] as [string,()=>Buffer]),
  ];
  it.each(cases)('%s: central names and every decoded byte match the asynchronous reader', async (_, make) => {
    const bytes=make(), asyncParts=await readZip(bytes), entries=listZipSync(bytes);
    expect(entries.map(e=>e.name).sort()).toEqual([...asyncParts.keys()].sort());
    for(const e of entries) expect(readZipEntrySync(bytes,e,64*1024*1024),e.name).toEqual(asyncParts.get(e.name));
  });
  it('uses central sizes for descriptor entries and local extra length for the data start',()=>{
    const original=one(), cd=central(original), e=listZipSync(original)[0];
    const descriptor=Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(e.crc,4); descriptor.writeUInt32LE(e.compressedSize,8); descriptor.writeUInt32LE(e.size,12);
    const bytes=Buffer.concat([original.subarray(0,cd),descriptor,original.subarray(cd)]);
    bytes.writeUInt16LE(8,6); bytes.writeUInt32LE(0,18); bytes.writeUInt32LE(0,22); bytes.writeUInt16LE(8,cd+16+8); bytes.writeUInt32LE(cd+16,bytes.length-6);
    expect(readZipEntrySync(bytes,listZipSync(bytes)[0],10000)).toEqual(Buffer.from('汉字 '.repeat(1000)));
    const nameLen=original.readUInt16LE(26), start=30+nameLen;
    const extra=Buffer.concat([original.subarray(0,start),Buffer.from([0,0]),original.subarray(start)]);
    extra.writeUInt16LE(2,28); extra.writeUInt32LE(cd+2,extra.length-6);
    expect(readZipEntrySync(extra,listZipSync(extra)[0],10000)).toEqual(Buffer.from('汉字 '.repeat(1000)));
  });
  it.each([Buffer.from('garbage'),Buffer.from([0xd0,0xcf,0x11,0xe0])])('rejects non-ZIP bytes with the declared error type',b=>expect(()=>listZipSync(b)).toThrow(ZipSyncError));
  it.each(['zip64','encrypted','method','entries','offset','duplicate'] as const)('rejects %s directory metadata',kind=>{
    const b=kind==='duplicate'?writeZip([{path:'a',data:Buffer.alloc(0)},{path:'a',data:Buffer.alloc(0)}]):one(), cd=central(b);
    if(kind==='zip64')b.writeUInt16LE(0xffff,b.length-12);
    if(kind==='encrypted')b.writeUInt16LE(1,cd+8);
    if(kind==='method')b.writeUInt16LE(99,cd+10);
    if(kind==='entries') {b.writeUInt16LE(ZIP_MAX_ENTRIES+1,b.length-12);b.writeUInt16LE(ZIP_MAX_ENTRIES+1,b.length-14);}
    if(kind==='offset')b.writeUInt32LE(cd,cd+42);
    expect(()=>listZipSync(b)).toThrow(ZipSyncError);
  });
  it('bounds declared and actual inflation and rejects false lengths, CRCs and local signatures',()=>{
    const original=writeZip([{path:'huge',data:Buffer.alloc(1024*1024,65)}]);
    expect(()=>readZipEntrySync(original,listZipSync(original)[0],100)).toThrow(ZipSyncError);
    for(const kind of ['size','crc','header','local-flags']) {
      const b=Buffer.from(original), cd=central(b);
      if(kind==='size')b.writeUInt32LE(10,cd+24);
      if(kind==='crc')b.writeUInt32LE(0,cd+16);
      if(kind==='header')b.writeUInt32LE(0,0);
      if(kind==='local-flags')b.writeUInt16LE(1,6);
      expect(()=>readZipEntrySync(b,listZipSync(b)[0],kind==='size'?100:2*1024*1024),kind).toThrow(ZipSyncError);
    }
  });
  it('every 97-byte truncation yields ZipSyncError instead of out-of-bounds errors',()=>{
    const b=readFileSync(join(__dirname,'fixtures/office/foreign-word.docx'));
    for(let i=0;i<b.length;i+=97)expect(()=>listZipSync(b.subarray(0,i)),String(i)).toThrow(ZipSyncError);
  });
});
