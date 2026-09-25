import {EventStore} from 'applesauce-core'
import {getSeenRelays, normalizeRelayUrl} from 'applesauce-core/helpers/relays'
import type {OutboxMap} from 'applesauce-core/helpers/relay-selection'
import {createEventLoaderForStore} from 'applesauce-loaders/loaders'
import {RelayGroup, RelayLiveness, RelayPool} from 'applesauce-relay'
import {ignoreUnhealthyRelays} from 'applesauce-relay/operators'
import {matchFilters, type Filter, type NostrEvent} from 'nostr-tools'
import {verified} from '../community/transport.js'
import {
  BehaviorSubject,
  distinctUntilChanged,
  filter,
  firstValueFrom,
  isObservable,
  lastValueFrom,
  map,
  of,
  timeout,
  toArray,
  withLatestFrom,
  type Observable,
  type Subscription,
} from 'rxjs'
import {createLogger, errorMessage} from '../log.js'
import {normalizeRelays} from './relays.js'
import {IDENTITY_DISCOVERY_RELAYS} from '../infrastructure.js'

export {normalizeRelays}

const log = createLogger('nostr')

/**
 * NIP-65 index relays consulted when a kind 10002 is not on any relay we
 * already talk to. Used only for lookups, never for publishing.
 */
export const LOOKUP_RELAYS = IDENTITY_DISCOVERY_RELAYS

export interface PublishOutcome {
  accepted: string[]
  rejected: Array<{relay: string; message: string}>
}

export interface RelayReport {
  url: string
  connected: boolean
  ready: boolean
  health: 'online' | 'offline' | 'dead' | 'unknown'
  failureCount: number
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastEventAt: number | null
  eventCount: number
}

/**
 * The watcher's one pool and one store.
 *
 * Every event we hear goes through `store.add`, so the store — not this class —
 * is the source of truth for "latest 30617 for this repo", "latest 30618 per
 * maintainer", "latest 10100 per worker". Kind 5 deletions are applied by the
 * store's delete manager. Missing replaceables (a maintainer's 10002, a
 * worker's freelist set) are fetched lazily through the store loader, which
 * follows relay hints and falls back to the NIP-65 index relays.
 */
export class NostrClient {
  readonly pool: RelayPool
  readonly store: EventStore
  readonly liveness: RelayLiveness
  readonly defaults$: BehaviorSubject<string[]>

  private readonly lastEventAt = new Map<string, number>()
  private readonly eventCounts = new Map<string, number>()
  private readonly internal: Subscription[] = []

  constructor(defaultRelays: string[], lookupRelays = LOOKUP_RELAYS, signer?: {signEvent(event: import('nostr-tools').EventTemplate): Promise<NostrEvent>}) {
    this.defaults$ = new BehaviorSubject(normalizeRelays(defaultRelays))

    // Per-relay liveness ping: a relay that stops answering REQs is
    // reconnected on its own, without touching any other socket.
    this.pool = new RelayPool({
      enablePing: true,
      pingFrequency: 60_000,
      pingTimeout: 20_000,
      keepAlive: 120_000,
    })

    this.liveness = new RelayLiveness({maxFailuresBeforeDead: 8, backoffMaxDelay: 10 * 60_000})
    this.liveness.connectToPool(this.pool)

    this.store = new EventStore()
    this.store.verifyEvent = verified

    createEventLoaderForStore(this.store, this.pool, {
      extraRelays: this.defaults$,
      lookupRelays,
      followRelayHints: true,
    })

    this.internal.push(
      this.pool.add$.subscribe(relay => {
        if (signer) this.internal.push(relay.challenge$.subscribe(challenge => {
          if (challenge) void relay.authenticate(signer).catch(err => log.warn('relay AUTH failed', {relay: relay.url, error: errorMessage(err)}))
        }))
        this.internal.push(
          relay.connected$.subscribe(connected =>
            log.debug('relay connection', {relay: relay.url, connected}),
          ),
        )
      }),
    )
  }

  get defaults(): string[] {
    return this.defaults$.value
  }

