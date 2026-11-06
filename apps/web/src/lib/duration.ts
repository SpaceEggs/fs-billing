import { translate, type Locale } from '@fs-billing/shared';
import { currentLocale } from '../i18n';

/**
 * 通话时长与倒计时：中文 3分50秒、12分04秒，英文 3m 50s。
 * 登录页的锁定倒计时也用它，所以不放在依赖 decimal.js 的 format 里。
 */
export function formatDuration(
  durationSeconds: number,
  locale: Locale = currentLocale(),
) {
  const seconds = Math.max(0, Math.ceil(durationSeconds));
  return translate(locale, 'format:duration', {
    minutes: Math.floor(seconds / 60),
    seconds: String(seconds % 60).padStart(2, '0'),
  });
}
