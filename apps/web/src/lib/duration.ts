/** 通话时长与倒计时：3分50秒、12分04秒。登录页的锁定倒计时也用它，所以不放在依赖 decimal.js 的 format 里。 */
export function formatDuration(durationSeconds: number) {
  const seconds = Math.max(0, Math.ceil(durationSeconds));
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
}