  /** Health can narrow a role's routes; it must never add another role's defaults. */
  healthy(relays: string[] | Observable<string[]>): Observable<string[]> {
    const source = isObservable(relays) ? relays : of(relays)
    return source.pipe(
      ignoreUnhealthyRelays(this.liveness),
      map(urls => normalizeRelays(urls)),
      distinctUntilChanged((a, b) => a.join(',') === b.join(',')),
    )
  }

  /**
   * A live subscription whose relay set and filters are both streams. The pool
   * adds and removes REQs as either changes; nothing is torn down wholesale.
   * Every event lands in the store.
   */
  subscribe(
    relays: string[] | Observable<string[]>,
    filters: Filter | Filter[] | Observable<Filter | Filter[]>,
    label: string,
  ): Subscription {
    const queries = isObservable(filters) ? filters : of(filters)
    return this.pool.subscription(this.healthy(relays), filters, {eventStore: null}).pipe(
      withLatestFrom(queries),
      filter(([event, query]) => verified(event) && matchFilters(Array.isArray(query) ? query : [query], event)),
      map(([event]) => event),
    ).subscribe({
      next: event => this.ingest(event, label),
      error: err => log.error('subscription errored', {label, error: errorMessage(err)}),
    })
  }

  /**
   * NIP-65 read side: one REQ per relay, each carrying only the authors known
   * to publish there. `outboxes` maps relay → the pointers reachable on it
   * (build it with `groupPubkeysByRelay`). Both are streams; the pool adjusts.
   */
  subscribeOutbox(
    outboxes: OutboxMap | Observable<OutboxMap>,
    filter: Omit<Filter, 'authors'>,
    label: string,
  ): Subscription {
    // RelayPool indexes filter maps using its own URL form (including a root
    // slash). Protocol/config URLs omit that slash; normalize at this boundary
    // or the SDK sends an undefined filter for an otherwise valid destination.
    const normalized = (isObservable(outboxes) ? outboxes : of(outboxes)).pipe(map(boxes => {
      const result: OutboxMap = {}
      for (const [url, pointers] of Object.entries(boxes)) {
        const key = normalizeRelayUrl(url)
        result[key] = [...(result[key] ?? []), ...pointers]
      }
      return result
    }))
    return this.pool.outboxSubscription(normalized, filter, {eventStore: null}).pipe(
      withLatestFrom(normalized),
      map(([event, boxes]) => ({event, authors: new Set(Object.values(boxes).flat().map(pointer => pointer.pubkey))})),
      // `filter` is the query parameter here, so use a map guard at ingress.
    ).subscribe({
      next: ({event, authors}) => { if (verified(event) && authors.has(event.pubkey) && matchFilters([filter], event)) this.ingest(event, label) },
      error: err => log.error('outbox subscription errored', {label, error: errorMessage(err)}),
    })
  }

  /**
   * One-shot: ask every relay and complete when they have all EOSE'd, or a
   * grace period after the first EOSE — whichever comes first — so one dead
   * relay in the set cannot hold the request to the hard timeout. Events also
   * land in the store. Used at startup for worker discovery and at follow
   * time to say whether an announcement exists anywhere we can see.
   */
  async requestAll(
    relays: string[],
    filters: Filter | Filter[],
    timeoutMs: number,
    label: string,
    graceAfterFirstEoseMs = 4_000,
  ): Promise<NostrEvent[]> {
    const urls = normalizeRelays(this.liveness.filter(relays))
    if (urls.length === 0) return []
    try {
      return await lastValueFrom(
        this.pool
          .request(urls, filters, {
            complete: RelayGroup.completeOnAny(
              RelayGroup.completeOnAllEose(),
              RelayGroup.completeAfterFirstRelay(graceAfterFirstEoseMs),
            ),
            eventStore: null,
          })
          .pipe(
            filter(event => verified(event) && matchFilters(Array.isArray(filters) ? filters : [filters], event)),
            map(event => {
              this.ingest(event, label)
              return event
            }),
            toArray(),
            timeout(timeoutMs),
          ),
        {defaultValue: []},
      )
    } catch (err) {
      const fallback = this.store.getTimeline(filters)
      log.warn('request hit the hard timeout', {
        label,
        relays: urls.length,
        alreadyInStore: fallback.length,
        error: errorMessage(err),
      })
      return fallback
    }
  }

