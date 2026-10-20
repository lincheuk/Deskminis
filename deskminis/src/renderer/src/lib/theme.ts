/** 本窗口的主题偏好。data-theme 同时驱动 CSS 与终端已有的观察器。
 *  存本机 localStorage 而不是后端：它是这台机器这个窗口的偏好，
 *  跟着账号同步过去反而会在另一台机器上给出错误的亮度。 */
import { readonly, ref } from 'vue';
export type ThemeMode = 'system' | 'light' | 'dark';
const mode = ref<ThemeMode>('system');
export const themeMode = readonly(mode);
function apply(m: ThemeMode): void {
  mode.value = m;
  if (m === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = m;
}
/** 挂载之前读一次；不可读或旧值无效时跟随系统。启动不重写存储。 */
export function initTheme(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem('deskminis.theme'); } catch { /* 隐私模式下不可读：跟随系统 */ }
  apply(saved === 'light' || saved === 'dark' ? saved : 'system');
}
export function setTheme(m: ThemeMode): void {
  apply(m);
  try { localStorage.setItem('deskminis.theme', m); } catch { /* 不可写时本窗口仍生效 */ }
}
export function toggleTheme(): void {
  const dark = mode.value === 'dark' || (mode.value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  setTheme(dark ? 'light' : 'dark');
}
