/** Bounded inline images. No files, URL fetches, or best-effort omission. */
import {crc32,inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {OfficeInputError} from '../format';
export interface ImageAsset {bytes:Buffer;ext:'png'|'jpeg';width:number;height:number;sha256:string}
const fail=(s:string):never=>{throw new OfficeInputError(`图片不可用：${s}`);};
export function decodeImage(dataUrl:unknown):ImageAsset{
  if(typeof dataUrl!=='string'||dataUrl.length>12*1024*1024)return fail('必须提供不超过8MiB的PNG/JPEG内联dataUrl');
  const m=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if(!m||m[2].length%4!==0)return fail('只支持标准base64的PNG/JPEG dataUrl，不支持路径或URL');
  const bytes=Buffer.from(m[2],'base64');if(bytes.toString('base64')!==m[2]||!bytes.length||bytes.length>8*1024*1024)return fail('字节或base64长度无效');
  let width=0,height=0;
  const dimensions=()=>{if(!width||!height||width>8192||height>8192||width*height>16000000)return fail('尺寸超过8192边长或1600万像素');};
  if(m[1]==='png'){
    if(bytes.length<45||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return fail('PNG签名或头错误');
    let at=8,depth=0,color=0,idat=false,ended=false,palette=false;const compressed:Buffer[]=[];
    while(at<bytes.length){
      if(at+12>bytes.length)return fail('PNG块被截断');const n=bytes.readUInt32BE(at),end=at+12+n;if(end>bytes.length)return fail('PNG块长度错误');
      const type=bytes.subarray(at+4,at+8).toString('ascii'),data=bytes.subarray(at+8,at+8+n);
      if(crc32(bytes.subarray(at+4,at+8+n))!==bytes.readUInt32BE(at+8+n))return fail('PNG块校验和错误');
      if(at===8&&type!=='IHDR')return fail('PNG首块必须是IHDR');
      if(type==='IHDR'){
        if(at!==8||n!==13)return fail('PNG头重复或长度错误');width=data.readUInt32BE(0);height=data.readUInt32BE(4);dimensions();depth=data[8];color=data[9];
        const valid:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
        if(!valid[color]?.includes(depth)||data[10]!==0||data[11]!==0||data[12]!==0)return fail('PNG位深、压缩或隔行方式不支持');
      }else if(type==='PLTE'){if(idat||!n||n%3||n>768)return fail('PNG调色板无效');palette=true;}
      else if(type==='IDAT'){idat=true;compressed.push(data);}
      else if(type==='IEND'){if(n||end!==bytes.length||!idat)return fail('PNG结束块错误');ended=true;}
      else if(type==='acTL'||type==='fcTL'||type==='fdAT')return fail('不支持动画PNG');
      else if(type.charCodeAt(0)>=65&&type.charCodeAt(0)<=90)return fail('PNG有未知必需块');
      at=end;
    }
    if(!ended||(color===3&&!palette))return fail('PNG缺少结束块或调色板');
    const channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color],stride=Math.ceil(width*channels*depth/8)+1,total=stride*height;
    if(total>64*1024*1024)return fail('PNG解码超过64MiB');
    let raw:Buffer;try{raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:total});}catch{return fail('PNG像素数据错误或超过声明尺寸');}
    if(raw.length!==total)return fail('PNG像素数据长度与尺寸不符');for(let y=0;y<height;y++)if(raw[y*stride]>4)return fail('PNG行过滤器无效');
  }else{
    if(bytes.length<4||bytes.readUInt16BE(0)!==0xffd8||bytes.readUInt16BE(bytes.length-2)!==0xffd9)return fail('JPEG起止标记错误');
    let at=2,sawScan=false;
    while(at<bytes.length-2){
      if(bytes[at++]!==255)return fail('JPEG段标记错误');while(bytes[at]===255)at++;const tag=bytes[at++];
      if(tag===0xd9)break;if(at+2>bytes.length)return fail('JPEG段被截断');const n=bytes.readUInt16BE(at);if(n<2||at+n>bytes.length)return fail('JPEG段长度错误');
      if([0xc0,0xc1,0xc2].includes(tag)){if(n<8||width)return fail('JPEG帧头错误');height=bytes.readUInt16BE(at+3);width=bytes.readUInt16BE(at+5);dimensions();}
      // Rotated EXIF cannot be safely represented with the raw dimensions in this first version.
      if(tag===0xe1&&bytes.subarray(at+2,at+8).toString('ascii')==='Exif\0\0')return fail('本版不支持EXIF元数据，请导出无EXIF的PNG/JPEG');
      if(tag===0xda){sawScan=true;break;}at+=n;
    }
    if(!width||!sawScan)return fail('JPEG缺少尺寸或像素扫描');
  }
  return {bytes,ext:m[1] as 'png'|'jpeg',width,height,sha256:createHash('sha256').update(bytes).digest('hex')};
}