  /**
   * Publishes and requires acceptance from at least `minAccepted` relays (or
   * every relay, when fewer are given). One relay's OK is not delivery — the
   * worker has to be listening where the event landed.
   */
  async publish(relays: string[], event: NostrEvent, minAccepted = 2, timeoutMs = 10_000): Promise<PublishOutcome> {
    const urls = normalizeRelays(this.liveness.filter(relays))
    const required = Math.min(minAccepted, urls.length)
    if (urls.length === 0) throw new Error('no healthy relays to publish to')

    const responses = await this.pool.publish(urls, event, {timeout: timeoutMs, retries: 2})
    const accepted = responses.filter(r => r.ok).map(r => r.from)
    const rejected = responses.filter(r => !r.ok).map(r => ({relay: r.from, message: r.message ?? ''}))

    if (accepted.length < required) {
      throw new Error(
        `event ${event.id.slice(0, 12)} accepted by ${accepted.length}/${urls.length} relays, need ${required}` +
          (rejected.length ? `: ${rejected.map(r => `${r.relay} ${r.message}`).join('; ')}` : ''),
      )
    }
    return {accepted, rejected}
  }

  /** Latest NIP-65 outboxes for a pubkey, `[]` until (and unless) a 10002 is found. */
  outboxes$(pubkey: string): Observable<string[]> {
    return this.store.mailboxes(pubkey).pipe(
      map(boxes => normalizeRelays(boxes?.outboxes ?? [])),
      distinctUntilChanged((a, b) => a.join(',') === b.join(',')),
    )
  }

  async inboxes(pubkey: string): Promise<string[]> {
    const event = await this.loadReplaceable({kind: 10002, pubkey})
    return event ? normalizeRelays(event.tags.filter(t => t[0] === 'r' && (!t[2] || t[2] === 'read')).map(t => t[1]!)) : []
  }

  /**
   * Resolves a replaceable event through the store loader, bounded.
   *
   * `store.replaceable()` emits `undefined` synchronously when the event is
   * not yet in the store and the loader fetch lands later, so the first
   * emission is skipped until a real event (or the timeout) arrives.
   */
  async loadReplaceable(
    pointer: {kind: number; pubkey: string; identifier?: string; relays?: string[]},
    timeoutMs = 8_000,
  ): Promise<NostrEvent | null> {
    try {
      return await firstValueFrom(
        this.store.replaceable(pointer).pipe(
          filter((e): e is NostrEvent => e !== undefined),
          timeout({first: timeoutMs}),
        ),
      )
    } catch {
      return null
    }
  }

  report(): RelayReport[] {
    const statuses = new Map<string, {connected: boolean; ready: boolean}>()
    for (const [url, relay] of this.pool.relays) {
      statuses.set(url, {connected: relay.connected, ready: relay.ready})
    }
    const urls = new Set<string>([...statuses.keys(), ...this.lastEventAt.keys()])
    return [...urls].sort().map(url => {
      const status = statuses.get(url)
      const state = this.liveness.getState(url)
      return {
        url,
        connected: status?.connected ?? false,
        ready: status?.ready ?? false,
        health: state?.state ?? 'unknown',
        failureCount: state?.failureCount ?? 0,
        lastSuccessAt: state?.lastSuccessTime ? Math.floor(state.lastSuccessTime / 1000) : null,
        lastFailureAt: state?.lastFailureTime ? Math.floor(state.lastFailureTime / 1000) : null,
        lastEventAt: this.lastEventAt.get(url) ?? null,
        eventCount: this.eventCounts.get(url) ?? 0,
      }
    })
  }

  close(): void {
    for (const sub of this.internal) sub.unsubscribe()
    this.liveness.disconnectFromPool(this.pool)
    this.pool.close()
  }

  private ingest(event: NostrEvent, label: string): void {
    if (!verified(event)) return
    // applesauce stamps each event with the relay it came from; that is what
    // makes a per-relay "last event at" possible.
    const nowSeconds = Math.floor(Date.now() / 1000)
    for (const relay of getSeenRelays(event) ?? []) {
      this.lastEventAt.set(relay, nowSeconds)
      this.eventCounts.set(relay, (this.eventCounts.get(relay) ?? 0) + 1)
    }
    const added = this.store.add(event)
    if (!added) log.debug('event not added', {label, id: event.id.slice(0, 12), kind: event.kind})
  }
}
