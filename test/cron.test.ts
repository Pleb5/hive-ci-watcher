import {describe, expect, it} from 'vitest'
import {isDue, isValidCron, nextOccurrence, selectDueSchedules} from '../src/triggers/cron.js'
import {WatcherDb} from '../src/db/index.js'

const HOUR = 3_600_000
const ms = (iso: string) => Date.parse(iso)

describe('cron validation', () => {
  it('accepts standard 5-field expressions and rejects anything else', () => {
    expect(isValidCron('0 3 * * *')).toBe(true)
    expect(isValidCron('*/15 * * * *')).toBe(true)
    // 6-field (seconds) syntax is not what GitHub accepts.
    expect(isValidCron('0 0 3 * * *')).toBe(false)
    expect(isValidCron('nonsense')).toBe(false)
  })
})

describe('next-occurrence maths', () => {
  it('returns the first occurrence strictly after the given instant', () => {
    expect(nextOccurrence('0 * * * *', ms('2026-01-01T00:30:00Z'))).toBe(ms('2026-01-01T01:00:00Z'))
    expect(nextOccurrence('0 * * * *', ms('2026-01-01T01:00:00Z'))).toBe(ms('2026-01-01T02:00:00Z'))
  })

  it('interprets every expression in UTC, so DST never shifts it', () => {
    // 2026-03-08 is the US DST transition; 03:00 UTC is 03:00 UTC on both sides.
    const before = nextOccurrence('0 3 * * *', ms('2026-03-07T12:00:00Z'))
    const after = nextOccurrence('0 3 * * *', ms('2026-03-08T12:00:00Z'))
    expect(new Date(before!).toISOString()).toBe('2026-03-08T03:00:00.000Z')
    expect(new Date(after!).toISOString()).toBe('2026-03-09T03:00:00.000Z')
  })

  it('returns null for an unparseable expression instead of throwing', () => {
    expect(nextOccurrence('not a cron', Date.now())).toBeNull()
  })
})

describe('missed fires coalesce into one', () => {
  it('fires once for a day of missed hourly occurrences', () => {
    const lastFired = ms('2026-01-01T00:00:00Z')
    const now = ms('2026-01-02T00:00:00Z')

    const occurrence = isDue('0 * * * *', lastFired, now)
    expect(occurrence).toBe(ms('2026-01-01T01:00:00Z'))

    // The daemon records `now`, not the occurrence, so the twenty-three
    // occurrences in between are never separately owed.
    expect(isDue('0 * * * *', now, now)).toBeNull()
    expect(isDue('0 * * * *', now, now + HOUR)).toBe(ms('2026-01-02T01:00:00Z'))
  })

  it('does not fire before the next occurrence is reached', () => {
    expect(isDue('0 * * * *', ms('2026-01-01T00:00:00Z'), ms('2026-01-01T00:59:59Z'))).toBeNull()
  })

  it('selects only the due schedules', () => {
    const now = ms('2026-01-01T02:00:00Z')
    const due = selectDueSchedules(
      [
        {cron: '0 * * * *', lastFiredAt: ms('2026-01-01T00:00:00Z') / 1000},
        {cron: '0 3 * * *', lastFiredAt: ms('2026-01-01T00:00:00Z') / 1000},
      ],
      now,
    )
    expect(due.map(entry => entry.schedule.cron)).toEqual(['0 * * * *'])
  })
})

describe('schedule persistence', () => {
  it('seeds a new schedule so adding a nightly job does not fire it on sight', () => {
    const db = new WatcherDb(':memory:')
    const before = Math.floor(Date.now() / 1000)
    db.replaceSchedules('30617:a:repo', [{workflowPath: '.github/workflows/nightly.yml', cron: '0 3 * * *'}])

    const [row] = db.listSchedules('30617:a:repo')
    expect(row!.lastFiredAt).toBeGreaterThanOrEqual(before)
    expect(selectDueSchedules(db.listSchedules(), Date.now())).toEqual([])
    db.close()
  })

  it('keeps last_fired_at when the cron is unchanged and resets it when edited', () => {
    const db = new WatcherDb(':memory:')
    const repo = '30617:a:repo'
    const path = '.github/workflows/nightly.yml'

    db.replaceSchedules(repo, [{workflowPath: path, cron: '0 3 * * *'}])
    db.markScheduleFired(repo, path, 1_000)

    db.replaceSchedules(repo, [{workflowPath: path, cron: '0 3 * * *'}])
    expect(db.listSchedules(repo)[0]!.lastFiredAt).toBe(1_000)

    db.replaceSchedules(repo, [{workflowPath: path, cron: '30 4 * * *'}])
    expect(db.listSchedules(repo)[0]!.lastFiredAt).toBeGreaterThan(1_000)
    db.close()
  })

  it('drops schedules whose workflow left the default branch', () => {
    const db = new WatcherDb(':memory:')
    db.replaceSchedules('30617:a:repo', [
      {workflowPath: 'a.yml', cron: '0 3 * * *'},
      {workflowPath: 'b.yml', cron: '0 4 * * *'},
    ])
    db.replaceSchedules('30617:a:repo', [{workflowPath: 'a.yml', cron: '0 3 * * *'}])
    expect(db.listSchedules('30617:a:repo').map(row => row.workflowPath)).toEqual(['a.yml'])
    db.close()
  })
})
