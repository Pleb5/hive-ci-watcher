import {describe, expect, it} from 'vitest'
import {fetchWithRetry, type WorkflowTree} from '../src/git/fetch.js'
import {loadConfig} from '../src/config.js'

const tree = (): WorkflowTree => new Map([['.github/workflows/ci.yml', {path: '.github/workflows/ci.yml', content: ''}]])
const fast = {windowMs: 2_000, initialDelayMs: 20, maxDelayMs: 50}

describe('polling a remote that has not caught up', () => {
  it('keeps trying until the announced commit is served', async () => {
    let calls = 0
    const retries: number[] = []
    const outcome = await fetchWithRetry(
      async () => (++calls < 4 ? null : tree()),
      fast,
      undefined,
      info => retries.push(info.delayMs),
    )
    expect(outcome.reason).toBe('fetched')
    expect(calls).toBe(4)
    // Backoff doubles up to the cap.
    expect(retries).toEqual([20, 40, 50])
  })

  it('gives up once the window is spent', async () => {
    let calls = 0
    const outcome = await fetchWithRetry(async () => (++calls, null), {windowMs: 150, initialDelayMs: 40, maxDelayMs: 40})
    expect(outcome).toEqual({tree: null, reason: 'exhausted'})
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(calls).toBeLessThanOrEqual(5)
  })

  it('stops between attempts when superseded, never mid-attempt', async () => {
    const controller = new AbortController()
    let calls = 0
    let resolveAttempt: (() => void) | undefined
    const attempt = () =>
      new Promise<WorkflowTree | null>(resolve => {
        calls += 1
        resolveAttempt = () => resolve(null)
      })

    const pending = fetchWithRetry(attempt, {windowMs: 60_000, initialDelayMs: 5_000, maxDelayMs: 5_000}, controller.signal)
    await new Promise(r => setTimeout(r, 5))
    expect(calls).toBe(1)

    // Abort while the first attempt is still running: it must be allowed to
    // finish, and no second attempt may start.
    controller.abort()
    resolveAttempt!()
    const outcome = await pending
    expect(outcome).toEqual({tree: null, reason: 'aborted'})
    expect(calls).toBe(1)
  })

  it('cuts a backoff sleep short on abort', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = fetchWithRetry(async () => null, {windowMs: 60_000, initialDelayMs: 10_000, maxDelayMs: 10_000}, controller.signal)
    setTimeout(() => controller.abort(), 30)
    const outcome = await pending
    expect(outcome.reason).toBe('aborted')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('does not start at all when already superseded', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const outcome = await fetchWithRetry(async () => (++calls, tree()), fast, controller.signal)
    expect(outcome.reason).toBe('aborted')
    expect(calls).toBe(0)
  })
})

describe('retry window config', () => {
  it('defaults to ten minutes and reads seconds from the environment', () => {
    const owner = {HIVE_CI_WATCHER_OWNER_PUBKEY: 'a'.repeat(64)}
    expect(loadConfig(owner).fetchRetryWindowMs).toBe(600_000)
    expect(loadConfig({...owner, HIVE_CI_WATCHER_FETCH_RETRY_WINDOW: '90'}).fetchRetryWindowMs).toBe(90_000)
    expect(loadConfig({...owner, HIVE_CI_WATCHER_FETCH_RETRY_WINDOW: 'nope'}).fetchRetryWindowMs).toBe(600_000)
  })
})
