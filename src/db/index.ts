import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import Database from 'better-sqlite3'
import {SCHEMA_SQL} from './schema.js'

export interface FollowedRepo {
  repoAddr: string
  repoOwner: string
  dTag: string
  defaultBranch: string | null
  addedBy: string
  addedAt: number
  seededAt: number | null
  relayHints: string[]
  active: boolean
}

export interface RepoRegistration {
  repoAddr: string
  requester: string
  addedAt: number
  relayHints: string[]
}

export interface RefState {
  repoAddr: string
  ref: string
  commitId: string
  updatedAt: number
  deletedAt: number | null
}

export interface ScheduleRow {
  repoAddr: string
  workflowPath: string
  cron: string
  lastFiredAt: number
}

export interface RunRow {
  runId: string
  repoAddr: string
  ref: string
  commitId: string
  workflowPath: string
  runnerPubkey: string
  trigger: string
  createdAt: number
}

export interface RunJob {
  runId: string
  jobId: string
  runnerPubkey: string
  inboxes: string[]
  outboxes: string[]
  state: 'unconfirmed' | 'published' | 'queued' | 'running' | 'completed' | 'failed'
  evidence: import('nostr-tools').NostrEvent | null
  updatedAt: number
  pendingEvaluation: boolean
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function parseHints(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export class WatcherDb {
  private readonly db: Database.Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true})
    this.db = new Database(path)
    this.db.exec(SCHEMA_SQL)
    this.migrate()
  }

  /**
   * Additive migrations for databases created by an earlier schema.
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so columns
   * added later are checked for and appended here.
   */
  private migrate(): void {
    const ensureColumn = (table: string, column: string, definition: string) => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>
      if (columns.some(entry => entry.name === column)) return
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    ensureColumn('followed_repos', 'seeded_at', 'INTEGER')
    ensureColumn('followed_repos', 'relay_hints', "TEXT NOT NULL DEFAULT '[]'")
    ensureColumn('ref_state', 'deleted_at', 'INTEGER')
    ensureColumn('followed_repos', 'active', 'INTEGER NOT NULL DEFAULT 0')
    // A one-time backfill, never recreated from historical added_by after a
    // requester removes their registration and another requester remains.
    this.db.transaction(() => {
      if (this.getKv('schema:registrations:v1')) return
      this.db.exec(`INSERT OR IGNORE INTO repo_registrations (repo_addr, requester, added_at, relay_hints)
        SELECT repo_addr, added_by, added_at, relay_hints FROM followed_repos`)
      this.setKv('schema:registrations:v1', '1')
    })()
  }

  close(): void {
    this.db.close()
  }

  recordJob(job: Omit<RunJob, 'runnerPubkey' | 'evidence' | 'updatedAt' | 'pendingEvaluation'>): void {
    this.db.prepare(`INSERT INTO run_jobs (run_id, job_id, inboxes, outboxes, state, pending_evaluation, updated_at)
      VALUES (?, ?, ?, ?, ?, (SELECT trigger = 'push' FROM runs WHERE run_id = ?), ?)`)
      .run(job.runId, job.jobId, JSON.stringify(job.inboxes), JSON.stringify(job.outboxes), job.state, job.runId, nowSeconds())
  }

  pendingRunFor(request: Pick<RunRow, 'repoAddr' | 'ref' | 'commitId' | 'workflowPath'>): Pick<RunRow, 'runId' | 'runnerPubkey'> | null {
    const row = this.db.prepare(`SELECT r.run_id, r.runner_pubkey FROM runs r JOIN run_jobs j ON r.run_id = j.run_id
      WHERE j.pending_evaluation = 1 AND r.trigger = 'push' AND r.repo_addr = ? AND r.ref = ? AND r.commit_id = ? AND r.workflow_path = ?
      ORDER BY r.created_at DESC LIMIT 1`).get(request.repoAddr, request.ref, request.commitId, request.workflowPath) as {run_id: string; runner_pubkey: string} | undefined
    return row ? {runId: row.run_id, runnerPubkey: row.runner_pubkey} : null
  }

  jobs(): RunJob[] {
    return this.db.prepare(`SELECT j.*, r.runner_pubkey FROM run_jobs j JOIN runs r ON r.run_id = j.run_id`).all().map((row: any) => ({
      runId: row.run_id, jobId: row.job_id, runnerPubkey: row.runner_pubkey,
      inboxes: parseHints(row.inboxes), outboxes: parseHints(row.outboxes), state: row.state,
      evidence: row.evidence ? JSON.parse(row.evidence) : null, updatedAt: row.updated_at, pendingEvaluation: !!row.pending_evaluation,
    }))
  }

  updateJob(jobId: string, state: RunJob['state'], evidence?: import('nostr-tools').NostrEvent): void {
    // Relay ACK can arrive after worker evidence; never demote an execution state.
    this.db.prepare(`UPDATE run_jobs SET state = ?, evidence = COALESCE(?, evidence), updated_at = ? WHERE job_id = ?
      ${evidence ? '' : "AND evidence IS NULL"}`)
      .run(state, evidence ? JSON.stringify(evidence) : null, nowSeconds(), jobId)
  }

  // ── followed repos ──────────────────────────────────────────────────────

  followRepo(repo: {
    repoAddr: string
    repoOwner: string
    dTag: string
    addedBy: string
    relayHints?: string[]
  }): void {
    this.db.transaction(() => {
      const existing = this.listRegistrations(repo.repoAddr).find(r => r.requester === repo.addedBy)
      const hints = JSON.stringify([...new Set([...(existing?.relayHints ?? []), ...(repo.relayHints ?? [])])])
      this.db.prepare(
        `INSERT INTO followed_repos (repo_addr, repo_owner, d_tag, default_branch, added_by, added_at, seeded_at, relay_hints)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)
         ON CONFLICT(repo_addr) DO NOTHING`,
      )
      .run(repo.repoAddr, repo.repoOwner, repo.dTag, repo.addedBy, nowSeconds(), hints)
      this.db.prepare(`INSERT INTO repo_registrations (repo_addr, requester, added_at, relay_hints)
        VALUES (?, ?, ?, ?) ON CONFLICT(repo_addr, requester) DO UPDATE SET relay_hints = excluded.relay_hints`)
        .run(repo.repoAddr, repo.addedBy, nowSeconds(), hints)
      this.updateRegistrationHints(repo.repoAddr)
    })()
  }

  listRegistrations(repoAddr?: string): RepoRegistration[] {
    const rows = repoAddr
      ? this.db.prepare('SELECT * FROM repo_registrations WHERE repo_addr = ? ORDER BY added_at, requester').all(repoAddr)
      : this.db.prepare('SELECT * FROM repo_registrations ORDER BY added_at, requester').all()
    return rows.map((row: any) => ({repoAddr: row.repo_addr, requester: row.requester, addedAt: row.added_at, relayHints: parseHints(row.relay_hints)}))
  }

  hasRegistration(pubkey: string, repoAddr?: string): boolean {
    return (repoAddr
      ? this.db.prepare('SELECT 1 FROM repo_registrations WHERE requester = ? AND repo_addr = ?').get(pubkey, repoAddr)
      : this.db.prepare('SELECT 1 FROM repo_registrations WHERE requester = ?').get(pubkey)) !== undefined
  }

  removeRegistration(repoAddr: string, requester?: string): boolean {
    return this.db.transaction(() => {
      const result = requester
        ? this.db.prepare('DELETE FROM repo_registrations WHERE repo_addr = ? AND requester = ?').run(repoAddr, requester)
        : this.db.prepare('DELETE FROM repo_registrations WHERE repo_addr = ?').run(repoAddr)
      this.updateRegistrationHints(repoAddr)
      return result.changes > 0
    })()
  }

  private updateRegistrationHints(repoAddr: string): void {
    const hints = [...new Set(this.listRegistrations(repoAddr).flatMap(registration => registration.relayHints))]
    this.db.prepare('UPDATE followed_repos SET relay_hints = ? WHERE repo_addr = ?').run(JSON.stringify(hints), repoAddr)
  }

  setRepoActive(repoAddr: string, active: boolean): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE run_jobs SET pending_evaluation = 0 WHERE run_id IN (SELECT run_id FROM runs WHERE repo_addr = ?)`).run(repoAddr)
      this.db.prepare('UPDATE followed_repos SET active = ?, seeded_at = NULL WHERE repo_addr = ?').run(active ? 1 : 0, repoAddr)
      this.db.prepare('DELETE FROM ref_state WHERE repo_addr = ?').run(repoAddr)
      this.db.prepare('DELETE FROM schedules WHERE repo_addr = ?').run(repoAddr)
    })()
  }

  /**
   * Removes the repo and everything derived from it. `ref_state` must go with
   * it: a re-follow should evaluate the repo fresh rather than silently
   * skipping every ref that has not moved since the last unfollow.
   */
  unfollowRepo(repoAddr: string): boolean {
    const tx = this.db.transaction((addr: string) => {
      this.db.prepare('DELETE FROM ref_state WHERE repo_addr = ?').run(addr)
      this.db.prepare('DELETE FROM schedules WHERE repo_addr = ?').run(addr)
      return this.db.prepare('DELETE FROM followed_repos WHERE repo_addr = ?').run(addr).changes > 0
    })
    return tx(repoAddr)
  }

  listFollowedRepos(): FollowedRepo[] {
    return this.db
      .prepare(
        `SELECT repo_addr, repo_owner, d_tag, default_branch, added_by, added_at, seeded_at, relay_hints, active
         FROM followed_repos ORDER BY added_at ASC`,
      )
      .all()
      .map((row: any) => ({
        repoAddr: row.repo_addr,
        repoOwner: row.repo_owner,
        dTag: row.d_tag,
        defaultBranch: row.default_branch,
        addedBy: row.added_by,
        addedAt: row.added_at,
        seededAt: row.seeded_at,
        relayHints: parseHints(row.relay_hints),
        active: !!row.active,
      }))
  }

  getFollowedRepo(repoAddr: string): FollowedRepo | null {
    const row: any = this.db
      .prepare(
        `SELECT repo_addr, repo_owner, d_tag, default_branch, added_by, added_at, seeded_at, relay_hints, active
         FROM followed_repos WHERE repo_addr = ?`,
      )
      .get(repoAddr)
    if (!row) return null
    return {
      repoAddr: row.repo_addr,
      repoOwner: row.repo_owner,
      dTag: row.d_tag,
      defaultBranch: row.default_branch,
      addedBy: row.added_by,
      addedAt: row.added_at,
      seededAt: row.seeded_at,
      relayHints: parseHints(row.relay_hints),
      active: !!row.active,
    }
  }

  markSeeded(repoAddr: string): void {
    this.db
      .prepare('UPDATE followed_repos SET seeded_at = ? WHERE repo_addr = ? AND seeded_at IS NULL')
      .run(nowSeconds(), repoAddr)
  }

  setDefaultBranch(repoAddr: string, defaultBranch: string): void {
    this.db
      .prepare('UPDATE followed_repos SET default_branch = ? WHERE repo_addr = ?')
      .run(defaultBranch, repoAddr)
  }

  // ── ref state ───────────────────────────────────────────────────────────

  /** Every row, tombstones included — `diffRefs` needs both. */
  getRefStates(repoAddr: string): RefState[] {
    return this.db
      .prepare('SELECT repo_addr, ref, commit_id, updated_at, deleted_at FROM ref_state WHERE repo_addr = ?')
      .all(repoAddr)
      .map((row: any) => ({
        repoAddr: row.repo_addr,
        ref: row.ref,
        commitId: row.commit_id,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
      }))
  }

  /** Records a live ref, clearing any tombstone. */
  putRefState(repoAddr: string, ref: string, commitId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ref_state (repo_addr, ref, commit_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT(repo_addr, ref) DO UPDATE
             SET commit_id = excluded.commit_id, updated_at = excluded.updated_at, deleted_at = NULL`,
        )
        .run(repoAddr, ref, commitId, nowSeconds())
      this.db.prepare(`UPDATE run_jobs SET pending_evaluation = 0 WHERE run_id IN (SELECT run_id FROM runs WHERE repo_addr = ? AND ref = ?)`)
        .run(repoAddr, ref)
    })()
  }

  /** Writes every ref of a first-seen repo in one transaction, without dispatching. */
  seedRefStates(repoAddr: string, refs: Array<{ref: string; commitId: string}>): void {
    const tx = this.db.transaction((addr: string, entries: Array<{ref: string; commitId: string}>) => {
      for (const entry of entries) this.putRefState(addr, entry.ref, entry.commitId)
      this.markSeeded(addr)
    })
    tx(repoAddr, refs)
  }

  /** Tombstones a ref: the last commit is kept so a reappearance at it is not a push. */
  tombstoneRefState(repoAddr: string, ref: string): void {
    this.db
      .prepare('UPDATE ref_state SET deleted_at = ? WHERE repo_addr = ? AND ref = ? AND deleted_at IS NULL')
      .run(nowSeconds(), repoAddr, ref)
  }

  // ── schedules ───────────────────────────────────────────────────────────

  listSchedules(repoAddr?: string): ScheduleRow[] {
    const rows = repoAddr
      ? this.db
          .prepare('SELECT repo_addr, workflow_path, cron, last_fired_at FROM schedules WHERE repo_addr = ?')
          .all(repoAddr)
      : this.db.prepare('SELECT repo_addr, workflow_path, cron, last_fired_at FROM schedules').all()
    return rows.map((row: any) => ({
      repoAddr: row.repo_addr,
      workflowPath: row.workflow_path,
      cron: row.cron,
      lastFiredAt: row.last_fired_at,
    }))
  }

  /**
   * Replaces the schedule set for a repo in one transaction.
   *
   * A brand-new schedule seeds `last_fired_at = now` so adding a nightly job
   * does not immediately fire it; an existing one keeps its `last_fired_at`
   * (and therefore its missed-fire coalescing) as long as its cron is
   * unchanged. Editing the cron restarts the clock — the old cadence's last
   * fire says nothing about the new one.
   */
  replaceSchedules(repoAddr: string, entries: Array<{workflowPath: string; cron: string}>): void {
    const tx = this.db.transaction((addr: string, next: Array<{workflowPath: string; cron: string}>) => {
      const existing = new Map(
        this.listSchedules(addr).map(row => [row.workflowPath, row] as const),
      )
      const keep = new Set(next.map(entry => entry.workflowPath))

      for (const path of existing.keys()) {
        if (!keep.has(path)) {
          this.db.prepare('DELETE FROM schedules WHERE repo_addr = ? AND workflow_path = ?').run(addr, path)
        }
      }

      const now = nowSeconds()
      for (const entry of next) {
        const prior = existing.get(entry.workflowPath)
        const lastFiredAt = prior && prior.cron === entry.cron ? prior.lastFiredAt : now
        this.db
          .prepare(
            `INSERT INTO schedules (repo_addr, workflow_path, cron, last_fired_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(repo_addr, workflow_path) DO UPDATE SET cron = excluded.cron, last_fired_at = excluded.last_fired_at`,
          )
          .run(addr, entry.workflowPath, entry.cron, lastFiredAt)
      }
    })
    tx(repoAddr, entries)
  }

  markScheduleFired(repoAddr: string, workflowPath: string, firedAt: number): void {
    this.db
      .prepare('UPDATE schedules SET last_fired_at = ? WHERE repo_addr = ? AND workflow_path = ?')
      .run(firedAt, repoAddr, workflowPath)
  }

  // ── runs ────────────────────────────────────────────────────────────────

  recordRun(run: RunRow): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, repo_addr, ref, commit_id, workflow_path, runner_pubkey, trigger, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO NOTHING`,
      )
      .run(
        run.runId,
        run.repoAddr,
        run.ref,
        run.commitId,
        run.workflowPath,
        run.runnerPubkey,
        run.trigger,
        run.createdAt,
      )
  }

  /** Keep the audit tail plus publication latches for unfinished evaluations. */
  pruneRuns(keep = 5000): number {
    return this.db
      .prepare(
        `DELETE FROM runs WHERE run_id IN (
           SELECT run_id FROM runs ORDER BY created_at DESC LIMIT -1 OFFSET ?
          ) AND NOT EXISTS (SELECT 1 FROM run_jobs j WHERE j.run_id = runs.run_id AND j.pending_evaluation = 1)`,
      )
      .run(keep).changes
  }

  recentRuns(limit = 20): RunRow[] {
    return this.db
      .prepare(
        `SELECT run_id, repo_addr, ref, commit_id, workflow_path, runner_pubkey, trigger, created_at
         FROM runs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit)
      .map((row: any) => ({
        runId: row.run_id,
        repoAddr: row.repo_addr,
        ref: row.ref,
        commitId: row.commit_id,
        workflowPath: row.workflow_path,
        runnerPubkey: row.runner_pubkey,
        trigger: row.trigger,
        createdAt: row.created_at,
      }))
  }

  // ── allowlist / runner pool ─────────────────────────────────────────────

  allowPubkey(pubkey: string): void {
    this.db
      .prepare('INSERT INTO allowlist (pubkey, added_at) VALUES (?, ?) ON CONFLICT(pubkey) DO NOTHING')
      .run(pubkey, nowSeconds())
  }

  revokePubkey(pubkey: string): boolean {
    return this.db.prepare('DELETE FROM allowlist WHERE pubkey = ?').run(pubkey).changes > 0
  }

  isAllowed(pubkey: string): boolean {
    return this.db.prepare('SELECT 1 FROM allowlist WHERE pubkey = ?').get(pubkey) !== undefined
  }

  listAllowed(): Array<{pubkey: string; addedAt: number}> {
    return this.db
      .prepare('SELECT pubkey, added_at FROM allowlist ORDER BY added_at ASC')
      .all()
      .map((row: any) => ({pubkey: row.pubkey, addedAt: row.added_at}))
  }

  addRunner(pubkey: string): void {
    this.db
      .prepare('INSERT INTO runner_pool (pubkey, added_at) VALUES (?, ?) ON CONFLICT(pubkey) DO NOTHING')
      .run(pubkey, nowSeconds())
  }

  removeRunner(pubkey: string): boolean {
    return this.db.prepare('DELETE FROM runner_pool WHERE pubkey = ?').run(pubkey).changes > 0
  }

  listRunnerPool(): Array<{pubkey: string; addedAt: number}> {
    return this.db
      .prepare('SELECT pubkey, added_at FROM runner_pool ORDER BY added_at ASC')
      .all()
      .map((row: any) => ({pubkey: row.pubkey, addedAt: row.added_at}))
  }

  // ── kv ──────────────────────────────────────────────────────────────────

  getKv(key: string): string | null {
    const row: any = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
    return row ? row.value : null
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  deleteKv(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
  }
}
