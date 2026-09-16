import {groupPubkeysByRelay} from 'applesauce-core/helpers/relay-selection'
import {getOutboxes} from 'applesauce-core/helpers/mailboxes'
import {mergeRelaySets} from 'applesauce-core/helpers/relays'
import {nip19} from 'nostr-tools'
import {
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  map,
  of,
  shareReplay,
  switchMap,
  type Observable,
  type Subscription,
} from 'rxjs'
import type {WatcherConfig} from './config.js'
import type {WatcherDb} from './db/index.js'
import {dispatchRun, type DispatchOutcome, type DispatchRequest} from './dispatch/submit.js'
import {fetchWorkflowTree, WorkflowTreeCache, type WorkflowTree} from './git/fetch.js'
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
import {parseWorkflowTree, type ParsedWorkflow} from './triggers/workflow.js'

const log = createLogger('watcher')

const KIND_DELETION = 5
const SCHEDULE_TICK_MS = 60_000
const RUNS_PRUNE_EVERY_TICKS = 60
/** Startup: how long to wait for every default relay to EOSE the 10100 request. */
const WORKER_DISCOVERY_TIMEOUT_MS = 10_000
/** Follow: how long to wait before saying "no announcement found anywhere". */
const ANNOUNCEMENT_PROBE_TIMEOUT_MS = 8_000
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

type Completion = 'complete' | 'incomplete'

interface RepoWatch {
  repoAddr: string
  owner: string
  dTag: string
  subscriptions: Subscription[]
  announcement$: Observable<RepoAnnouncement | null>
  /** Set once the probe has run, so `list_followed` can say why a repo is idle. */
  probe: {checkedAt: number; found: boolean; relays: string[]} | null
}

export class Watcher {
  readonly nostr: NostrClient

  private readonly repos = new Map<string, RepoWatch>()
  private workers = new Map<string, LoomWorker>()
  private readonly trees = new WorkflowTreeCache()
  /** Serialises evaluation per repo so two 30618s cannot interleave a ref diff. */
  private readonly repoQueues = new Map<string, Promise<void>>()
  private readonly internal: Subscription[] = []

  private scheduleTimer: NodeJS.Timeout | null = null
  private scheduleTicks = 0
  private tickInProgress = false
  private startedAt = 0
  private running = false

  constructor(
    private readonly config: WatcherConfig,
    private readonly db: WatcherDb,
    private readonly identity: WatcherIdentity,
  ) {
    this.nostr = new NostrClient(config.relays)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.startedAt = Math.floor(Date.now() / 1000)

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

    this.internal.push(this.nostr.subscribe(this.nostr.defaults$, {kinds: [KIND_LOOM_WORKER]}, 'workers'))

    for (const repo of this.db.listFollowedRepos()) {
      await this.watchRepo(repo.repoAddr, repo.repoOwner, repo.dTag, repo.relayHints)
    }

    this.scheduleTimer = setInterval(() => {
      void this.runScheduleTick().catch(err =>
        log.error('schedule tick failed', {error: errorMessage(err)}),
      )
    }, SCHEDULE_TICK_MS)

    log.info('watcher started', {pubkey: this.identity.pubkey, repos: this.repos.size})
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    this.scheduleTimer = null
    for (const watch of this.repos.values()) for (const sub of watch.subscriptions) sub.unsubscribe()
    this.repos.clear()
    for (const sub of this.internal) sub.unsubscribe()
    await Promise.allSettled([...this.repoQueues.values()])
    this.nostr.close()
  }

  status(): WatcherStatus {
    return {
      pubkey: this.identity.pubkey,
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt ? Math.floor(Date.now() / 1000) - this.startedAt : 0,
      relays: this.nostr.report(),
      followedRepos: this.db.listFollowedRepos().length,
      knownWorkers: this.workers.size,
      runnerPool: this.db.listRunnerPool().length,
      recentRuns: this.db.recentRuns(10),
    }
  }

  knownWorkers(): Map<string, LoomWorker> {
    return this.workers
  }

