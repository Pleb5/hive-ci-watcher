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
  /**
   * Skip the SHA fetch and go straight to the ref-name fallback. Exists so
   * the fallback can be exercised against a local fixture: `file://` remotes
   * accept any SHA under protocol v2 regardless of `uploadpack.allow*`, so
   * there is no configuration that makes a fixture refuse it.
   */
  forceRefFallback?: boolean
}

/** A workflow file larger than this is skipped; YAML alias expansion is unbounded otherwise. */
export const MAX_WORKFLOW_FILE_BYTES = 512 * 1024

/** Only this many `git fetch` processes run at once across every repo. */
export const MAX_CONCURRENT_FETCHES = 4

/**
 * Workflow filenames become `HIVE_CI_WORKFLOW`, which the runner script
 * passes to `act -W` and word-splits into a `nak` tag. Only plain names.
 */
const WORKFLOW_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml$/

/** Environment variables that must never reach a git subprocess. */
const SECRET_ENV_KEYS = ['HIVE_CI_WATCHER_NSEC', 'HIVE_CI_WATCHER_CLI_NSEC'] as const

/**
 * Builds the environment for a `git` child.
 *
 * The remote is chosen by whichever repo owner a requester followed, and git
 * spawns further helpers (`git-remote-https`, credential helpers) that inherit
 * whatever we hand it. The watcher's secret key is in `process.env` because
 * that is where the daemon read it from; nothing git does needs it, and a
 * client-side bug reached through a hostile server should yield at most a
 * shell, never the identity.
 */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...base}
  for (const key of SECRET_ENV_KEYS) delete env[key]

  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = 'echo'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_LFS_SKIP_SMUDGE = '1'
  // The clone URL is attacker-chosen (any repo owner's 30617). Pin the
  // transports git may use regardless of what the URL claims, so a helper
  // like `ext::` can never be reached through redirection or an unexpected
  // scheme. `file` is included only for the test fixtures.
  env.GIT_ALLOW_PROTOCOL = base.HIVE_CI_WATCHER_GIT_ALLOW_PROTOCOL ?? 'https:http:git:file'
  return env
}

async function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const {stdout} = await exec('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: gitEnvironment(),
  })
  return stdout
}

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
      return () => this.release()
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
    this.active += 1
    return () => this.release()
  }

  private release(): void {
    this.active -= 1
    const next = this.waiters.shift()
    if (next) next()
  }
}

const fetchSlots = new Semaphore(MAX_CONCURRENT_FETCHES)

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
      if (!WORKFLOW_FILENAME_RE.test(entry)) {
        if (/\.ya?ml$/i.test(entry)) log.warn('skipping workflow with unsafe filename', {root, entry})
        continue
      }
      const path = posix.join(root, entry)
      // `.github` is listed first, so an existing entry always outranks a
      // same-named `.ngit` workflow.
      if (tree.has(path)) continue
      try {
        const info = await stat(join(absolute, entry))
        if (!info.isFile()) continue
        if (info.size > MAX_WORKFLOW_FILE_BYTES) {
          log.warn('skipping oversized workflow file', {path, bytes: info.size})
          continue
        }
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
  const release = await fetchSlots.acquire()
  try {
    return await fetchWorkflowTreeUnbounded(options)
  } finally {
    release()
  }
}

async function fetchWorkflowTreeUnbounded(options: FetchOptions): Promise<WorkflowTree | null> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const commit = options.commitId.toLowerCase()

  // `--depth 1` bounds history, not size: it still pulls every blob in the
  // commit's tree, and sparse checkout only decides what gets written to
  // disk afterwards. `--filter=blob:none` makes the fetch treeish-only, so
  // the checkout then fetches just the workflow blobs on demand. Servers
  // without partial-clone support ignore the filter with a warning, which
  // degrades to the old behaviour rather than failing.
  const fetchArgs = ['fetch', '--depth', '1', '--filter=blob:none', '--quiet', 'origin']

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
        if (options.forceRefFallback) throw new Error('sha fetch skipped by forceRefFallback')
        await git(dir, [...fetchArgs, commit], timeoutMs)
        fetched = true
      } catch (err) {
        log.debug('sha-in-want fetch refused, falling back to ref name', {
          cloneUrl,
          error: errorMessage(err),
        })
      }

      if (!fetched && options.refName) {
        await git(dir, [...fetchArgs, options.refName], timeoutMs)
        fetched = true
      }

      if (!fetched) {
        log.warn('remote refused both sha and ref fetch', {cloneUrl, commit})
        continue
      }

      // Peel: a ref-name fetch of an annotated tag leaves FETCH_HEAD on the
      // tag *object*, while the 30618 announced the peeled commit. Compare
      // commits with commits.
      const tip = (await git(dir, ['rev-parse', 'FETCH_HEAD^{commit}'], timeoutMs)).trim().toLowerCase()

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
 * one 30618 must not launch two `git fetch` processes. Misses and failures
 * are never cached.
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

    const pending = load().then(
      tree => {
        // A miss (every remote exhausted) is transient — a remote that is
        // down now may be up on the next push. Caching it would blank the
        // default branch's trigger source for the life of the process.
        if (tree === null) this.entries.delete(key)
        return tree
      },
      err => {
        this.entries.delete(key)
        throw err
      },
    )
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
