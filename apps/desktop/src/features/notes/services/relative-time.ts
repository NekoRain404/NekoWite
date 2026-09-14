/**
 * A note's mtime, rendered the way the list shows it.
 *
 * The bucket boundaries and the date fallback are a display decision, so they
 * live outside `parseNoteMeta`: the index stores the raw mtime and this module
 * is the only place that decides what "3 小时前" means. `now` is a parameter so
 * the buckets are testable without freezing the clock.
 */

import { t } from '../../../i18n'

export function formatRelativeTime(mtime: number, now = Date.now()): string {
  if (!mtime || mtime <= 0) return '—'
  const diff = now - mtime
  const minute = 60_000
  const hour = 3_600_000
  const day = 86_400_000
  if (diff < minute) return t('time.justNow')
  if (diff < hour) return t('time.minutesAgo', { n: Math.floor(diff / minute) })
  if (diff < day) return t('time.hoursAgo', { n: Math.floor(diff / hour) })
  if (diff < 30 * day) return t('time.daysAgo', { n: Math.floor(diff / day) })
  const d = new Date(mtime)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}
