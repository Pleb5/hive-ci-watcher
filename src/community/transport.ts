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

interface QueryJob {
  run: () => Promise<NostrEvent[]>
  resolve: (events: NostrEvent[]) => void
  reject: (error: Error) => void
}

interface QueryOwner {
  signal: AbortSignal
  waiting: QueryJob[]
  active: boolean
  abort: () => void
}

/** Raw verified intake, deliberately independent of EventStore's deletion manager. */
export class RelayAuthorityTransport implements AuthorityTransport {
  private active = 0
  private readonly owners = new Map<AbortSignal, QueryOwner>()
  /** Failures are local to a dependency pass; a later refresh retries replicas. */
  private readonly failedRelays = new WeakMap<AbortSignal, Set<string>>()
  constructor(private readonly pool: RelayPool) {}

  async query(relays: string[], filter: Filter, signal: AbortSignal): Promise<NostrEvent[]> {
    let failed = this.failedRelays.get(signal)
    if (!failed) this.failedRelays.set(signal, failed = new Set())
    const candidates = [...new Set(relays)].filter(url => !failed.has(url))
    // One owner probes replicas serially. Divide its discovery allowance so
    // even the last replica can answer before the pass's 60-second deadline.
    // Definition discovery and newly advertised hints each get at most 20s of
    // first-page waits. Further filters skip failed replicas for this pass.
    const pageTimeoutMs = Math.max(1, Math.min(15000, Math.floor(20000 / candidates.length)))
    const results = await Promise.allSettled(candidates.map(url =>
      this.schedule(signal, async () => {
        try { return await this.queryRelay(url, filter, signal, pageTimeoutMs) }
        catch (error) {
          if (!signal.aborted) failed.add(url)
          throw error
        }
      }),
    ))
    if (signal.aborted) throw new Error('authority synchronization aborted')
    const successes = results.filter((r): r is PromiseFulfilledResult<NostrEvent[]> => r.status === 'fulfilled')
    if (!successes.length) throw new Error('no community relay completed the authority query')
    return [...new Map(successes.flatMap(r => r.value).map(event => [event.id, event])).values()]
  }

  /** One active relay per synchronization owner, four globally. Rotate owners
   * after each attempt so a branch's fan-out cannot crowd out another branch
   * or repo. Queued cancellation never needs to wait for somebody else's I/O. */
  private schedule(signal: AbortSignal, run: QueryJob['run']): Promise<NostrEvent[]> {
    if (signal.aborted) return Promise.reject(new Error('authority synchronization aborted'))
    let owner = this.owners.get(signal)
    if (!owner) {
      const group: QueryOwner = {signal, waiting: [], active: false, abort: () => {
        for (const job of group.waiting.splice(0)) job.reject(new Error('authority synchronization aborted'))
        if (!group.active) this.removeOwner(group)
        this.drain()
      }}
      owner = group
      this.owners.set(signal, owner)
      signal.addEventListener('abort', owner.abort, {once: true})
    }
    const group = owner
    return new Promise((resolve, reject) => {
      group.waiting.push({run, resolve, reject})
      this.drain()
    })
  }

  private removeOwner(owner: QueryOwner): void {
    this.owners.delete(owner.signal)
    owner.signal.removeEventListener('abort', owner.abort)
  }

  private drain(): void {
    while (this.active < 4) {
      const owner = [...this.owners.values()].find(owner => !owner.active && owner.waiting.length && !owner.signal.aborted)
      if (!owner) return
      const job = owner.waiting.shift()!
      owner.active = true
      this.active++
      void job.run().then(job.resolve, job.reject).finally(() => {
        this.active--
        owner.active = false
        if (!owner.waiting.length) this.removeOwner(owner)
        else {
          this.owners.delete(owner.signal)
          this.owners.set(owner.signal, owner)
        }
        this.drain()
      })
    }
  }

  private async queryRelay(url: string, filter: Filter, signal: AbortSignal, pageTimeoutMs: number): Promise<NostrEvent[]> {
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
          timeout(pageTimeoutMs),
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
