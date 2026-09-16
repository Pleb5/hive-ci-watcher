import type {NostrEvent} from 'nostr-tools'
import type {WatcherConfig} from './config.js'
import type {WatcherDb} from './db/index.js'
import {dispatchRun, type DispatchOutcome} from './dispatch/submit.js'
import {fetchWorkflowTree, WorkflowTreeCache, type WorkflowTree} from './git/fetch.js'
import type {WatcherIdentity} from './identity.js'
import {createLogger, errorMessage} from './log.js'
import {
  KIND_LOOM_WORKER,
  KIND_REPO_ANNOUNCEMENT,
  KIND_REPO_STATE,
  parseLoomWorker,
  parseRepoAddress,
  parseRepoAnnouncement,
  parseRepoState,
  type LoomWorker,
  type RepoAnnouncement,
  type RepoState,
} from './nostr/events.js'
import {RelayManager} from './nostr/pool.js'
import {selectDueSchedules} from './triggers/cron.js'
import {evaluatePush} from './triggers/push.js'
import {diffRefs, selectRepoState, type RefDescriptor} from './triggers/refs.js'
import {parseWorkflowTree, type ParsedWorkflow} from './triggers/workflow.js'

const log = createLogger('watcher')

const KIND_DELETION = 5
const SCHEDULE_TICK_MS = 60_000
const RUNS_PRUNE_EVERY_TICKS = 60
/** How long startup waits for the 10100 subscription's EOSE before evaluating repos. */
const WORKER_DISCOVERY_TIMEOUT_MS = 10_000

export interface WatcherStatus {
  pubkey: string
  startedAt: number
  uptimeSeconds: number
  relays: ReturnType<RelayManager['health']>
  followedRepos: number
  knownWorkers: number
  runnerPool: number
  recentRuns: ReturnType<WatcherDb['recentRuns']>
}

/**
 * Whether an evaluation got far enough to be recorded.
 *
 * `ref_state` is written only for a *complete* evaluation: the tree was
 * fetched and every matching workflow was either dispatched or found nothing
 * to run. A fetch miss, an empty runner pool or a publish failure leaves the
 * row untouched, so the next state event for the repo (or a relay replay of
 * this one) evaluates the ref again. Without that, a thirty-second git outage
 * or a restart racing worker discovery would skip a commit's CI forever.
 */
type Completion = 'complete' | 'incomplete'

export class Watcher {
  readonly relays: RelayManager

  private readonly announcements = new Map<string, RepoAnnouncement>()
  /** Every 30618 seen per repo, keyed by author — the maintainer race is resolved at read time. */
  private readonly repoStates = new Map<string, Map<string, RepoState>>()
  private readonly workers = new Map<string, LoomWorker>()
  private readonly trees = new WorkflowTreeCache()
  /** Serialises evaluation per repo so two 30618s cannot interleave a ref diff. */
  private readonly repoQueues = new Map<string, Promise<void>>()

