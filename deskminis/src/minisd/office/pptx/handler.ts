import type {OfficeFormatHandler} from '../format';
import {normalizePptx} from './model';
import {renderPptx} from './build';
import {verifyPptxContent} from './content-check';
import {refusePptxOverwrite} from './inspect';
export const pptxHandler:OfficeFormatHandler={
  format:'pptx',app:'PowerPoint',
  help:{brief:'pptx整份生成可编辑演示；支持标题、单栏、双栏、内联图片和表格，外来或编辑保存的演示请另存',
    content:'pptx={"slides":[{"title":"标题","bullets":["要点"]}]}；旧title+bullets默认single。layout=title用subtitle，columns用columns:[{heading,bullets},{heading,bullets}]，image用image:{dataUrl:"data:image/png;base64,...",alt,caption}（仅PNG/JPEG内联字节，不支持路径/URL、动画PNG、隔行PNG或EXIF JPEG），table用table:{rows:[["项目","金额"],["开发",100]],colWidths:[2,1]}（宽度为比例）。1至50页、10万字、表格最多8行5列；未知字段/布局混用/文字溢出明确拒绝，请拆页。主文字至少18pt，不自动缩字；图片按比例完整放入框。只能整份生成，不能在旧文件内编辑或保留未输入的母版/动画/图片'},
  plan(spec){const deck=normalizePptx(spec),bytes=renderPptx(deck);return {summary:`PowerPoint 演示，${deck.slides.length} 页`,bytes,notes:[],verifyContent:subject=>verifyPptxContent(bytes,deck,subject)};},
  refuseOverwrite:refusePptxOverwrite,
  readNote(doc){return `（${doc.omitted?.join('；')??'最终版式未还原'}。office_write不能在原演示中编辑，复杂文件请另存。）`;},
  toText(doc){const out:string[]=[];for(const [i,s]of (doc.slides??[]).entries()){
    out.push(`## 第 ${i+1} 页：${s.title}`);for(const b of s.bullets)out.push(`- ${b}`);
    for(const e of s.elements??[]){if(e.kind==='table'){out.push('表格：');for(const row of e.rows??[])out.push(row.join('\t'));}if(e.kind==='image')out.push(`图片：${e.alt||'无替代文字'}（${e.path}；图像内容未提取）`);}out.push('');
  }return out.join('\n').trim();},
};
