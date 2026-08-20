/** F2a 入库降采样（渲染端，DOM canvas，零依赖）。
 *  选图后、发往 minisd 前：长边 ≤1568 的原字节直传不动；超限按比例缩至长边 1568 再导出——
 *  png 保 png，jpeg/webp 导出 jpeg 质量 0.92；gif 豁免直传（canvas 会丢动画，5MB 上限仍兜底）。
 *  导出后若字节反而变大（罕见），取小的那份。
 *  决策逻辑抽成纯函数 planDownsample / pickSmallerDataUrl（node 单测表驱动）；
 *  canvas 实际缩放 jsdom 测不了，由 tests/renderer-downsample.test.ts 源码守卫锚定
 *  上传路径（ChatView.saveImages 调用本模块）+ 1568 字面量。 */

/** 降采样长边上限：对齐主流视觉模型的长边像素限制（1568 = 768×2+32 档，Gemini 文档口径）。 */
export const MAX_LONG_EDGE = 1568;

export interface DownsamplePlan {
  /** false = 尺寸在限内，原字节直传不动（不重编码——重编码必掉质量）。 */
  needsResize: boolean;
  targetW: number;
  targetH: number;
  /** canvas toBlob 的导出格式：png 保 png，jpeg/webp 一律导 jpeg（质量 0.92）。 */
  exportMime: 'image/png' | 'image/jpeg';
}

/** 可进 canvas 重编码的 mime：gif 豁免（丢动画）、其它未知格式（bmp/svg…）也豁免——
 *  main 侧 decodeImageDataUrl 本就只收 png/jpg/gif/webp 四类，未支持格式原样直传
 *  走既有拒绝路径，不在渲染端发明第二套校验。 */
const RESIZABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** 纯决策：给定原始尺寸与 mime，是否需缩、目标尺寸、导出格式。返回 null = 豁免直传。 */
export function planDownsample(w: number, h: number, mime: string): DownsamplePlan | null {
  if (!RESIZABLE_MIME.has(mime)) return null;
  const exportMime: DownsamplePlan['exportMime'] = mime === 'image/png' ? 'image/png' : 'image/jpeg';
  const long = Math.max(w, h);
  if (long <= MAX_LONG_EDGE) return { needsResize: false, targetW: w, targetH: h, exportMime };
  const scale = MAX_LONG_EDGE / long;
  return {
    needsResize: true,
    // 极端长宽比下短边会取整到 0，钳到 1px（0 尺寸 canvas 会被 toBlob 拒绝）
    targetW: Math.max(1, Math.round(w * scale)),
    targetH: Math.max(1, Math.round(h * scale)),
    exportMime,
  };
}

/** 纯决策：两份 dataUrl 取字节小的那份。base64 字节数 ≈ payload 长度 × 3/4，
 *  长度有序 ⇒ 字节有序，无需真解码。导出反而变大时保原字节（罕见，如噪声图重编码）。 */
export function pickSmallerDataUrl(original: string, exported: string): string {
  const bytes = (d: string): number => Math.floor(((d.split(',', 2)[1] ?? '').length * 3) / 4);
  return bytes(exported) < bytes(original) ? exported : original;
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(f);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = url;
  });
}

/** canvas 缩放导出：jpeg/webp 走质量 0.92（png 的 toBlob 忽略 quality 参数，无伤）。 */
async function canvasResize(srcUrl: string, plan: DownsamplePlan): Promise<string> {
  const img = await loadImage(srcUrl);
  const canvas = document.createElement('canvas');
  canvas.width = plan.targetW;
  canvas.height = plan.targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 上下文不可用');
  ctx.drawImage(img, 0, 0, plan.targetW, plan.targetH);
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, plan.exportMime, 0.92));
  if (!blob) throw new Error('canvas 导出失败');
  return fileToDataUrl(new File([blob], 'x', { type: plan.exportMime }));
}

/** 上传路径入口：File →（必要时降采样的）dataUrl。
 *  解码/canvas 任一步失败时回落原 dataUrl——降采样是优化不是闸门，
 *  不该把本来能传的图变成传不了；超大字节仍有 chat.prompt 的 5MB 上限兜底。 */
export async function downsampleImageFile(f: File): Promise<string> {
  const original = await fileToDataUrl(f);
  let plan: DownsamplePlan | null = null;
  try {
    const img = await loadImage(original);
    plan = planDownsample(img.naturalWidth, img.naturalHeight, f.type);
  } catch { return original; } // 解码失败（损坏图/浏览器不认）：原样交给 main 的校验拒绝
  if (!plan || !plan.needsResize) return original;
  try {
    return pickSmallerDataUrl(original, await canvasResize(original, plan));
  } catch {
    return original;
  }
}
