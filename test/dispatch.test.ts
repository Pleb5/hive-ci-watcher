import {describe, expect, it} from 'vitest'
import type {NostrEvent} from 'nostr-tools'
import {WatcherDb} from '../src/db/index.js'
import {buildLoomJobEvent, buildRunEnv, buildWorkflowRunEvent, toRepoNostrUrl} from '../src/dispatch/events.js'
import {eligibleRunners, selectRunner} from '../src/dispatch/select.js'
import {isFreeWorker, parseLoomWorker, type LoomWorker} from '../src/nostr/events.js'

const NOW = 1_800_000_000_000
const RECENT = Math.floor(NOW / 1000) - 30
const STALE = Math.floor(NOW / 1000) - 3600

function worker(partial: Partial<LoomWorker> & {pubkey: string}): LoomWorker {
  return {
    name: 'runner',
    description: '',
    mints: [],
    lastSeen: RECENT,
    ...partial,
  }
}

function workerMap(...workers: LoomWorker[]): Map<string, LoomWorker> {
  return new Map(workers.map(entry => [entry.pubkey, entry]))
}

describe('free-worker detection', () => {
  const ad = (tags: string[][]): NostrEvent => ({
    id: 'x'.repeat(64),
    pubkey: 'a'.repeat(64),
    created_at: RECENT,
    kind: 10100,
    tags,
    content: JSON.stringify({name: 'runner'}),
    sig: '0'.repeat(128),
  })

  it('treats an ad with no price tags as free', () => {
    expect(isFreeWorker(parseLoomWorker(ad([])))).toBe(true)
  })

  it('does NOT treat a malformed paid ad as free', () => {
    // NaN rate, zero rate, negative rate — all keep the paid path, where a
    // 5100 without a payment tag would be silently rejected by the worker.
    for (const rate of ['not-a-number', '0', '-5']) {
      const parsed = parseLoomWorker(ad([['price', 'sat', rate, 'second', 'https://mint.example']]))
      expect(isFreeWorker(parsed)).toBe(false)
    }
  })
})

describe('runner eligibility', () => {
  const free = worker({pubkey: 'a'.repeat(64)})
  const paid = worker({pubkey: 'b'.repeat(64), pricing: {perSecondRate: 3, unit: 'second'}})
  const offline = worker({pubkey: 'c'.repeat(64), lastSeen: STALE})
  const unknown = 'd'.repeat(64)

  it('keeps only allowed ∩ online ∩ free', () => {
    const eligible = eligibleRunners({
      allowed: [free.pubkey, paid.pubkey, offline.pubkey, unknown],
      workers: workerMap(free, paid, offline),
      now: NOW,
    })
    expect(eligible.map(entry => entry.pubkey)).toEqual([free.pubkey])
  })

  it('returns an empty set when nothing qualifies', () => {
    expect(eligibleRunners({allowed: [paid.pubkey], workers: workerMap(paid), now: NOW})).toEqual([])
    expect(selectRunner([], 0)).toBeNull()
  })

  it('orders the set stably regardless of Map insertion order', () => {
    const one = worker({pubkey: '1'.repeat(64)})
    const two = worker({pubkey: '2'.repeat(64)})
    const forwards = eligibleRunners({allowed: [two.pubkey, one.pubkey], workers: workerMap(two, one), now: NOW})
    const backwards = eligibleRunners({allowed: [one.pubkey, two.pubkey], workers: workerMap(one, two), now: NOW})
    expect(forwards.map(e => e.pubkey)).toEqual(backwards.map(e => e.pubkey))
  })
})

describe('round-robin fairness', () => {
  const pool = ['1', '2', '3'].map(char => ({pubkey: char.repeat(64), worker: worker({pubkey: char.repeat(64)})}))

  it('rotates through the eligible set', () => {
    let cursor = 0
    const picked: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const result = selectRunner(pool, cursor)!
      picked.push(result.selected.pubkey)
      cursor = result.nextCursor
    }
    expect(picked).toEqual([
      pool[0]!.pubkey, pool[1]!.pubkey, pool[2]!.pubkey,
      pool[0]!.pubkey, pool[1]!.pubkey, pool[2]!.pubkey,
    ])
  })

  it('survives a restart by reading the cursor back from sqlite', () => {
    const db = new WatcherDb(':memory:')
    let cursor = 0
    for (let index = 0; index < 2; index += 1) {
      const result = selectRunner(pool, cursor)!
      cursor = result.nextCursor
      db.setKv('runner_round_robin_cursor', String(cursor))
    }

    const restored = Number.parseInt(db.getKv('runner_round_robin_cursor')!, 10)
    expect(selectRunner(pool, restored)!.selected.pubkey).toBe(pool[2]!.pubkey)
    db.close()
  })

  it('does not snap back to the front when the eligible set shrinks', () => {
    const result = selectRunner(pool, 4)!
    expect(result.selected.pubkey).toBe(pool[1]!.pubkey)
    expect(selectRunner(pool.slice(0, 2), 4)!.selected.pubkey).toBe(pool[0]!.pubkey)
  })
})

