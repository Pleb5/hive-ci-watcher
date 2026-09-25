import {groupPubkeysByRelay} from 'applesauce-core/helpers/relay-selection'
import {getOutboxes} from 'applesauce-core/helpers/mailboxes'
import {mergeRelaySets} from 'applesauce-core/helpers/relays'
import {nip19} from 'nostr-tools'
import {
  BehaviorSubject,
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  map,
  shareReplay,
  switchMap,
  type Observable,
  type Subscription,
} from 'rxjs'
import {Authorizer} from './cvm/auth.js'
import {CommunityAccess} from './community/service.js'
import {RelayAuthorityTransport} from './community/transport.js'
import type {WatcherConfig} from './config.js'
import type {WatcherDb} from './db/index.js'
import {dispatchRun, type DispatchOutcome, type DispatchRequest} from './dispatch/submit.js'
import {
  DEFAULT_RETRY_POLICY,
  fetchWithRetry,
  fetchWorkflowTree,
  findRemoteServingCommit,
  WorkflowTreeCache,
  type WorkflowTree,
} from './git/fetch.js'
import type {WatcherIdentity} from './identity.js'
import {createLogger, errorMessage} from './log.js'
import {NostrClient, normalizeRelays, type RelayReport} from './nostr/client.js'
import {
  KIND_LOOM_WORKER,
  KIND_REPO_ANNOUNCEMENT,
  KIND_REPO_STATE,
  parseLoomWorker,
  parseRepoAnnouncement,
  parseRepoState,
  tagValue,
  type LoomWorker,
  type RepoAnnouncement,
  type RepoState,
} from './nostr/events.js'
import {selectDueSchedules} from './triggers/cron.js'
import {evaluatePush} from './triggers/push.js'
import {diffRefs, selectRepoState, type RefDescriptor} from './triggers/refs.js'
import {parseWorkflowTree, type ParsedWorkflow, type WorkflowParseError} from './triggers/workflow.js'

const log = createLogger('watcher')

const KIND_DELETION = 5
const SCHEDULE_TICK_MS = 60_000
const RUNS_PRUNE_EVERY_TICKS = 60
/** Startup: how long to wait for every default relay to EOSE the 10100 request. */
const WORKER_DISCOVERY_TIMEOUT_MS = 10_000
/** A 30618 burst (several maintainers, several relays) is evaluated once. */
const EVALUATE_DEBOUNCE_MS = 250
/** Hard ceiling on one dispatch so a stalled relay or Blossom server cannot wedge a repo's queue. */
const DISPATCH_DEADLINE_MS = 120_000

export interface WatcherStatus {
  pubkey: string
  startedAt: number
  uptimeSeconds: number
  relays: RelayReport[]
  followedRepos: number
  knownWorkers: number
  runnerPool: number
  recentRuns: ReturnType<WatcherDb['recentRuns']>
}

type Completion = 'complete' | 'incomplete' | 'superseded'

interface RepoWatch {
  repoAddr: string
  owner: string
  dTag: string
  subscriptions: Subscription[]
  announcement$: Observable<RepoAnnouncement | null>
  /** Set once the probe has run, so `list_followed` can say why a repo is idle. */
  probe: {checkedAt: number; found: boolean; relays: string[]} | null
  hints: BehaviorSubject<string[]>
  baselineReady: boolean
  baselinePending?: Promise<void>
  baselineController?: AbortController
}

export class Watcher {
  readonly nostr: NostrClient
  readonly communities: CommunityAccess
  readonly authorizer: Authorizer
  private readonly authorityTransport: RelayAuthorityTransport

  private readonly repos = new Map<string, RepoWatch>()
  private workers = new Map<string, LoomWorker>()
  private readonly trees = new WorkflowTreeCache()
  /** Serialises evaluation per repo so two 30618s cannot interleave a ref diff. */
  private readonly repoQueues = new Map<string, Promise<void>>()
  /** The evaluation currently running (or queued) per repo; aborted when a newer one is enqueued. */
  private readonly inflight = new Map<string, AbortController>()
  private readonly internal: Subscription[] = []

  private scheduleTimer: NodeJS.Timeout | null = null
  private scheduleTicks = 0
  private schedulePending?: Promise<void>
  private startedAt = 0
  private running = false
  private readyForRepos = false
  private reconcilePending?: Promise<void>
  private reconcileDirty = false
  private readonly epochs = new Map<string, number>()

