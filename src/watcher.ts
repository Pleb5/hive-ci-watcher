import type {NostrEvent} from 'nostr-tools'
import type {WatcherConfig} from './config.js'
import type {WatcherDb} from './db/index.js'
import {dispatchRun} from './dispatch/submit.js'
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

const SCHEDULE_TICK_MS = 60_000

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
  private startedAt = 0
  private running = false

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
    await this.relays.subscribe('workers', [{kinds: [KIND_LOOM_WORKER]}], event =>
      this.onWorkerAd(event),
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

    // Subscribe to state from the owner immediately. The filter is widened to
    // the full maintainer set as soon as the owner's 30617 arrives.
    await this.subscribeState(repoAddr, dTag, [repoOwner])
  }

  unwatchRepo(repoAddr: string): void {
    this.relays.unsubscribe(`announcement:${repoAddr}`)
    this.relays.unsubscribe(`state:${repoAddr}`)
    this.announcements.delete(repoAddr)
    this.repoStates.delete(repoAddr)
    this.trees.invalidateRepo(repoAddr)
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

    const defaultBranch = state.defaultBranch ?? followed.defaultBranch ?? 'main'
    if (defaultBranch !== followed.defaultBranch) this.db.setDefaultBranch(repoAddr, defaultBranch)

    const diff = diffRefs(state.refs, this.db.getRefStates(repoAddr))

    for (const ref of diff.deleted) {
      this.db.deleteRefState(repoAddr, ref)
      log.info('ref deleted', {repoAddr, ref})
    }

    // Trigger source: the default branch at *its* current state commit. Read
    // once per evaluation and shared across every changed ref.
    const defaultRefName = `refs/heads/${defaultBranch}`
    const defaultCommit = state.refs.find(entry => entry.ref === defaultRefName)?.commitId ?? null
    const defaultWorkflows = defaultCommit
      ? await this.loadWorkflows(announcement, defaultCommit, defaultRefName)
      : []

    if (defaultCommit) {
      this.db.replaceSchedules(
        repoAddr,
        defaultWorkflows.flatMap(workflow =>
          workflow.schedules.map(cron => ({workflowPath: workflow.path, cron})),
        ),
      )
    }

    for (const change of diff.changed) {
      try {
        await this.evaluateRefChange({
          announcement,
          defaultWorkflows,
          ref: change.descriptor,
          commitId: change.commitId,
          repoAddr,
        })
      } finally {
        // Written unconditionally. There are no retries, so a dispatch failure
        // is logged and dropped, not replayed on the next unrelated 30618.
        this.db.putRefState(repoAddr, change.descriptor.ref, change.commitId)
      }
    }
  }

  private async evaluateRefChange(args: {
    announcement: RepoAnnouncement
    defaultWorkflows: ParsedWorkflow[]
    ref: RefDescriptor
    commitId: string
    repoAddr: string
  }): Promise<void> {
    const pushedWorkflows = await this.loadWorkflows(
      args.announcement,
      args.commitId,
      args.ref.ref,
    )

    const paths = evaluatePush({
      ref: args.ref,
      defaultBranchWorkflows: args.defaultWorkflows,
      pushedRefWorkflows: pushedWorkflows,
    })

    if (paths.length === 0) {
      log.debug('no workflow matched', {repoAddr: args.repoAddr, ref: args.ref.ref})
      return
    }

    // No concurrency caps: a push to a ref whose previous run is still in
    // flight fires anyway, and one 30618 moving a branch and adding a tag at
    // the same commit produces two runs. GitHub behaves the same way.
    for (const workflowPath of paths) {
      await dispatchRun(
        {
          config: this.config,
          db: this.db,
          identity: this.identity,
          relays: this.relays,
          workers: () => this.workers,
        },
        {
          repoAddr: args.repoAddr,
          workflowPath,
          trigger: 'push',
          ref: args.ref.ref,
          branch: args.ref.shortName,
          commitId: args.commitId,
          repoRelays: args.announcement.relays,
        },
      )
    }
  }

  private async loadWorkflows(
    announcement: RepoAnnouncement,
    commitId: string,
    refName: string,
  ): Promise<ParsedWorkflow[]> {
    if (announcement.cloneUrls.length === 0) {
      log.warn('repo announcement has no clone urls', {repoAddr: announcement.repoAddr})
      return []
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
      return []
    }

    if (!tree) return []
    return parseWorkflowTree(tree)
  }

  // ── schedule pipeline (§3.3) ──────────────────────────────────────────────

  async runScheduleTick(nowMs = Date.now()): Promise<void> {
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
      const commitId = this.db.getRefStates(repoAddr).find(state => state.ref === ref)?.commitId
      if (!commitId) {
        log.warn('scheduled run has no known default-branch commit', {repoAddr, ref})
        continue
      }

      await dispatchRun(
        {
          config: this.config,
          db: this.db,
          identity: this.identity,
          relays: this.relays,
          workers: () => this.workers,
        },
        {
          repoAddr,
          workflowPath,
          trigger: 'schedule',
          ref,
          branch: defaultBranch,
          commitId,
          repoRelays: announcement.relays,
        },
      )
    }
  }
}