describe('event construction', () => {
  const args = {
    repoAddr: '30617:' + 'a'.repeat(64) + ':my-repo',
    workflowPath: '.github/workflows/ci.yml',
    watcherPubkey: 'w'.repeat(64),
    ephemeralPubkey: 'e'.repeat(64),
    trigger: 'push' as const,
    branch: 'main',
    ref: 'refs/heads/main',
    commitId: '1'.repeat(40),
    createdAt: 1_700_000_000,
  }

  it('emits the 5401 tags the extension emits, plus ref', () => {
    const event = buildWorkflowRunEvent(args)
    expect(event.kind).toBe(5401)
    expect(event.content).toBe('')
    expect(event.tags).toEqual([
      ['a', args.repoAddr],
      ['workflow', '.github/workflows/ci.yml'],
      ['triggered-by', args.watcherPubkey],
      ['publisher', args.ephemeralPubkey],
      ['trigger', 'push'],
      ['branch', 'main'],
      ['ref', 'refs/heads/main'],
      ['commit', args.commitId],
      ['t', 'hive-ci'],
    ])
  })

  it('distinguishes a tag push only through the ref tag', () => {
    const event = buildWorkflowRunEvent({...args, ref: 'refs/tags/v1.2.0', branch: 'v1.2.0', trigger: 'schedule'})
    const tags = Object.fromEntries(event.tags.map(tag => [tag[0], tag[1]]))
    // `branch` carries the short name either way — that is what
    // `git clone --branch` wants — so `ref` is the only disambiguator.
    expect(tags.branch).toBe('v1.2.0')
    expect(tags.ref).toBe('refs/tags/v1.2.0')
    expect(tags.trigger).toBe('schedule')
  })

  it('omits the payment tag entirely rather than sending it empty', () => {
    const event = buildLoomJobEvent({
      runnerPubkey: 'r'.repeat(64),
      runId: 'i'.repeat(64),
      args: ['-c', 'curl ...'],
      env: buildRunEnv({
        runId: 'i'.repeat(64),
        repoNostrUrl: 'nostr://npub1.../my-repo',
        workflowPath: '.github/workflows/ci.yml',
        branch: 'main',
        commitId: '1'.repeat(40),
        relays: ['wss://relay.example'],
        blossomServer: 'https://blossom.example',
      }),
      encryptedNsec: 'ciphertext',
    })

    expect(event.kind).toBe(5100)
    expect(event.tags.some(tag => tag[0] === 'payment')).toBe(false)
    expect(event.tags.filter(tag => tag[0] === 'secret')).toEqual([
      ['secret', 'HIVE_CI_NSEC', 'ciphertext'],
    ])
    expect(event.tags[0]).toEqual(['p', 'r'.repeat(64)])
    expect(event.tags[1]).toEqual(['e', 'i'.repeat(64)])
    expect(event.tags[2]).toEqual(['cmd', 'bash'])
    expect(event.tags[3]).toEqual(['args', '-c', 'curl ...'])
  })

  it('carries the branch OR tag name in HIVE_CI_BRANCH', () => {
    const env = Object.fromEntries(
      buildRunEnv({
        runId: 'i',
        repoNostrUrl: 'nostr://x',
        workflowPath: 'w.yml',
        branch: 'v1.2.0',
        commitId: '1'.repeat(40),
        relays: ['wss://a', 'wss://b'],
        blossomServer: 'https://blossom.example',
      }),
    )
    expect(env.HIVE_CI_BRANCH).toBe('v1.2.0')
    expect(env.HIVE_CI_RELAYS).toBe('wss://a,wss://b')
  })

  it('builds an ngit-shaped clone url and returns empty for a bad address', () => {
    const url = toRepoNostrUrl(`30617:${'a'.repeat(64)}:my-repo`, ['wss://relay.example'])
    expect(url).toMatch(/^nostr:\/\/npub1[a-z0-9]+\/wss%3A%2F%2Frelay\.example\/my-repo$/)
    expect(toRepoNostrUrl('not-an-address', [])).toBe('')
    expect(toRepoNostrUrl(undefined, [])).toBe('')
  })
})
