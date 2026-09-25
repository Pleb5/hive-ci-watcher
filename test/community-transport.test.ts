import {afterEach, describe, expect, it, vi} from 'vitest'
import {EMPTY, NEVER, Observable, of, throwError} from 'rxjs'
import {RelayAuthorityTransport} from '../src/community/transport.js'
import {CommunityAccess} from '../src/community/service.js'
import {parseCommunityConfig} from '../src/community/config.js'
import {WatcherDb} from '../src/db/index.js'
import {ADDRESS, COMMUNITY, OTHER, definition} from './community-helpers.js'

afterEach(() => vi.useRealTimers())
const eose = {type: 'EOSE'}
function setup(req: (url: string, filter: any) => Observable<any>) {
  const transport = new RelayAuthorityTransport({relay: (url: string) => ({req: (filter: any) => req(url, filter)})} as any)
  return (relays = ['wss://one'], signal = new AbortController().signal) => transport.query(relays, {kinds: [32222]}, signal)
}

describe('authority transport completeness', () => {
  it('rotates waiting owners and cancels a queued owner without waiting for relay I/O', async () => {
    vi.useFakeTimers()
    const requests: string[] = []
    const query = setup(url => {
      requests.push(url)
      return url === 'wss://healthy' ? of(eose) : NEVER
    })
    const controllers = Array.from({length: 5}, () => new AbortController())
    const pending = controllers.slice(0, 4).map((controller, i) => query(
      Array.from({length: 20}, (_, j) => `wss://offline-${i}-${j}`), controller.signal,
    ).catch(() => []))
    const queued = query(['wss://cancelled'], controllers[4]!.signal)
    controllers[4]!.abort()
    await expect(queued).rejects.toThrow('aborted')
    expect(requests).not.toContain('wss://cancelled')
    const healthy = query(['wss://healthy'])
    await vi.advanceTimersByTimeAsync(15001)
    await expect(healthy).resolves.toEqual([])
    for (const controller of controllers) controller.abort()
    await Promise.all(pending)
  })
  it('isolates healthy community refreshes from an outage fan-out and repository hydration', async () => {
    vi.useFakeTimers()
    const db = new WatcherDb(':memory:')
    const requests: string[] = []
    let active = 0, peak = 0
    const transport = new RelayAuthorityTransport({relay: (url: string) => ({
      req: () => new Observable(subscriber => {
        requests.push(url)
        active++
        peak = Math.max(peak, active)
        if (url === 'wss://healthy.example.com') { subscriber.next(eose); subscriber.complete() }
        return () => { active-- }
      }),
      subscription: () => NEVER,
    })} as any)
    const slow = Array.from({length: 20}, (_, i) => `wss://offline-${i}.example.com`)
    const service = new CommunityAccess(parseCommunityConfig({communities: [
      {address: ADDRESS, relays: slow},
      {address: `32222:${OTHER}:${COMMUNITY}`, relays: ['wss://healthy.example.com']},
    ]}), transport, db)
    const repo = new AbortController()
    let refresh: Promise<void> | undefined
    try {
      refresh = service.refresh()
      const hydration = transport.query(slow, {kinds: [30618]}, repo.signal).catch(() => [])
      await vi.advanceTimersByTimeAsync(16000)
      expect(service.sources(OTHER)).toEqual([`32222:${OTHER}:${COMMUNITY}`])
      expect(peak).toBeLessThanOrEqual(4)
      await vi.advanceTimersByTimeAsync(44001)
      await refresh
      repo.abort()
      await hydration
      const prior = requests.filter(url => url === 'wss://healthy.example.com').length
      refresh = service.refresh()
      await vi.advanceTimersByTimeAsync(16000)
      expect(service.sources(OTHER)).toEqual([`32222:${OTHER}:${COMMUNITY}`])
      expect(requests.filter(url => url === 'wss://healthy.example.com').length).toBeGreaterThan(prior)
    } finally {
      repo.abort()
      await service.stop()
      await refresh
      db.close()
    }
  })
  it('distinguishes empty EOSE from CLOSED, errors and premature completion', async () => {
    expect(await setup(() => of(eose))()).toEqual([])
    for (const response of [EMPTY, of({type: 'CLOSED'}), throwError(() => new Error('offline'))]) {
      await expect(setup(() => response)()).rejects.toThrow('no community relay completed')
    }
  })
  it('rejects invalid signatures and does not confuse a failed relay with an empty successful one', async () => {
    const invalid = {...definition(), sig: '0'.repeat(128)}
    await expect(setup(() => of({type: 'EVENT', event: invalid}, eose))()).rejects.toThrow()
    const valid = definition()
    const query = setup(url => url.endsWith('offline') ? throwError(() => new Error('offline')) : of({type: 'EVENT', event: valid}, eose))
    expect(await query(['wss://offline', 'wss://online'])).toEqual([valid])
  })
  it('cancels a hanging request on shutdown', async () => {
    const controller = new AbortController()
    let unsubscribed = false
    const pending = setup(() => new Observable(() => () => { unsubscribed = true }))(['wss://one'], controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    expect(unsubscribed).toBe(true)
  })
  it('bounds the entire request even if a relay never stops emitting', async () => {
    vi.useFakeTimers()
    const pending = setup(() => new Observable(subscriber => {
      const timer = setInterval(() => subscriber.next({type: 'EVENT', event: definition()}), 1000)
      return () => clearInterval(timer)
    }))()
    const check = expect(pending).rejects.toThrow('no community relay completed')
    await vi.advanceTimersByTimeAsync(15001)
    await check
  })
  it('paginates overlapping timestamps and refuses an unpageable saturated second', async () => {
    let calls = 0
    const many = Array.from({length: 100}, (_, i) => definition(1000 + i))
    const query = setup((_url, filter) => {
      calls++
      const events = filter.until === undefined ? many : [many[0]!]
      return of(...events.map(event => ({type: 'EVENT', event})), eose)
    })
    expect(await query()).toHaveLength(100)
    expect(calls).toBe(2)
    const same = Array.from({length: 100}, () => ({type: 'EVENT', event: definition(1000)}))
    await expect(setup(() => of(...same, eose))()).rejects.toThrow()
  })
})