  constructor(
    private readonly config: WatcherConfig,
    private readonly db: WatcherDb,
    private readonly identity: WatcherIdentity,
  ) {
    this.nostr = new NostrClient(config.relays)
    this.authorityTransport = new RelayAuthorityTransport(this.nostr.pool)
    this.communities = new CommunityAccess(config.communityAccess, this.authorityTransport, db)
    this.authorizer = new Authorizer(db, config.ownerPubkey, this.communities)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.startedAt = Math.floor(Date.now() / 1000)
    // Re-establish access and seed current refs on every start. Offline or
    // suspended changes must not become a burst of historical CI runs.
    for (const repo of this.db.listFollowedRepos()) this.db.setRepoActive(repo.repoAddr, false)
    this.internal.push(this.communities.changes.subscribe(() => {
      void this.reconcileAccess().catch(error => log.error('access reconciliation failed', {error: errorMessage(error)}))
    }))
    const communityStartup = this.communities.start()

    // Worker map is a projection of the store: every 10100 we have ever
    // heard, latest per pubkey, re-derived whenever one changes.
    this.internal.push(
      this.nostr.store.timeline({kinds: [KIND_LOOM_WORKER]}).subscribe(events => {
        const next = new Map<string, LoomWorker>()
        for (const event of events) {
          const worker = parseLoomWorker(event)
          if (worker) next.set(worker.pubkey, worker)
        }
        this.workers = next
      }),
    )

    // Relays replay the latest 30618 for every followed repo the moment we
    // subscribe. Learn the runner pool first — wait for every default relay
    // to EOSE the worker request, bounded — so the first evaluation does not
    // see an empty pool.
    const ads = await this.nostr.requestAll(
      this.nostr.defaults,
      {kinds: [KIND_LOOM_WORKER]},
      WORKER_DISCOVERY_TIMEOUT_MS,
      'workers:discovery',
    )
    log.info('worker discovery complete', {ads: ads.length, workers: this.workers.size})
    if (!this.running) return

    this.internal.push(this.nostr.subscribe(this.nostr.defaults$, {kinds: [KIND_LOOM_WORKER]}, 'workers'))

    await communityStartup
    if (!this.running) return
    this.readyForRepos = true
    await this.reconcileAccess()

    this.scheduleTimer = setInterval(() => {
      void this.runScheduleTick().catch(err =>
        log.error('schedule tick failed', {error: errorMessage(err)}),
      )
    }, SCHEDULE_TICK_MS)

    log.info('watcher started', {pubkey: this.identity.pubkey, repos: this.repos.size})
  }

  async stop(): Promise<void> {
    this.running = false
    this.readyForRepos = false
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    this.scheduleTimer = null
    for (const controller of this.inflight.values()) controller.abort()
    for (const watch of this.repos.values()) watch.baselineController?.abort()
    await this.communities.stop()
    await this.reconcilePending
    const watches = [...this.repos.values()]
    for (const watch of watches) {
      for (const sub of watch.subscriptions) sub.unsubscribe()
      watch.hints.complete()
    }
    this.repos.clear()
    for (const sub of this.internal) sub.unsubscribe()
    await Promise.allSettled([...this.repoQueues.values()])
    await this.schedulePending
    await Promise.allSettled(watches.map(watch => watch.baselinePending))
    this.nostr.close()
  }

  status(requester?: string): WatcherStatus {
    const visible = new Set(this.db.listRegistrations().filter(r => !requester || r.requester === requester).map(r => r.repoAddr))
    return {
      pubkey: this.identity.pubkey,
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt ? Math.floor(Date.now() / 1000) - this.startedAt : 0,
      relays: this.nostr.report(),
      followedRepos: visible.size,
      knownWorkers: this.workers.size,
      runnerPool: this.db.listRunnerPool().length,
      recentRuns: this.db.recentRuns(5000).filter(run => visible.has(run.repoAddr)).slice(0, 10),
    }
  }

  knownWorkers(): Map<string, LoomWorker> {
    return this.workers
  }

  /** What the follow-time probe found, for `list_followed`. */
  repoProbe(repoAddr: string): RepoWatch['probe'] {
    return this.repos.get(repoAddr)?.probe ?? null
  }

  /** Workflow files the watcher could not parse at the repo's latest evaluated commit. */
  unparseableWorkflows(repoAddr: string): Array<WorkflowParseError & {commit: string}> {
    return this.unparseable.get(repoAddr) ?? []
  }

