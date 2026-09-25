import type {RelayPool} from 'applesauce-relay'
import {matchFilter, verifyEvent, type Filter, type NostrEvent} from 'nostr-tools'
import {lastValueFrom, Subject, takeUntil, takeWhile, tap, toArray, timeout} from 'rxjs'

export interface AuthorityTransport {
  query(relays: string[], filter: Filter, signal: AbortSignal): Promise<NostrEvent[]>
  subscribe(relays: string[], filters: Filter[], receive: (event: NostrEvent) => void): () => void
}

export function verified(event: NostrEvent): boolean {
  try { return verifyEvent(event) } catch { return false }
}

/** Raw verified intake, deliberately independent of EventStore's deletion manager. */
export class RelayAuthorityTransport implements AuthorityTransport {
  private active = 0
  private readonly waiting: Array<() => void> = []
  constructor(private readonly pool: RelayPool) {}

  async query(relays: string[], filter: Filter, signal: AbortSignal): Promise<NostrEvent[]> {
    const results = await Promise.allSettled([...new Set(relays)].map(async url => {
      if (this.active >= 4) await new Promise<void>(resolve => this.waiting.push(resolve))
      else this.active++
      try { return await this.queryRelay(url, filter, signal) }
      finally {
        const next = this.waiting.shift()
        if (next) next()
        else this.active--
      }
    }))
    if (signal.aborted) throw new Error('authority synchronization aborted')
    const successes = results.filter((r): r is PromiseFulfilledResult<NostrEvent[]> => r.status === 'fulfilled')
    if (!successes.length) throw new Error('no community relay completed the authority query')
    return [...new Map(successes.flatMap(r => r.value).map(event => [event.id, event])).values()]
  }

  private async queryRelay(url: string, filter: Filter, signal: AbortSignal): Promise<NostrEvent[]> {
    const events = new Map<string, NostrEvent>()
    let until: number | undefined
    for (let page = 0; page < 100; page++) {
      if (signal.aborted) throw new Error('authority synchronization aborted')
      const query = {...filter, limit: 100, ...(until === undefined ? {} : {until})}
      const cancelled = new Subject<void>()
      const abort = () => cancelled.next()
      signal.addEventListener('abort', abort, {once: true})
      let eose = false
      let count = 0
      let oldest = Infinity
      try {
        await lastValueFrom(this.pool.relay(url).req(query, {reconnect: false, waitForAuth: false}).pipe(
          // Timeout is for the WHOLE page, not reset by an endless event stream.
          tap(message => {
            if (message.type === 'CLOSED') throw new Error('authority REQ closed')
            if (message.type === 'EOSE') eose = true
            if (message.type !== 'EVENT') return
            if (++count > 10000) throw new Error('authority page exceeds event bound')
            if (!verified(message.event) || !matchFilter(query, message.event)) throw new Error('invalid authority response')
            oldest = Math.min(oldest, message.event.created_at)
            events.set(message.event.id, message.event)
          }),
          takeWhile(message => message.type !== 'EOSE', true),
          takeUntil(cancelled),
          toArray(),
          timeout(15000),
        ))
      } finally {
        signal.removeEventListener('abort', abort)
        cancelled.complete()
      }
      if (!eose || signal.aborted) throw new Error('authority query did not reach EOSE')
      if (count < 100) return [...events.values()]
      // Overlap the last timestamp. A saturated second cannot be paged safely
      // with NIP-01; report incomplete rather than omit potential bans.
      if (!Number.isFinite(oldest) || oldest === until) throw new Error('authority timestamp page saturated')
      until = oldest
    }
    throw new Error('authority query exceeds history bound')
  }

  subscribe(relays: string[], filters: Filter[], receive: (event: NostrEvent) => void): () => void {
    const subscriptions = [...new Set(relays)].map(url => this.pool.relay(url).subscription(filters, {waitForAuth: false}).subscribe({
      next: event => {
        if (event !== 'EOSE' && verified(event) && filters.some(filter => matchFilter(filter, event))) receive(event)
      },
      // A failed live subscription never extends freshness. Periodic sync
      // rebuilds subscriptions and independently checks successful EOSE.
      error: () => undefined,
    }))
    return () => subscriptions.forEach(subscription => subscription.unsubscribe())
  }
}
