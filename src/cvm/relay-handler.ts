import type {RelayHandler} from '@contextvm/sdk/core'
import {matchFilters, type Filter, type NostrEvent} from 'nostr-tools'
import {verified} from '../community/transport.js'
import {type Observable, type Subscription} from 'rxjs'
import type {NostrClient} from '../nostr/client.js'

/** Directed transport: no SDK-created pools, neutral discovery fallback, or implicit relay union. */
export class DirectedRelayHandler implements RelayHandler {
  private readonly subscriptions = new Set<Subscription>()

  constructor(
    private readonly nostr: NostrClient,
    private readonly reads: Observable<string[]>,
    private readonly targets: (event: NostrEvent) => string[],
    private readonly advertised: () => string[] = () => [],
    private readonly onPublication?: (event: NostrEvent) => void,
  ) {}

  async connect(): Promise<void> { /* Pool connections are established by REQ / EVENT with signer-backed AUTH. */ }
  async disconnect(): Promise<void> { this.unsubscribe() }
  getRelayUrls(): string[] { return this.advertised() }

  async publish(event: NostrEvent, opts?: {abortSignal?: AbortSignal}): Promise<void> {
    if (opts?.abortSignal?.aborted) throw new Error('publication aborted')
    this.onPublication?.(event)
    await this.nostr.publish(this.targets(event), event, 1)
  }

  async subscribe(filters: Filter[], onEvent: (event: NostrEvent) => void): Promise<() => void> {
    const sub = this.nostr.pool.subscription(this.reads, filters, {eventStore: null}).subscribe({
      next: event => { if (verified(event) && matchFilters(filters, event)) onEvent(event) },
    })
    this.subscriptions.add(sub)
    return () => { sub.unsubscribe(); this.subscriptions.delete(sub) }
  }

  unsubscribe(): void {
    for (const sub of this.subscriptions) sub.unsubscribe()
    this.subscriptions.clear()
  }
}
