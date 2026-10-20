/** 本机秒数的共用显示；异常或倒退的时间不显示。 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.floor(seconds);
  if (whole < 1) return '不到 1 秒';
  if (whole < 60) return whole + ' 秒';
  if (whole < 3600) {
    const minutes = Math.floor(whole / 60), rest = whole % 60;
    return minutes + ' 分' + (rest ? ' ' + rest + ' 秒' : '');
  }
  const hours = Math.floor(whole / 3600), minutes = Math.floor(whole / 60) % 60;
  return hours + ' 小时' + (minutes ? ' ' + minutes + ' 分' : '');
}