  /**
   * Whether the watcher pubkey is on a worker's published freelist.
   *
   * Some workers advertise `freelist_event` (an naddr to a kind 30000 follow
   * set) on their 10100. Resolving it through the store loader follows the
   * naddr's relay hint, so the set is fetched from wherever the worker put
   * it. `null` when the worker publishes no such pointer.
   */
  async freelistStatus(workerPubkey: string): Promise<boolean | null> {
    const ad = this.nostr.store.getReplaceable(KIND_LOOM_WORKER, workerPubkey)
    const naddr = ad ? (tagValue(ad, 'freelist_event') ?? tagValue(ad, 'whitelist_event')) : undefined
    if (!naddr) return null

    let pointer: {kind: number; pubkey: string; identifier: string; relays?: string[]}
    try {
      const decoded = nip19.decode(naddr.replace(/^nostr:/, ''))
      if (decoded.type !== 'naddr') return null
      pointer = decoded.data
    } catch {
      return null
    }

    const set = await this.nostr.loadReplaceable(pointer)
    if (!set) return null
    return set.tags.some(tag => tag[0] === 'p' && tag[1]?.toLowerCase() === this.identity.pubkey)
  }

  // ── follow management ─────────────────────────────────────────────────────

  isEligible(repoAddr: string): boolean {
    return this.db.listRegistrations(repoAddr).some(registration => this.authorizer.authorize(registration.requester, 'allowlisted'))
  }

  /** Invalidate immediately, then serialize asynchronous stream teardown/restart. */
  reconcileAccess(): Promise<void> {
    for (const repo of this.db.listFollowedRepos()) {
      if (repo.active && !this.isEligible(repo.repoAddr)) {
        this.db.setRepoActive(repo.repoAddr, false)
        this.epochs.set(repo.repoAddr, (this.epochs.get(repo.repoAddr) ?? 0) + 1)
        this.inflight.get(repo.repoAddr)?.abort()
      }
    }
    if (!this.readyForRepos || !this.running) return Promise.resolve()
    this.reconcileDirty = true
    if (this.reconcilePending) return this.reconcilePending
    this.reconcilePending = Promise.resolve().then(async () => {
      do {
        this.reconcileDirty = false
        for (const repo of this.db.listFollowedRepos()) {
          if (!this.running) return
          if (!this.isEligible(repo.repoAddr) || !repo.active) {
            await this.unwatchRepo(repo.repoAddr)
            if (!this.running) return
            // An evaluation interrupted during an await may have recorded
            // progress; reseed only after that evaluation has finished.
            this.db.setRepoActive(repo.repoAddr, false)
          }
          if (!this.db.listRegistrations(repo.repoAddr).length) {
            this.db.unfollowRepo(repo.repoAddr)
            continue
          }
          if (!this.isEligible(repo.repoAddr)) continue
          if (!this.db.getFollowedRepo(repo.repoAddr)?.active) this.db.setRepoActive(repo.repoAddr, true)
          const hints = [...new Set(this.db.listRegistrations(repo.repoAddr)
            .filter(r => this.authorizer.authorize(r.requester, 'allowlisted')).flatMap(r => r.relayHints))]
          await this.watchRepo(repo.repoAddr, repo.repoOwner, repo.dTag, hints)
        }
      } while (this.reconcileDirty && this.running)
    }).finally(() => { this.reconcilePending = undefined })
    return this.reconcilePending
  }

