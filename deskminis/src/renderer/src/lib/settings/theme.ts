/** 主题偏好持久化（MU2b Task 5）：localStorage deskminis.theme 读写。
 *  非法/缺失值回 'system'（跟随系统）。 */
export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'deskminis.theme';
const VALID: readonly string[] = ['system', 'light', 'dark'];

export function loadTheme(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return VALID.includes(v ?? '') ? (v as ThemeMode) : 'system';
}

export function saveTheme(t: ThemeMode): void {
  localStorage.setItem(KEY, t);
}
