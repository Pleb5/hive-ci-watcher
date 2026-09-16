import {ApplesauceRelayPool} from '@contextvm/sdk/relay'
import type {Filter, NostrEvent} from 'nostr-tools'
import {normalizeRelays} from '../config.js'
import {createLogger, errorMessage} from '../log.js'

const log = createLogger('relay')

interface SubscriptionDescriptor {
  id: string
  filters: Filter[]
  onEvent: (event: NostrEvent) => void
  onEose?: () => void
}

export interface RelayHealth {
  relays: string[]
  subscriptions: number
  connectedSince: number | null
}

/**
 * A relay pool whose URL set changes at runtime.
 *
 * The set is the configured defaults ∪ every relay named by a followed repo's
 * 30617, so following a repo can widen it at any moment. `ApplesauceRelayPool`
 * fixes its URLs at construction, so a change means building a fresh pool and
 * replaying every subscription onto it; the old pool is torn down only once
 * the replacement is live, which keeps a re-subscription gap from dropping a
 * 30618 that lands mid-swap.
 */
export class RelayManager {
  private pool: ApplesauceRelayPool | null = null
  private relayUrls: string[] = []
  private readonly descriptors = new Map<string, SubscriptionDescriptor>()
  private readonly unsubscribers = new Map<string, () => void>()
  private connectedSince: number | null = null
  private swapping: Promise<void> | null = null

  constructor(initialRelays: string[]) {
    this.relayUrls = normalizeRelays(initialRelays)
  }

  getRelayUrls(): string[] {
    return [...this.relayUrls]
  }

  health(): RelayHealth {
    return {
      relays: this.getRelayUrls(),
      subscriptions: this.descriptors.size,
      connectedSince: this.connectedSince,
    }
  }

  async start(): Promise<void> {
    if (this.pool) return
    this.pool = new ApplesauceRelayPool(this.relayUrls)
    await this.pool.connect()
    this.connectedSince = Math.floor(Date.now() / 1000)
    log.info('relay pool connected', {relays: this.relayUrls.length})
  }

  /**
   * Swaps in a new relay set when it actually differs. Serialised: two repos
   * announcing new relays in the same tick must not race two pools into
   * existence and leave one orphaned with live sockets.
   */
  async setRelays(urls: string[]): Promise<void> {
    const next = normalizeRelays(urls)
    if (next.length === 0) return
    if (next.join(',') === this.relayUrls.join(',')) return

    const run = async () => {
      const previous = this.pool
      const previousUnsubscribers = [...this.unsubscribers.values()]
      this.unsubscribers.clear()

      this.relayUrls = next
      const pool = new ApplesauceRelayPool(next)
      await pool.connect()
      this.pool = pool
      this.connectedSince = Math.floor(Date.now() / 1000)

      for (const descriptor of this.descriptors.values()) {
        await this.attach(pool, descriptor)
      }

      for (const unsubscribe of previousUnsubscribers) {
        try {
          unsubscribe()
        } catch (err) {
          log.debug('unsubscribe during swap failed', {error: errorMessage(err)})
        }
      }
      if (previous) await previous.disconnect().catch(() => undefined)

      log.info('relay set updated', {relays: next.length})
    }

    this.swapping = (this.swapping ?? Promise.resolve()).then(run, run)
    await this.swapping
  }

  /**
   * Registers (or replaces) a named subscription. Named rather than anonymous
   * because the 30618 filter is rebuilt every time an owner's maintainer set
   * changes, and the stale filter must go with it.
   */
  async subscribe(
    id: string,
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): Promise<void> {
    const descriptor: SubscriptionDescriptor = {id, filters, onEvent, onEose}
    const existing = this.unsubscribers.get(id)
    this.descriptors.set(id, descriptor)

    if (this.pool) await this.attach(this.pool, descriptor)

    if (existing) {
      try {
        existing()
      } catch (err) {
        log.debug('replacing subscription failed to unsubscribe', {id, error: errorMessage(err)})
      }
    }
  }

  unsubscribe(id: string): void {
    this.descriptors.delete(id)
    const unsubscribe = this.unsubscribers.get(id)
    this.unsubscribers.delete(id)
    if (!unsubscribe) return
    try {
      unsubscribe()
    } catch (err) {
      log.debug('unsubscribe failed', {id, error: errorMessage(err)})
    }
  }

  /**
   * Publishes with a hard deadline. The underlying pool retries a failed
   * publish indefinitely, which would otherwise wedge a dispatch behind an
   * unreachable relay.
   */
  async publish(event: NostrEvent, timeoutMs = 15_000): Promise<void> {
    if (!this.pool) throw new Error('relay pool not started')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      await this.pool.publish(event, {abortSignal: controller.signal})
    } finally {
      clearTimeout(timer)
    }
  }

  async stop(): Promise<void> {
    for (const id of [...this.unsubscribers.keys()]) this.unsubscribe(id)
    this.descriptors.clear()
    if (this.pool) await this.pool.disconnect().catch(() => undefined)
    this.pool = null
    this.connectedSince = null
  }

  private async attach(pool: ApplesauceRelayPool, descriptor: SubscriptionDescriptor): Promise<void> {
    const unsubscribe = await pool.subscribe(
      descriptor.filters,
      event => {
        try {
          descriptor.onEvent(event)
        } catch (err) {
          log.error('subscription handler threw', {id: descriptor.id, error: errorMessage(err)})
        }
      },
      descriptor.onEose,
    )
    this.unsubscribers.set(descriptor.id, unsubscribe)
  }
}