  /**
   * Wires one repo as a set of streams:
   *
   * - announcement relays = defaults ∪ follower's hints ∪ owner's NIP-65 outboxes
   * - state relays, per maintainer = the above ∪ the 30617's `relays` ∪ that
   *   maintainer's own outboxes — one REQ per relay, authors narrowed to the
   *   maintainers known to publish there
   *
   * Every input is an observable; a maintainer added to the 30617, or a 10002
   * arriving late, reshapes the REQs without tearing anything down.
   */
  async watchRepo(repoAddr: string, owner: string, dTag: string, hints: string[] = []): Promise<void> {
    const existing = this.repos.get(repoAddr)
    if (existing) {
      existing.hints.next(normalizeRelays(hints))
      return
    }

    const store = this.nostr.store
    const hintRelays = normalizeRelays(hints)
    const hints$ = new BehaviorSubject(hintRelays)
    const subscriptions: Subscription[] = []

    const announcementRelays$ = combineLatest([hints$, this.nostr.outboxes$(owner)]).pipe(
      map(([h, outboxes]) => mergeRelaySets(h, outboxes)),
      distinctUntilChanged((a, b) => a.join(',') === b.join(',')),
    )

    subscriptions.push(
      this.nostr.subscribe(
        announcementRelays$,
        [
          {kinds: [KIND_REPO_ANNOUNCEMENT], authors: [owner], '#d': [dTag]},
          // NIP-09: the store's delete manager drops the 30617 when this lands.
          {kinds: [KIND_DELETION], authors: [owner], '#a': [repoAddr]},
        ],
        `announcement:${repoAddr}`,
      ),
    )

    const announcement$ = store.replaceable(KIND_REPO_ANNOUNCEMENT, owner, dTag).pipe(
      map(event => (event ? parseRepoAnnouncement(event) : null)),
      shareReplay({bufferSize: 1, refCount: true}),
    )

    const maintainers$ = announcement$.pipe(
      map(a => (a ? a.maintainers : [owner])),
      distinctUntilChanged((a, b) => a.join(',') === b.join(',')),
    )
    const repoRelays$ = announcement$.pipe(
      map(a => normalizeRelays(a?.relays ?? [])),
      distinctUntilChanged((a, b) => a.join(',') === b.join(',')),
    )

    // relay → maintainers reachable there. Each maintainer's own outboxes are
    // consulted (fetched lazily via the store loader when unknown), and every
    // maintainer is also expected on the repo's relays and ours.
    const outboxMap$ = combineLatest([maintainers$, repoRelays$, announcementRelays$, this.nostr.defaults$]).pipe(
      switchMap(([maintainers, repoRelays, annRelays, defaults]) =>
        combineLatest(
          maintainers.map(pubkey =>
            this.nostr.outboxes$(pubkey).pipe(
              map(outboxes => ({
                pubkey,
                relays: this.nostr.liveness.filter(mergeRelaySets(defaults, annRelays, repoRelays, outboxes)),
              })),
            ),
          ),
        ),
      ),
      map(pointers => groupPubkeysByRelay(pointers)),
    )

    subscriptions.push(
      this.nostr.subscribeOutbox(outboxMap$, {kinds: [KIND_REPO_STATE], '#d': [dTag]}, `state:${repoAddr}`),
    )

    // Evaluate whenever the announcement or any maintainer's state changes.
    const states$ = maintainers$.pipe(
      switchMap(maintainers => store.timeline({kinds: [KIND_REPO_STATE], authors: maintainers, '#d': [dTag]})),
    )
    subscriptions.push(
      combineLatest([announcement$, states$])
        .pipe(debounceTime(EVALUATE_DEBOUNCE_MS))
        .subscribe(() => this.enqueue(repoAddr, signal => this.evaluateRepo(repoAddr, signal))),
    )

    const watch: RepoWatch = {repoAddr, owner, dTag, subscriptions, announcement$, probe: null, hints: hints$, baselineReady: false}
    this.repos.set(repoAddr, watch)

    void this.hydrateRepo(watch)
  }

  private hydrateRepo(watch: RepoWatch): Promise<void> {
    if (watch.baselinePending) return watch.baselinePending
    watch.baselinePending = this.loadRepoBaseline(watch).finally(() => { watch.baselinePending = undefined })
    return watch.baselinePending
  }

  /** A cached pre-suspension state is not a restart baseline. Wait for actual EOSE. */
  private async loadRepoBaseline(watch: RepoWatch): Promise<void> {
    const controller = new AbortController()
    watch.baselineController = controller
    const deadline = setTimeout(() => controller.abort(), 60000)
    const current = () => this.running && !controller.signal.aborted && this.repos.get(watch.repoAddr) === watch && this.isEligible(watch.repoAddr)
    try {
      const outboxes = await firstOutboxes(this.nostr, watch.owner)
      if (!current()) return
      const relays = normalizeRelays(mergeRelaySets(this.nostr.defaults, watch.hints.value, outboxes))
      const found = await this.authorityTransport.query(relays,
        {kinds: [KIND_REPO_ANNOUNCEMENT], authors: [watch.owner], '#d': [watch.dTag]}, controller.signal)
      if (!current()) return
      found.forEach(event => this.nostr.store.add(event))
      const announcement = this.currentAnnouncement(watch)
      watch.probe = {checkedAt: Math.floor(Date.now() / 1000), found: !!announcement, relays}
      if (!announcement) return
      for (const maintainer of announcement.maintainers) {
        const maintainerOutboxes = await firstOutboxes(this.nostr, maintainer)
        const events = await this.authorityTransport.query(mergeRelaySets(relays, announcement.relays, maintainerOutboxes),
          {kinds: [KIND_REPO_STATE], authors: [maintainer], '#d': [watch.dTag]}, controller.signal)
        if (!current()) return
        events.forEach(event => this.nostr.store.add(event))
      }
      if (this.currentAnnouncement(watch)?.event.id !== announcement.event.id) return
      watch.baselineReady = true
      this.enqueue(watch.repoAddr, signal => this.evaluateRepo(watch.repoAddr, signal))
    } catch (error) {
      if (current()) log.warn('repo baseline incomplete; will retry', {repoAddr: watch.repoAddr, error: errorMessage(error)})
    } finally { clearTimeout(deadline) }
  }