  private scheduleTimer: NodeJS.Timeout | null = null
  private scheduleTicks = 0
  private startedAt = 0
  private running = false
  /** Resolves once the first 10100 EOSE arrives (or the discovery timeout passes). */
  private workersReady: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: WatcherConfig,
    private readonly db: WatcherDb,
    private readonly identity: WatcherIdentity,
  ) {
    this.relays = new RelayManager(config.relays)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.startedAt = Math.floor(Date.now() / 1000)

    await this.relays.start()

    // Relays replay the latest 30618 for every followed repo the moment we
    // subscribe. If that lands before any 10100 has been seen, the runner
    // pool looks empty and every pending push would be dropped. Hold repo
    // evaluation until worker discovery has reached EOSE (bounded, so a
    // relay that never sends EOSE cannot stall startup).
    let markReady!: () => void
    this.workersReady = new Promise<void>(resolve => {
      markReady = resolve
    })
    const discoveryTimer = setTimeout(() => {
      log.warn('worker discovery timed out, evaluating repos anyway')
      markReady()
    }, WORKER_DISCOVERY_TIMEOUT_MS)

    await this.relays.subscribe(
      'workers',
      [{kinds: [KIND_LOOM_WORKER]}],
      event => this.onWorkerAd(event),
      () => {
        clearTimeout(discoveryTimer)
        markReady()
      },
    )

    for (const repo of this.db.listFollowedRepos()) {
      await this.watchRepo(repo.repoAddr, repo.repoOwner, repo.dTag)
    }

    this.scheduleTimer = setInterval(() => {
      void this.runScheduleTick().catch(err =>
        log.error('schedule tick failed', {error: errorMessage(err)}),
      )
    }, SCHEDULE_TICK_MS)

    log.info('watcher started', {pubkey: this.identity.pubkey, repos: this.announcements.size})
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    this.scheduleTimer = null
    await Promise.allSettled([...this.repoQueues.values()])
    await this.relays.stop()
  }

  status(): WatcherStatus {
    return {
      pubkey: this.identity.pubkey,
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt ? Math.floor(Date.now() / 1000) - this.startedAt : 0,
      relays: this.relays.health(),
      followedRepos: this.db.listFollowedRepos().length,
      knownWorkers: this.workers.size,
      runnerPool: this.db.listRunnerPool().length,
      recentRuns: this.db.recentRuns(10),
    }
  }

  knownWorkers(): Map<string, LoomWorker> {
    return this.workers
  }

  // ── follow management ─────────────────────────────────────────────────────

  /** Called by the CVM `follow_repo` tool once the row exists. */
  async watchRepo(repoAddr: string, repoOwner: string, dTag: string): Promise<void> {
    await this.relays.subscribe(
      `announcement:${repoAddr}`,
      [{kinds: [KIND_REPO_ANNOUNCEMENT], authors: [repoOwner], '#d': [dTag]}],
      event => this.onAnnouncement(repoAddr, event),
    )

    // NIP-09 deletion of the announcement by its owner: the repo is gone.
    await this.relays.subscribe(
      `deletion:${repoAddr}`,
      [{kinds: [KIND_DELETION], authors: [repoOwner], '#a': [repoAddr]}],
      event => this.onAnnouncementDeleted(repoAddr, event),
    )

    // Subscribe to state from the owner immediately. The filter is widened to
    // the full maintainer set as soon as the owner's 30617 arrives.
    await this.subscribeState(repoAddr, dTag, [repoOwner])
  }

  /**
   * Waits for any in-flight evaluation first: a `putRefState` landing after
   * the follow row is gone would leave orphan rows that make a later
   * re-follow skip its seed.
   */
  async unwatchRepo(repoAddr: string): Promise<void> {
    this.relays.unsubscribe(`announcement:${repoAddr}`)
    this.relays.unsubscribe(`deletion:${repoAddr}`)
    this.relays.unsubscribe(`state:${repoAddr}`)
    this.announcements.delete(repoAddr)
    this.repoStates.delete(repoAddr)
    this.trees.invalidateRepo(repoAddr)
    const pending = this.repoQueues.get(repoAddr)
    if (pending) await pending.catch(() => undefined)
    this.repoQueues.delete(repoAddr)
  }

  private async subscribeState(repoAddr: string, dTag: string, authors: string[]): Promise<void> {
    await this.relays.subscribe(
      `state:${repoAddr}`,
      [{kinds: [KIND_REPO_STATE], authors, '#d': [dTag]}],
      event => this.onRepoState(repoAddr, event),
    )
  }

  // ── event handlers ────────────────────────────────────────────────────────

  private onWorkerAd(event: NostrEvent): void {
    const worker = parseLoomWorker(event)
    if (!worker) return
    const existing = this.workers.get(worker.pubkey)
    if (existing && existing.lastSeen >= worker.lastSeen) return
    this.workers.set(worker.pubkey, worker)
  }

  private onAnnouncement(repoAddr: string, event: NostrEvent): void {
    const announcement = parseRepoAnnouncement(event)
    if (!announcement || announcement.repoAddr !== repoAddr) return

    const previous = this.announcements.get(repoAddr)
    if (previous && previous.createdAt >= announcement.createdAt) return

    this.announcements.set(repoAddr, announcement)
    // A tree fetched from the old `clone` list may not reflect the new one.
    this.trees.invalidateRepo(repoAddr)

    void this.onAnnouncementUpdated(repoAddr, announcement, previous).catch(err =>
      log.error('announcement handling failed', {repoAddr, error: errorMessage(err)}),
    )
  }

  private onAnnouncementDeleted(repoAddr: string, event: NostrEvent): void {
    const current = this.announcements.get(repoAddr)
    // A deletion older than the announcement we hold does not apply to it.
    if (!current || event.created_at < current.createdAt) return
    log.warn('repo announcement deleted by owner; suspending evaluation', {repoAddr})
    this.announcements.delete(repoAddr)
    this.trees.invalidateRepo(repoAddr)
  }

  private async onAnnouncementUpdated(
    repoAddr: string,
    announcement: RepoAnnouncement,
    previous: RepoAnnouncement | undefined,
  ): Promise<void> {
    // Relay set = configured defaults ∪ every relay named by a followed repo.
    await this.relays.setRelays([
      ...this.config.relays,
      ...[...this.announcements.values()].flatMap(entry => entry.relays),
    ])

    const maintainersChanged =
      !previous ||
      previous.maintainers.slice().sort().join(',') !==
        announcement.maintainers.slice().sort().join(',')

    if (maintainersChanged) {
      // Rebuilt whenever the owner's 30617 changes its maintainer set: a
      // maintainer dropped from the announcement stops being accepted from
      // that moment on.
      await this.subscribeState(repoAddr, announcement.dTag, announcement.maintainers)

      const allowed = new Set(announcement.maintainers.map(pubkey => pubkey.toLowerCase()))
      const states = this.repoStates.get(repoAddr)
      if (states) {
        for (const author of [...states.keys()]) {
          if (!allowed.has(author.toLowerCase())) states.delete(author)
        }
      }
    }

    // A fresh announcement can change the clone list, which changes which
    // workflows we would read. Re-evaluate whatever state we already hold.
    this.enqueue(repoAddr, () => this.evaluateRepo(repoAddr))
  }

  private onRepoState(repoAddr: string, event: NostrEvent): void {
    const parsed = parseRepoAddress(repoAddr)
    if (!parsed) return

    const state = parseRepoState(event, parsed.owner)
    if (!state || state.repoAddr !== repoAddr) return

    let states = this.repoStates.get(repoAddr)
    if (!states) {
      states = new Map()
      this.repoStates.set(repoAddr, states)
    }

    const existing = states.get(state.author)
    if (existing && existing.createdAt >= state.createdAt) return
    states.set(state.author, state)

    this.enqueue(repoAddr, () => this.evaluateRepo(repoAddr))
  }

  /**
   * Serialises work per repo. Two 30618s arriving back to back must not both
   * read `ref_state` before either writes it, or the second would re-dispatch
   * everything the first already handled.
   */
  private enqueue(repoAddr: string, task: () => Promise<void>): void {
    const previous = this.repoQueues.get(repoAddr) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => this.workersReady)
      .then(task)
      .catch(err => log.error('repo evaluation failed', {repoAddr, error: errorMessage(err)}))
    this.repoQueues.set(repoAddr, next)
  }

  // ── push pipeline (§3.2) ──────────────────────────────────────────────────

  private async evaluateRepo(repoAddr: string): Promise<void> {
    const announcement = this.announcements.get(repoAddr)
    if (!announcement) {
      log.debug('no announcement yet, deferring evaluation', {repoAddr})
      return
    }

    const candidates = [...(this.repoStates.get(repoAddr)?.values() ?? [])]
    const state = selectRepoState(candidates, announcement.maintainers)
    if (!state) {
      log.debug('no acceptable repo state', {repoAddr, candidates: candidates.length})
      return
    }

    const followed = this.db.getFollowedRepo(repoAddr)
    if (!followed) return

    const defaultBranch = resolveDefaultBranch(state, followed.defaultBranch)
    if (defaultBranch !== followed.defaultBranch) this.db.setDefaultBranch(repoAddr, defaultBranch)

    // Trigger source: the default branch at *its* current state commit. Read
    // once per evaluation and shared across every changed ref.
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

    // First state ever seen for this follow: record every ref, dispatch
    // nothing. The refs already exist; nothing was pushed.
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
    // Without the default branch's copy we cannot know which triggers apply;
    // guessing from the pushed ref alone would let a push rewrite its own
    // rules (§3.2 step 5).
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

    // No concurrency caps: a push to a ref whose previous run is still in
    // flight fires anyway, and one 30618 moving a branch and adding a tag at
    // the same commit produces two runs. GitHub behaves the same way.
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

  private dispatch(request: Parameters<typeof dispatchRun>[1]): Promise<DispatchOutcome> {
    return dispatchRun(
      {
        config: this.config,
        db: this.db,
        identity: this.identity,
        relays: this.relays,
        workers: () => this.workers,
      },
      request,
    )
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
        fetchWorkflowTree({
          cloneUrls: announcement.cloneUrls,
          commitId,
          refName,
        }),
      )
    } catch (err) {
      log.warn('workflow fetch threw', {
        repoAddr: announcement.repoAddr,
        commitId,
        error: errorMessage(err),
      })
      return {workflows: [], fetched: false}
    }

    if (!tree) return {workflows: [], fetched: false}
    return {workflows: parseWorkflowTree(tree), fetched: true}
  }

  // ── schedule pipeline (§3.3) ──────────────────────────────────────────────

  async runScheduleTick(nowMs = Date.now()): Promise<void> {
    this.scheduleTicks += 1
    if (this.scheduleTicks % RUNS_PRUNE_EVERY_TICKS === 0) {
      const pruned = this.db.pruneRuns()
      if (pruned > 0) log.debug('pruned run history', {pruned})
    }

    const due = selectDueSchedules(this.db.listSchedules(), nowMs)
    if (due.length === 0) return

    for (const entry of due) {
      const {repoAddr, workflowPath} = entry.schedule
      // Mark fired before dispatching. `last_fired_at = now` — not the
      // occurrence — is what coalesces every missed fire into this one.
      this.db.markScheduleFired(repoAddr, workflowPath, Math.floor(nowMs / 1000))

      const announcement = this.announcements.get(repoAddr)
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
  }
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
