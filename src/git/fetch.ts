import {execFile} from 'node:child_process'
import {mkdtemp, rm, readdir, readFile, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, posix} from 'node:path'
import {promisify} from 'node:util'
import {createLogger, errorMessage} from '../log.js'

const exec = promisify(execFile)
const log = createLogger('git')

/**
 * Both directories hold the same GitHub Actions YAML schema. The union is the
 * workflow set; `.github` wins a path collision (see `WORKFLOW_ROOTS` order).
 */
export const WORKFLOW_ROOTS = ['.github/workflows', '.ngit/workflows'] as const

export interface WorkflowFile {
  /** Repo-relative path, e.g. `.github/workflows/ci.yml`. */
  path: string
  content: string
}

/** Every workflow found at one commit, keyed by repo-relative path. */
export type WorkflowTree = Map<string, WorkflowFile>

export interface FetchOptions {
  cloneUrls: string[]
  commitId: string
  /** Used only for the SHA-in-want fallback fetch. */
  refName?: string
  timeoutMs?: number
}

async function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const {stdout} = await exec('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_LFS_SKIP_SMUDGE: '1',
    },
  })
  return stdout
}

async function readWorkflowsFromCheckout(dir: string): Promise<WorkflowTree> {
  const tree: WorkflowTree = new Map()

  for (const root of WORKFLOW_ROOTS) {
    const absolute = join(dir, root)
    let entries: string[]
    try {
      const info = await stat(absolute)
      if (!info.isDirectory()) continue
      entries = await readdir(absolute)
    } catch {
      continue
    }

    for (const entry of entries.sort()) {
      if (!/\.ya?ml$/i.test(entry)) continue
      const path = posix.join(root, entry)
      // `.github` is listed first, so an existing entry always outranks a
      // same-named `.ngit` workflow.
      if (tree.has(path)) continue
      try {
        const content = await readFile(join(absolute, entry), 'utf8')
        tree.set(path, {path, content})
      } catch (err) {
        log.warn('failed reading workflow file', {path, error: errorMessage(err)})
      }
    }
  }

  return tree
}

/**
 * Fetches `.github/workflows/` and `.ngit/workflows/` at one commit.
 *
 * Tries each `clone` tag in order with a depth-1 fetch, falling back to a
 * branch-name fetch when the remote refuses SHA-in-want. The fetched tip is
 * then verified to equal the expected commit: remotes drift out of sync with
 * the announced repo state, and a mismatch means try the next remote. That
 * check is what makes the branch-name fallback safe — a remote that has moved
 * past the announced commit is a miss, never a silent build of the wrong tree.
 *
 * Returns `null` when every remote is exhausted; the caller logs and skips the
 * evaluation rather than dispatching a run.
 */
export async function fetchWorkflowTree(options: FetchOptions): Promise<WorkflowTree | null> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const commit = options.commitId.toLowerCase()

  for (const cloneUrl of options.cloneUrls) {
    const dir = await mkdtemp(join(tmpdir(), 'hive-ci-watcher-'))
    try {
      await git(dir, ['init', '--quiet'], timeoutMs)
      await git(dir, ['remote', 'add', 'origin', cloneUrl], timeoutMs)
      await git(dir, ['config', 'core.sparseCheckout', 'true'], timeoutMs)
      await git(dir, ['sparse-checkout', 'init', '--no-cone'], timeoutMs)
      await git(dir, ['sparse-checkout', 'set', '--no-cone', ...WORKFLOW_ROOTS.map(root => `/${root}/`)], timeoutMs)

      let fetched = false
      try {
        await git(dir, ['fetch', '--depth', '1', '--quiet', 'origin', commit], timeoutMs)
        fetched = true
      } catch (err) {
        log.debug('sha-in-want fetch refused, falling back to ref name', {
          cloneUrl,
          error: errorMessage(err),
        })
      }

      if (!fetched && options.refName) {
        await git(dir, ['fetch', '--depth', '1', '--quiet', 'origin', options.refName], timeoutMs)
        fetched = true
      }

      if (!fetched) {
        log.warn('remote refused both sha and ref fetch', {cloneUrl, commit})
        continue
      }

      const tip = (await git(dir, ['rev-parse', 'FETCH_HEAD'], timeoutMs)).trim().toLowerCase()

      // Never relax this. Building the tree a remote happens to be serving,
      // rather than the tree the repo state announced, silently CIs the wrong
      // commit.
      if (tip !== commit) {
        log.warn('remote tip does not match announced commit', {cloneUrl, expected: commit, actual: tip})
        continue
      }

      await git(dir, ['checkout', '--quiet', 'FETCH_HEAD'], timeoutMs)
      return await readWorkflowsFromCheckout(dir)
    } catch (err) {
      log.warn('clone url failed', {cloneUrl, commit, error: errorMessage(err)})
    } finally {
      await rm(dir, {recursive: true, force: true}).catch(() => undefined)
    }
  }

  log.warn('all clone urls exhausted', {commit, remotes: options.cloneUrls.length})
  return null
}

/**
 * Caches trees by `(repo, commit)` so a push touching five refs does not
 * refetch the default branch five times — and a tag pointing at a commit
 * already fetched for a branch reuses that tree outright.
 *
 * In-flight fetches are cached too: the same commit reached from two refs in
 * one 30618 must not launch two `git fetch` processes.
 */
export class WorkflowTreeCache {
  private readonly entries = new Map<string, Promise<WorkflowTree | null>>()

  constructor(private readonly maxEntries = 128) {}

  async get(
    repoAddr: string,
    commitId: string,
    load: () => Promise<WorkflowTree | null>,
  ): Promise<WorkflowTree | null> {
    const key = `${repoAddr}@${commitId.toLowerCase()}`
    const existing = this.entries.get(key)
    if (existing) return existing

    const pending = load().catch(err => {
      // A failed fetch must not be cached as a permanent miss.
      this.entries.delete(key)
      throw err
    })
    this.entries.set(key, pending)

    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }

    return pending
  }

  invalidateRepo(repoAddr: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${repoAddr}@`)) this.entries.delete(key)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}