  /**
   * Waits for any in-flight evaluation first: a `putRefState` landing after
   * the follow row is gone would leave orphan rows that make a later
   * re-follow skip its seed.
   */
  async unwatchRepo(repoAddr: string): Promise<void> {
    const watch = this.repos.get(repoAddr)
    watch?.baselineController?.abort()
    if (watch) for (const sub of watch.subscriptions) sub.unsubscribe()
    watch?.hints.complete()
    this.repos.delete(repoAddr)
    this.trees.invalidateRepo(repoAddr)
    this.inflight.get(repoAddr)?.abort()
    this.inflight.delete(repoAddr)
    const pending = this.repoQueues.get(repoAddr)
    if (pending) await pending.catch(() => undefined)
    await watch?.baselinePending
    this.repoQueues.delete(repoAddr)
    this.unparseable.delete(repoAddr)
  }

  /**
   * Serialises work per repo. Two 30618s arriving back to back must not both
   * read `ref_state` before either writes it, or the second would re-dispatch
   * everything the first already handled.
   *
   * Enqueuing also **supersedes** whatever is in flight: its signal fires, so
   * a poll waiting for a remote to catch up with an older commit stops, and
   * the new task evaluates from the latest state instead. A ref that moved
   * twice before its objects arrived is built once, at the newer commit.
   * Dispatch itself is never interrupted — only the waits between phases.
   */
  private enqueue(repoAddr: string, task: (signal: AbortSignal) => Promise<void>): void {
    if (!this.repos.has(repoAddr)) return
    this.inflight.get(repoAddr)?.abort()
    const controller = new AbortController()
    this.inflight.set(repoAddr, controller)

    const previous = this.repoQueues.get(repoAddr) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => (controller.signal.aborted ? undefined : task(controller.signal)))
      .catch(err => log.error('repo evaluation failed', {repoAddr, error: errorMessage(err)}))
      .finally(() => {
        if (this.inflight.get(repoAddr) === controller) this.inflight.delete(repoAddr)
      })
    this.repoQueues.set(repoAddr, next)
  }

  // ── push pipeline (§3.2) ──────────────────────────────────────────────────

  private currentAnnouncement(watch: RepoWatch): RepoAnnouncement | null {
    const event = this.nostr.store.getReplaceable(KIND_REPO_ANNOUNCEMENT, watch.owner, watch.dTag)
    return event ? parseRepoAnnouncement(event) : null
  }

  private currentStates(watch: RepoWatch, maintainers: string[]): RepoState[] {
    return this.nostr.store
      .getTimeline({kinds: [KIND_REPO_STATE], authors: maintainers, '#d': [watch.dTag]})
      .map(event => parseRepoState(event, watch.owner))
      .filter((state): state is RepoState => state !== null)
  }

  private async evaluateRepo(repoAddr: string, signal: AbortSignal): Promise<void> {
    if (!this.isEligible(repoAddr) || !this.db.getFollowedRepo(repoAddr)?.active) return
    const watch = this.repos.get(repoAddr)
    if (!watch?.baselineReady) return

    const announcement = this.currentAnnouncement(watch)
    if (!announcement) {
      log.debug('no announcement in store, deferring evaluation', {repoAddr})
      return
    }

    const state = selectRepoState(this.currentStates(watch, announcement.maintainers), announcement.maintainers)
    if (!state) {
      log.debug('no acceptable repo state', {repoAddr})
      return
    }

    const followed = this.db.getFollowedRepo(repoAddr)
    if (!followed) return

    const defaultBranch = resolveDefaultBranch(state, followed.defaultBranch)
    if (defaultBranch !== followed.defaultBranch) this.db.setDefaultBranch(repoAddr, defaultBranch)

    // The default branch is always read at *its* current state commit — a new
    // commit is a new cache key, so a push that changed the triggers or the
    // schedules is seen before anything is evaluated against them.
    const defaultRefName = `refs/heads/${defaultBranch}`
    const defaultCommit = state.refs.find(entry => entry.ref === defaultRefName)?.commitId ?? null
    const defaultTree = defaultCommit
      ? await this.loadWorkflows(announcement, defaultCommit, defaultRefName, signal)
      : {workflows: [], fetched: true}

    if (signal.aborted) {
      log.info('evaluation superseded by a newer state', {repoAddr, phase: 'default-branch'})
      return
    }

    if (defaultCommit && defaultTree.fetched) {
      this.db.replaceSchedules(
        repoAddr,
        defaultTree.workflows.flatMap(workflow =>
          workflow.schedules.map(cron => ({workflowPath: workflow.path, cron})),
        ),
      )
    }

    if (followed.seededAt === null) {
      this.db.seedRefStates(
        repoAddr,
        state.refs.map(entry => ({ref: entry.ref, commitId: entry.commitId})),
      )
      log.info('seeded ref state on first sight', {repoAddr, refs: state.refs.length})
      return
    }

    const diff = diffRefs(state.refs, this.db.getRefStates(repoAddr))

    for (const ref of diff.deleted) {
      this.db.tombstoneRefState(repoAddr, ref)
      log.info('ref deleted', {repoAddr, ref})
    }

    for (const change of diff.changed) {
      if (signal.aborted) {
        log.info('evaluation superseded by a newer state', {repoAddr, phase: 'refs', ref: change.descriptor.ref})
        return
      }

      const completion = await this.evaluateRefChange({
        announcement,
        defaultWorkflows: defaultTree.workflows,
        defaultFetched: defaultTree.fetched,
        ref: change.descriptor,
        commitId: change.commitId,
        repoAddr,
        signal,
      })

      if (signal.aborted || !this.isEligible(repoAddr)) return

      if (completion === 'superseded') {
        log.info('evaluation superseded by a newer state', {repoAddr, phase: 'ref', ref: change.descriptor.ref})
        return
      }

      if (completion === 'complete') {
        this.db.putRefState(repoAddr, change.descriptor.ref, change.commitId)
        log.info('ref recorded', {repoAddr, ref: change.descriptor.ref, commit: change.commitId.slice(0, 12)})
      } else {
        log.warn('evaluation incomplete, leaving ref for retry', {
          repoAddr,
          ref: change.descriptor.ref,
          commit: change.commitId.slice(0, 12),
        })
      }
    }
  }

  private async evaluateRefChange(args: {
    announcement: RepoAnnouncement
    defaultWorkflows: ParsedWorkflow[]
    defaultFetched: boolean
    ref: RefDescriptor
    commitId: string
    repoAddr: string
    signal: AbortSignal
  }): Promise<Completion> {
    if (!args.defaultFetched) return 'incomplete'

    const pushed = await this.loadWorkflows(args.announcement, args.commitId, args.ref.ref, args.signal)
    if (args.signal.aborted) return 'superseded'
    if (!pushed.fetched) return 'incomplete'

    const paths = evaluatePush({
      ref: args.ref,
      defaultBranchWorkflows: args.defaultWorkflows,
      pushedRefWorkflows: pushed.workflows,
    })

    if (paths.length === 0) {
      // Info, not debug: "I pushed and nothing happened" is the question this
      // line answers. Say what was considered and what was unreadable.
      log.info('push matched no workflow', {
        repoAddr: args.repoAddr,
        ref: args.ref.ref,
        commit: args.commitId.slice(0, 12),
        candidates: args.defaultWorkflows.map(w => `${w.path}${w.push ? '' : ' (no on.push)'}`),
        unparseable: this.unparseableWorkflows(args.repoAddr).map(e => e.path),
      })
      return 'complete'
    }

    let completion: Completion = 'complete'
    for (const workflowPath of paths) {
      if (args.signal.aborted) return 'superseded'
      const outcome = await this.dispatch({
        repoAddr: args.repoAddr,
        workflowPath,
        trigger: 'push',
        ref: args.ref.ref,
        branch: args.ref.shortName,
        commitId: args.commitId,
        repoRelays: args.announcement.relays,
      })
      if (args.signal.aborted) return 'superseded'
      if (outcome.status !== 'dispatched') completion = 'incomplete'
    }
    return completion
  }

  private async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    const epoch = this.epochs.get(request.repoAddr) ?? 0
    let expired = false
    const deps = {
      config: this.config,
      db: this.db,
      identity: this.identity,
      nostr: this.nostr,
      workers: () => this.workers,
      mayDispatch: () => !expired && this.running && this.isEligible(request.repoAddr) &&
        (this.epochs.get(request.repoAddr) ?? 0) === epoch &&
        !!this.db.getFollowedRepo(request.repoAddr)?.active && this.db.getFollowedRepo(request.repoAddr)?.seededAt != null,
    }
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<DispatchOutcome>(resolve => {
      timer = setTimeout(
        () => {
          expired = true
          resolve({status: 'failed', error: `dispatch exceeded ${DISPATCH_DEADLINE_MS} ms`})
        },
        DISPATCH_DEADLINE_MS,
      )
    })
    try {
      return await Promise.race([dispatchRun(deps, request), deadline])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Why the last poll for a `(repo, commit)` ended without a tree. */
  private readonly lastMiss = new Map<string, 'aborted' | 'exhausted'>()
  /** Workflows that failed to parse, per repo, from the most recent tree read; for `list_followed`. */
  private readonly unparseable = new Map<string, Array<WorkflowParseError & {commit: string}>>()
  /** `(repo, commit)` pairs whose parse errors have already been logged, to log each once. */
  private readonly parseErrorsLogged = new Set<string>()

  /**
   * Fetches a tree, polling while the remote has not yet caught up with the
   * announced commit (see `fetchWithRetry`).
   *
   * The cache shares an in-flight fetch between callers, so a poll started by
   * a superseded evaluation can be the one a newer evaluation awaits. That
   * poll resolves `null` on abort and is evicted; when the miss was an abort
   * (not an exhausted window) the second `get` starts a fresh poll owned by
   * this evaluation's signal.
   */
  private async loadWorkflows(
    announcement: RepoAnnouncement,
    commitId: string,
    refName: string,
    signal: AbortSignal,
  ): Promise<{workflows: ParsedWorkflow[]; fetched: boolean}> {
    if (announcement.cloneUrls.length === 0) {
      log.warn('repo announcement has no usable clone urls', {repoAddr: announcement.repoAddr})
      return {workflows: [], fetched: false}
    }

    const key = `${announcement.repoAddr}@${commitId.toLowerCase()}`
    const load = () =>
      this.trees.get(announcement.repoAddr, commitId, async () => {
        const outcome = await fetchWithRetry(
          {
            probe: () => findRemoteServingCommit(announcement.cloneUrls, commitId, refName),
            fetch: preferredUrl =>
              fetchWorkflowTree({cloneUrls: announcement.cloneUrls, commitId, refName, preferredUrl}),
          },
          {...DEFAULT_RETRY_POLICY, windowMs: this.config.fetchRetryWindowMs},
          signal,
          info =>
            log.info('remote not yet at announced commit, retrying', {
              repoAddr: announcement.repoAddr,
              ref: refName,
              commit: commitId.slice(0, 12),
              attempt: info.attempt,
              nextInMs: info.delayMs,
              elapsedMs: info.elapsedMs,
            }),
          info =>
            log.info('workflow tree fetched', {
              repoAddr: announcement.repoAddr,
              ref: refName,
              commit: commitId.slice(0, 12),
              attempts: info.attempt,
              elapsedMs: info.elapsedMs,
              cloneUrl: info.cloneUrl,
            }),
        )
        if (outcome.tree) this.lastMiss.delete(key)
        else this.lastMiss.set(key, outcome.reason)
        return outcome.tree
      })

    let tree: WorkflowTree | null = null
    try {
      tree = await load()
      if (!tree && !signal.aborted && this.lastMiss.get(key) === 'aborted') tree = await load()
    } catch (err) {
      log.warn('workflow fetch threw', {repoAddr: announcement.repoAddr, commitId, error: errorMessage(err)})
      return {workflows: [], fetched: false}
    }

    if (!tree) {
      if (!signal.aborted) {
        log.warn('remote never reached announced commit within the retry window', {
          repoAddr: announcement.repoAddr,
          ref: refName,
          commit: commitId.slice(0, 12),
          windowMs: this.config.fetchRetryWindowMs,
        })
      }
      return {workflows: [], fetched: false}
    }

    const parsed = parseWorkflowTree(tree)
    this.unparseable.set(
      announcement.repoAddr,
      parsed.errors.map(error => ({...error, commit: commitId})),
    )
    if (parsed.errors.length > 0 && !this.parseErrorsLogged.has(key)) {
      this.parseErrorsLogged.add(key)
      for (const error of parsed.errors) {
        log.warn('workflow file does not parse and will never trigger', {
          repoAddr: announcement.repoAddr,
          commit: commitId.slice(0, 12),
          path: error.path,
          error: error.error,
        })
      }
    }
    return {workflows: parsed.workflows, fetched: true}
  }

  // ── schedule pipeline (§3.3) ──────────────────────────────────────────────

  runScheduleTick(nowMs = Date.now()): Promise<void> {
    // A tick stalled on a dispatch is not joined by the next one; it is
    // skipped and logged, so a stall surfaces instead of piling up.
    if (this.schedulePending) {
      log.warn('schedule tick still running, skipping this one')
      return Promise.resolve()
    }
    if (!this.running) return Promise.resolve()
    this.schedulePending = this.evaluateSchedules(nowMs).finally(() => { this.schedulePending = undefined })
    return this.schedulePending
  }

  private async evaluateSchedules(nowMs: number): Promise<void> {
    this.scheduleTicks += 1
    for (const watch of this.repos.values()) if (!watch.baselineReady) void this.hydrateRepo(watch)
    if (this.scheduleTicks % RUNS_PRUNE_EVERY_TICKS === 0) {
      const pruned = this.db.pruneRuns()
      if (pruned > 0) log.debug('pruned run history', {pruned})
    }

    const due = selectDueSchedules(this.db.listSchedules(), nowMs).map(entry => ({
      ...entry, epoch: this.epochs.get(entry.schedule.repoAddr) ?? 0,
    }))
    for (const entry of due) {
      const {repoAddr, workflowPath} = entry.schedule
      if (!this.running || !this.isEligible(repoAddr) || !this.db.getFollowedRepo(repoAddr)?.active ||
        (this.epochs.get(repoAddr) ?? 0) !== entry.epoch) continue
      this.db.markScheduleFired(repoAddr, workflowPath, Math.floor(nowMs / 1000))

      const watch = this.repos.get(repoAddr)
      const announcement = watch ? this.currentAnnouncement(watch) : null
      const followed = this.db.getFollowedRepo(repoAddr)
      if (!watch?.baselineReady || !announcement || !followed) continue

      const defaultBranch = followed.defaultBranch ?? 'main'
      const ref = `refs/heads/${defaultBranch}`
      const commitId = this.db
        .getRefStates(repoAddr)
        .find(state => state.ref === ref && !state.deletedAt)?.commitId
      if (!commitId) {
        log.warn('scheduled run has no known default-branch commit', {repoAddr, ref})
        continue
      }

      await this.dispatch({
        repoAddr,
        workflowPath,
        trigger: 'schedule',
        ref,
        branch: defaultBranch,
        commitId,
        repoRelays: announcement.relays,
      })
    }
  }
}

async function firstOutboxes(nostr: NostrClient, pubkey: string): Promise<string[]> {
  const mailboxes = await nostr.loadReplaceable({kind: 10002, pubkey}, 4_000)
  return mailboxes ? normalizeRelays(getOutboxes(mailboxes)) : []
}

/**
 * The default branch comes from the state's `HEAD` tag. Without one, prefer
 * what we already recorded, then the conventional names if the state carries
 * them, then the first branch it does carry — anything but silently reading
 * `main` on a repo whose branches are all called something else.
 */
export function resolveDefaultBranch(state: RepoState, recorded: string | null): string {
  if (state.defaultBranch) return state.defaultBranch
  if (recorded) return recorded

  const branches = state.refs
    .filter(entry => entry.ref.startsWith('refs/heads/'))
    .map(entry => entry.ref.slice('refs/heads/'.length))
    .sort()

  for (const conventional of ['main', 'master']) {
    if (branches.includes(conventional)) return conventional
  }
  return branches[0] ?? 'main'
}