  /** What the follow-time probe found, for `list_followed`. */
  repoProbe(repoAddr: string): RepoWatch['probe'] {
    return this.repos.get(repoAddr)?.probe ?? null
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
    if (this.repos.has(repoAddr)) return

    const store = this.nostr.store
    const hintRelays = normalizeRelays(hints)
    const subscriptions: Subscription[] = []

    const announcementRelays$ = combineLatest([of(hintRelays), this.nostr.outboxes$(owner)]).pipe(
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
        .subscribe(() => this.enqueue(repoAddr, () => this.evaluateRepo(repoAddr))),
    )

    const watch: RepoWatch = {repoAddr, owner, dTag, subscriptions, announcement$, probe: null}
    this.repos.set(repoAddr, watch)

    // Say so if the announcement is nowhere we can see. The live subscription
    // stays up regardless — a relay may serve it later — but silence here is
    // the failure mode an operator cannot otherwise diagnose.
    void this.probeAnnouncement(watch, hintRelays).catch(err =>
      log.warn('announcement probe failed', {repoAddr, error: errorMessage(err)}),
    )
  }

  private async probeAnnouncement(watch: RepoWatch, hintRelays: string[]): Promise<void> {
    // Give the owner's 10002 a moment to arrive so their outboxes are probed too.
    await new Promise(resolve => setTimeout(resolve, 2_000))
    const outboxes = await firstOutboxes(this.nostr, watch.owner)
    const relays = normalizeRelays(mergeRelaySets(this.nostr.defaults, hintRelays, outboxes))

    const found = await this.nostr.requestAll(
      relays,
      {kinds: [KIND_REPO_ANNOUNCEMENT], authors: [watch.owner], '#d': [watch.dTag]},
      ANNOUNCEMENT_PROBE_TIMEOUT_MS,
      `probe:${watch.repoAddr}`,
    )
    const present = found.length > 0 || !!this.nostr.store.getReplaceable(KIND_REPO_ANNOUNCEMENT, watch.owner, watch.dTag)
    watch.probe = {checkedAt: Math.floor(Date.now() / 1000), found: present, relays}

    if (!present) {
      log.warn('repo announcement not found on any reachable relay', {
        repoAddr: watch.repoAddr,
        relays,
        ownerOutboxes: outboxes.length,
        hint: 'follow with an naddr carrying relay hints, or ask the owner to publish a kind 10002',
      })
    }
  }

  /**
   * Waits for any in-flight evaluation first: a `putRefState` landing after
   * the follow row is gone would leave orphan rows that make a later
   * re-follow skip its seed.
   */
  async unwatchRepo(repoAddr: string): Promise<void> {
    const watch = this.repos.get(repoAddr)
    if (watch) for (const sub of watch.subscriptions) sub.unsubscribe()
    this.repos.delete(repoAddr)
    this.trees.invalidateRepo(repoAddr)
    const pending = this.repoQueues.get(repoAddr)
    if (pending) await pending.catch(() => undefined)
    this.repoQueues.delete(repoAddr)
  }

