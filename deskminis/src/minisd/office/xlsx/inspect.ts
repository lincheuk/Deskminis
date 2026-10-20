/** A marker alone grants nothing: only an exact bounded regeneration proves support for replacement. */
import {listZipSync,readZipEntrySync} from '../zip';
import {MANIFEST,renderXlsx} from './build';
import {normalizeXlsx} from './model';
export function refuseXlsxOverwrite(before:Buffer,abs:string):string|undefined{
  if(!before.length)return undefined;
  try{
    if(before.length>32*1024*1024)throw Error('文件超过32MiB检查上限');
    const entries=listZipSync(before),source=entries.find(e=>e.name===MANIFEST);if(!source)throw Error('没有可验证的生成清单');
    const manifest=JSON.parse(readZipEntrySync(before,source,16*1024*1024).toString('utf8'));
    if(manifest?.schema!==1||Object.keys(manifest).sort().join(',')!=='input,schema')throw Error('清单版本或结构不支持');
    const regenerated=renderXlsx(normalizeXlsx(manifest.input));
    if(!before.equals(regenerated))throw Error('原件已修改、计算保存或含本生成器不支持的部件');
    return undefined;
  }catch(e){return `没有覆盖 ${abs}：不能确认原工作簿可完整保留（${e instanceof Error?e.message:String(e)}）。office_write 会整份生成新文件，不能在原工作簿上编辑。原文件没有改动；请换一个文件名另存，原件未写进本次content的公式、图表和格式不会进入新文件。`;}
}
