import parser from 'cron-parser'

/**
 * GitHub Actions crons are UTC, standard 5-field POSIX syntax. Parsing with
 * `utc: true` keeps the daemon's own timezone (and DST in it) out of the
 * schedule entirely: `0 3 * * *` is 03:00 UTC on every date, including the
 * ones where local wall-clock 03:00 happens twice or not at all.
 */
export function isValidCron(expression: string): boolean {
  if (expression.trim().split(/\s+/).length !== 5) return false
  try {
    parser.parseExpression(expression, {utc: true})
    return true
  } catch {
    return false
  }
}

/** Next occurrence strictly after `afterMs`, in epoch milliseconds. */
export function nextOccurrence(expression: string, afterMs: number): number | null {
  try {
    const iterator = parser.parseExpression(expression, {
      currentDate: new Date(afterMs),
      utc: true,
    })
    return iterator.next().getTime()
  } catch {
    return null
  }
}

export interface DueSchedule<T> {
  schedule: T
  /**
   * The occurrence being fired for. Missed occurrences coalesce into this one
   * — see `isDue`.
   */
  occurrenceMs: number
}

/**
 * Decides whether a schedule is due, and for which occurrence.
 *
 * **Missed fires coalesce into one**: a watcher down for a day with an hourly
 * cron runs once on startup and then resumes its normal cadence — the anacron
 * rule. That falls out of only ever asking for the *first* occurrence after
 * `lastFiredAt` and then recording `now` as the new `lastFiredAt`, so the
 * twenty-three occurrences in between are never separately owed.
 */
export function isDue(cron: string, lastFiredAtMs: number, nowMs: number): number | null {
  const occurrence = nextOccurrence(cron, lastFiredAtMs)
  if (occurrence === null) return null
  return occurrence <= nowMs ? occurrence : null
}

export function selectDueSchedules<T extends {cron: string; lastFiredAt: number}>(
  schedules: T[],
  nowMs: number,
): Array<DueSchedule<T>> {
  const due: Array<DueSchedule<T>> = []
  for (const schedule of schedules) {
    const occurrenceMs = isDue(schedule.cron, schedule.lastFiredAt * 1000, nowMs)
    if (occurrenceMs !== null) due.push({schedule, occurrenceMs})
  }
  return due
}