  /**
   * Serialises work per repo. Two 30618s arriving back to back must not both
   * read `ref_state` before either writes it, or the second would re-dispatch
   * everything the first already handled.
   */
  private enqueue(repoAddr: string, task: () => Promise<void>): void {
    if (!this.repos.has(repoAddr)) return
    const previous = this.repoQueues.get(repoAddr) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch(err => log.error('repo evaluation failed', {repoAddr, error: errorMessage(err)}))
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

  private async evaluateRepo(repoAddr: string): Promise<void> {
    const watch = this.repos.get(repoAddr)
    if (!watch) return

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

    const defaultRefName = `refs/heads/${defaultBranch}`
    const defaultCommit = state.refs.find(entry => entry.ref === defaultRefName)?.commitId ?? null
    const defaultTree = defaultCommit
      ? await this.loadWorkflows(announcement, defaultCommit, defaultRefName)
      : {workflows: [], fetched: true}

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
      const completion = await this.evaluateRefChange({
        announcement,
        defaultWorkflows: defaultTree.workflows,
        defaultFetched: defaultTree.fetched,
        ref: change.descriptor,
        commitId: change.commitId,
        repoAddr,
      })

      if (completion === 'complete') {
        this.db.putRefState(repoAddr, change.descriptor.ref, change.commitId)
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
  }): Promise<Completion> {
    if (!args.defaultFetched) return 'incomplete'

    const pushed = await this.loadWorkflows(args.announcement, args.commitId, args.ref.ref)
    if (!pushed.fetched) return 'incomplete'

    const paths = evaluatePush({
      ref: args.ref,
      defaultBranchWorkflows: args.defaultWorkflows,
      pushedRefWorkflows: pushed.workflows,
    })

    if (paths.length === 0) {
      log.debug('no workflow matched', {repoAddr: args.repoAddr, ref: args.ref.ref})
      return 'complete'
    }

    let completion: Completion = 'complete'
    for (const workflowPath of paths) {
      const outcome = await this.dispatch({
        repoAddr: args.repoAddr,
        workflowPath,
        trigger: 'push',
        ref: args.ref.ref,
        branch: args.ref.shortName,
        commitId: args.commitId,
        repoRelays: args.announcement.relays,
      })
      if (outcome.status !== 'dispatched') completion = 'incomplete'
    }
    return completion
  }

  private async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    const deps = {
      config: this.config,
      db: this.db,
      identity: this.identity,
      nostr: this.nostr,
      workers: () => this.workers,
    }
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<DispatchOutcome>(resolve => {
      timer = setTimeout(
        () => resolve({status: 'failed', error: `dispatch exceeded ${DISPATCH_DEADLINE_MS} ms`}),
        DISPATCH_DEADLINE_MS,
      )
    })
    try {
      return await Promise.race([dispatchRun(deps, request), deadline])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async loadWorkflows(
    announcement: RepoAnnouncement,
    commitId: string,
    refName: string,
  ): Promise<{workflows: ParsedWorkflow[]; fetched: boolean}> {
    if (announcement.cloneUrls.length === 0) {
      log.warn('repo announcement has no usable clone urls', {repoAddr: announcement.repoAddr})
      return {workflows: [], fetched: false}
    }

    let tree: WorkflowTree | null = null
    try {
      tree = await this.trees.get(announcement.repoAddr, commitId, () =>
        fetchWorkflowTree({cloneUrls: announcement.cloneUrls, commitId, refName}),
      )
    } catch (err) {
      log.warn('workflow fetch threw', {repoAddr: announcement.repoAddr, commitId, error: errorMessage(err)})
      return {workflows: [], fetched: false}
    }

    if (!tree) return {workflows: [], fetched: false}
    return {workflows: parseWorkflowTree(tree), fetched: true}
  }

  // ── schedule pipeline (§3.3) ──────────────────────────────────────────────

  async runScheduleTick(nowMs = Date.now()): Promise<void> {
    // A tick stalled on a dispatch is not joined by the next one; it is
    // skipped and logged, so a stall surfaces instead of piling up.
    if (this.tickInProgress) {
      log.warn('schedule tick still running, skipping this one')
      return
    }
    this.tickInProgress = true
    try {
      this.scheduleTicks += 1
      if (this.scheduleTicks % RUNS_PRUNE_EVERY_TICKS === 0) {
        const pruned = this.db.pruneRuns()
        if (pruned > 0) log.debug('pruned run history', {pruned})
      }

      const due = selectDueSchedules(this.db.listSchedules(), nowMs)
      for (const entry of due) {
        const {repoAddr, workflowPath} = entry.schedule
        this.db.markScheduleFired(repoAddr, workflowPath, Math.floor(nowMs / 1000))

        const watch = this.repos.get(repoAddr)
        const announcement = watch ? this.currentAnnouncement(watch) : null
        const followed = this.db.getFollowedRepo(repoAddr)
        if (!announcement || !followed) continue

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
    } finally {
      this.tickInProgress = false
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

