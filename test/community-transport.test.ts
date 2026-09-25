import {afterEach, describe, expect, it, vi} from 'vitest'
import {EMPTY, Observable, of, throwError} from 'rxjs'
import {RelayAuthorityTransport} from '../src/community/transport.js'
import {definition} from './community-helpers.js'

afterEach(() => vi.useRealTimers())
const eose = {type: 'EOSE'}
function setup(req: (url: string, filter: any) => Observable<any>) {
  const transport = new RelayAuthorityTransport({relay: (url: string) => ({req: (filter: any) => req(url, filter)})} as any)
  return (relays = ['wss://one'], signal = new AbortController().signal) => transport.query(relays, {kinds: [32222]}, signal)
}

describe('authority transport completeness', () => {
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
