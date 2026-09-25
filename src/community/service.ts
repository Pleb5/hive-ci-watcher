import type {Filter, NostrEvent} from 'nostr-tools'
import {Subject} from 'rxjs'
import type {WatcherDb} from '../db/index.js'
import {createLogger, errorMessage} from '../log.js'
import type {CommunityConfig, CommunitySource} from './config.js'
import {CommunityView} from './membership.js'
import {communityPointer} from './protocol.js'
import {verified, type AuthorityTransport} from './transport.js'

const log = createLogger('communities')
interface Branch {
  source: CommunitySource
  view: CommunityView
  members: Set<string>
  loadedAt: number | null
  error: string | null
  pending?: Promise<void>
  controller?: AbortController
  unsubscribe?: () => void
  ready: boolean
}

export class CommunityAccess {
  readonly changes = new Subject<void>()
  private readonly branches = new Map<string, Branch>()
  private refreshTimer?: NodeJS.Timeout
  private expiryTimer?: NodeJS.Timeout
  private stopped = false

  constructor(
    private readonly config: CommunityConfig,
    private readonly transport: AuthorityTransport,
    private readonly db: WatcherDb,
    private readonly now = Date.now,
  ) {
    for (const source of config.communities) {
      const view = new CommunityView(source.address)
      const saved = db.getKv(`community:${source.address}`)
      if (saved) {
        try {
          const events: NostrEvent[] = JSON.parse(saved)
          for (const event of events) if (verified(event)) view.apply(event)
        } catch { log.warn('invalid saved community projection', {address: source.address}) }
      }
      this.branches.set(source.address, {source, view, members: view.members(), loadedAt: null, error: null, ready: false})
    }
  }

  async start(): Promise<void> {
    await this.refresh()
    if (this.stopped) return
    this.refreshTimer = setInterval(() => void this.refresh(), this.config.refreshSeconds * 1000)
    this.expiryTimer = setInterval(() => this.checkFreshness(), 1000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.refreshTimer)
    clearInterval(this.expiryTimer)
    for (const branch of this.branches.values()) {
      branch.controller?.abort()
      branch.unsubscribe?.()
    }
    await Promise.all([...this.branches.values()].map(branch => branch.pending))
    this.changes.complete()
  }

  private fresh(branch: Branch): boolean {
    return !this.stopped && branch.loadedAt !== null && this.now() >= branch.loadedAt &&
      this.now() - branch.loadedAt < this.config.maxAgeSeconds * 1000
  }

  sources(pubkey: string): string[] {
    this.checkFreshness()
    return [...this.branches.values()].filter(b => this.fresh(b) && b.members.has(pubkey)).map(b => b.source.address)
  }

  status() {
    return [...this.branches.values()].map(branch => ({
      address: branch.source.address,
      state: this.fresh(branch) ? 'ready' : branch.pending ? 'loading' : branch.loadedAt === null ? 'unavailable' : 'stale',
      definition_found: !!branch.view.definition,
      last_synced_at: branch.loadedAt === null ? null : Math.floor(branch.loadedAt / 1000),
      member_count: this.fresh(branch) ? branch.members.size : 0,
      error: branch.error,
    }))
  }

  listMembers() {
    const members = new Map<string, string[]>()
    for (const branch of this.branches.values()) {
      if (!this.fresh(branch)) continue
      for (const pubkey of branch.members) members.set(pubkey, [...(members.get(pubkey) ?? []), branch.source.address])
    }
    return [...members].sort(([a], [b]) => a.localeCompare(b)).map(([pubkey, communities]) => ({pubkey, communities}))
  }

  /** Accepted definitions, including verified persisted transport metadata. Not authorization. */
  definitions() {
    return [...this.branches.values()].flatMap(branch => branch.view.definition ? [branch.view.definition] : [])
  }

  checkFreshness(): void {
    let changed = false
    for (const branch of this.branches.values()) {
      const ready = this.fresh(branch)
      if (ready !== branch.ready) { branch.ready = ready; changed = true }
    }
    if (changed) this.changes.next()
  }

  async refresh(): Promise<void> {
    await Promise.all([...this.branches.values()].map(branch => this.refreshBranch(branch)))
  }

  private refreshBranch(branch: Branch): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (branch.pending) return branch.pending
    branch.pending = this.synchronize(branch).finally(() => { branch.pending = undefined })
    return branch.pending
  }

  private publish(branch: Branch): void {
    branch.members = branch.view.members()
    this.db.setKv(`community:${branch.source.address}`, JSON.stringify(branch.view.snapshot()))
    branch.ready = this.fresh(branch)
    this.changes.next()
  }

  private async synchronize(branch: Branch): Promise<void> {
    const controller = new AbortController()
    branch.controller = controller
    let deadline: NodeJS.Timeout | undefined
    let release: (() => void) | undefined
    const pointer = communityPointer(branch.source.address)!
    const definitionFilter: Filter = {kinds: [32222], authors: [pointer.owner], '#d': [pointer.id]}
    const apply = (events: NostrEvent[]) => {
      let changed = false
      // A new definition invalidates the previous completeness claim until
      // its new list dependencies and moderation history have been queried.
      for (const event of events) {
        if (!verified(event)) continue
        if (branch.view.apply(event)) {
          changed = true
          if (event.kind === 32222) branch.loadedAt = null
        }
      }
      if (changed && !this.stopped) this.publish(branch)
    }
    try {
      release = await this.transport.admit(controller.signal)
      const started = this.now()
      deadline = setTimeout(() => controller.abort(), 60000)
      apply(await this.transport.query([...new Set([...branch.source.relays, ...(branch.view.definition?.relays ?? [])])], definitionFilter, controller.signal))
      const definitionId = branch.view.definition?.event.id
      const refs = branch.view.refs()
      const relays = [...new Set([...branch.source.relays, ...(branch.view.definition?.relays ?? []), ...refs.flatMap(ref => ref.relay ? [ref.relay] : [])])]
      const filters: Filter[] = [
        definitionFilter,
        ...[...new Map(refs.map(ref => [ref.address, ref])).values()].map(ref => ({kinds: [30000], authors: [ref.owner], '#d': [ref.identifier]})),
        {kinds: [1984], '#h': [pointer.id]},
        {kinds: [5], '#h': [pointer.id]},
      ]
      // Subscribe before snapshot requests so changes during synchronization
      // are retained. A definition change forces a new dependency pass.
      branch.unsubscribe?.()
      branch.unsubscribe = this.transport.subscribe(relays, filters, event => {
        apply([event])
        if (event.kind === 32222 && !branch.pending) void this.refreshBranch(branch)
      })
      for (const filter of filters) apply(await this.transport.query(relays, filter, controller.signal))
      if (controller.signal.aborted || this.stopped) return
      if (definitionId !== branch.view.definition?.event.id) throw new Error('community definition changed during synchronization')
      branch.loadedAt = started
      branch.error = null
      this.publish(branch)
    } catch (error) {
      branch.error = errorMessage(error)
      if (!this.stopped) {
        log.warn('community synchronization incomplete', {address: branch.source.address, error: branch.error})
        this.checkFreshness()
      }
    } finally {
      clearTimeout(deadline)
      release?.()
    }
  }
}
