import {listZipSync,readZipEntrySync} from '../zip';
import {MANIFEST,renderPptx} from './build';
import {normalizePptx} from './model';
export function refusePptxOverwrite(before:Buffer,abs:string):string|undefined{
  if(!before.length)return undefined;
  try{
    if(before.length>64*1024*1024)throw Error('文件超过64MiB检查上限');
    const entries=listZipSync(before),source=entries.find(e=>e.name===MANIFEST);if(!source)throw Error('没有可验证的生成清单');
    const manifest=JSON.parse(readZipEntrySync(before,source,48*1024*1024).toString('utf8'));
    if(manifest?.schema!==1||Object.keys(manifest).sort().join(',')!=='input,schema')throw Error('清单结构或版本不支持');
    if(!renderPptx(normalizePptx(manifest.input)).equals(before))throw Error('原件已编辑保存或含本生成器不支持的部件');
    return undefined;
  }catch(e){return `没有覆盖 ${abs}：不能确认原演示可完整保留（${e instanceof Error?e.message:String(e)}）。office_write会整份生成新文件，不能在原演示中编辑。原件没有改动；请换文件名另存，未写进本次content的母版、动画、图表和图片不会进入新文件。`;}
}
