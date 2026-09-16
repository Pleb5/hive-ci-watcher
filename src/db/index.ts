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

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export class WatcherDb {
  private readonly db: Database.Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true})
    this.db = new Database(path)
    this.db.exec(SCHEMA_SQL)
  }

  close(): void {
    this.db.close()
  }

  // ── followed repos ──────────────────────────────────────────────────────

  followRepo(repo: {repoAddr: string; repoOwner: string; dTag: string; addedBy: string}): void {
    this.db
      .prepare(
        `INSERT INTO followed_repos (repo_addr, repo_owner, d_tag, default_branch, added_by, added_at, seeded_at)
         VALUES (?, ?, ?, NULL, ?, ?, NULL)
         ON CONFLICT(repo_addr) DO NOTHING`,
      )
      .run(repo.repoAddr, repo.repoOwner, repo.dTag, repo.addedBy, nowSeconds())
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
        `SELECT repo_addr, repo_owner, d_tag, default_branch, added_by, added_at, seeded_at
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
      }))
  }

  getFollowedRepo(repoAddr: string): FollowedRepo | null {
    const row: any = this.db
      .prepare(
        `SELECT repo_addr, repo_owner, d_tag, default_branch, added_by, added_at, seeded_at
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
    this.db
      .prepare(
        `INSERT INTO ref_state (repo_addr, ref, commit_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(repo_addr, ref) DO UPDATE
           SET commit_id = excluded.commit_id, updated_at = excluded.updated_at, deleted_at = NULL`,
      )
      .run(repoAddr, ref, commitId, nowSeconds())
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

  /** Keeps the newest `keep` rows; the table is an audit tail, not a ledger. */
  pruneRuns(keep = 5000): number {
    return this.db
      .prepare(
        `DELETE FROM runs WHERE run_id IN (
           SELECT run_id FROM runs ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )`,
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
