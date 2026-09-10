import type {NostrEvent} from 'nostr-tools'

export const KIND_REPO_ANNOUNCEMENT = 30617
export const KIND_REPO_STATE = 30618
export const KIND_TRUSTED_WATCHERS = 30620
export const KIND_LOOM_WORKER = 10100
export const KIND_LOOM_JOB = 5100
export const KIND_WORKFLOW_RUN = 5401

/** A 10100 ad older than this is no longer treated as online. */
export const WORKER_ONLINE_WINDOW_MS = 5 * 60 * 1000

export function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find(tag => tag[0] === name)?.[1]
}

export function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter(tag => tag[0] === name).flatMap(tag => tag.slice(1)).filter(Boolean)
}

export function repoAddress(owner: string, dTag: string): string {
  return `${KIND_REPO_ANNOUNCEMENT}:${owner}:${dTag}`
}

export interface ParsedRepoAddress {
  kind: number
  owner: string
  dTag: string
}

/**
 * Parses `<kind>:<pubkey>:<d>`. Callers hand us addresses typed by humans over
 * CVM, so a `d` tag containing `:` must survive — only the first two
 * separators are structural.
 */
export function parseRepoAddress(address: string): ParsedRepoAddress | null {
  const first = address.indexOf(':')
  if (first < 0) return null
  const second = address.indexOf(':', first + 1)
  if (second < 0) return null

  const kind = Number.parseInt(address.slice(0, first), 10)
  const owner = address.slice(first + 1, second)
  const dTag = address.slice(second + 1)

  if (!Number.isFinite(kind) || !/^[0-9a-f]{64}$/i.test(owner) || dTag.length === 0) return null
  return {kind, owner: owner.toLowerCase(), dTag}
}

export interface RepoAnnouncement {
  repoAddr: string
  owner: string
  dTag: string
  name: string
  cloneUrls: string[]
  relays: string[]
  /** Owner plus every pubkey in the owner's `maintainers` tag, deduplicated. */
  maintainers: string[]
  createdAt: number
  event: NostrEvent
}

export function parseRepoAnnouncement(event: NostrEvent): RepoAnnouncement | null {
  if (event.kind !== KIND_REPO_ANNOUNCEMENT) return null
  const dTag = tagValue(event, 'd')
  if (!dTag) return null

  const maintainers = new Set<string>([event.pubkey])
  for (const pubkey of tagValues(event, 'maintainers')) {
    if (/^[0-9a-f]{64}$/i.test(pubkey)) maintainers.add(pubkey.toLowerCase())
  }

  return {
    repoAddr: repoAddress(event.pubkey, dTag),
    owner: event.pubkey,
    dTag,
    name: tagValue(event, 'name') || dTag,
    cloneUrls: tagValues(event, 'clone'),
    relays: tagValues(event, 'relays'),
    maintainers: [...maintainers],
    createdAt: event.created_at,
    event,
  }
}

export interface RepoStateRef {
  /** Full ref name: `refs/heads/main`, `refs/tags/v1.2.0`. */
  ref: string
  /**
   * The commit to build. For an annotated tag carrying a peeled commit as a
   * third tag value, that peeled commit — not the tag object id.
   */
  commitId: string
  /** The raw first value, i.e. the tag object id for an annotated tag. */
  refValue: string
}

export interface RepoState {
  repoAddr: string
  dTag: string
  author: string
  createdAt: number
  refs: RepoStateRef[]
  /** Short branch name from the `HEAD` tag's `ref: refs/heads/<name>` value. */
  defaultBranch: string | null
  event: NostrEvent
}

const COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i

/**
 * Parses a kind 30618 repo state.
 *
 * `owner` is the address owner, which may differ from `event.pubkey`: any
 * maintainer of the repo may publish state, and the address always keys off
 * the owner's announcement.
 */
export function parseRepoState(event: NostrEvent, owner: string): RepoState | null {
  if (event.kind !== KIND_REPO_STATE) return null
  const dTag = tagValue(event, 'd')
  if (!dTag) return null

  const refs: RepoStateRef[] = []
  let defaultBranch: string | null = null

  for (const tag of event.tags) {
    const name = tag[0]
    if (!name) continue

    if (name === 'HEAD') {
      const target = tag[1] || ''
      const match = target.match(/^ref:\s*refs\/heads\/(.+)$/)
      if (match?.[1]) defaultBranch = match[1]
      continue
    }

    if (!name.startsWith('refs/heads/') && !name.startsWith('refs/tags/')) continue

    const refValue = tag[1]
    if (!refValue || !COMMIT_RE.test(refValue)) continue

    // An annotated tag may carry the peeled commit as a third value; when
    // present that is the commit to build, not the tag object itself.
    const peeled = tag[2]
    const commitId = peeled && COMMIT_RE.test(peeled) ? peeled.toLowerCase() : refValue.toLowerCase()

    refs.push({ref: name, commitId, refValue: refValue.toLowerCase()})
  }

  return {
    repoAddr: repoAddress(owner, dTag),
    dTag,
    author: event.pubkey,
    createdAt: event.created_at,
    refs,
    defaultBranch,
    event,
  }
}

export interface LoomWorker {
  pubkey: string
  name: string
  description: string
  architecture?: string
  actVersion?: string
  /** `undefined` means the ad declares no pricing — the only free representation. */
  pricing?: {perSecondRate: number; unit?: string}
  mints: string[]
  maxConcurrentJobs?: number
  currentQueueDepth?: number
  lastSeen: number
}

/**
 * Parses a kind 10100 loom worker advertisement.
 *
 * Mirrors `budabit-pipelines-extension`'s `parseLoomWorker`, so the watcher's
 * reading of an ad matches the UI's field for field.
 */
export function parseLoomWorker(event: NostrEvent): LoomWorker | null {
  if (event.kind !== KIND_LOOM_WORKER) return null

  let content: any
  try {
    content = JSON.parse(event.content || '{}')
  } catch {
    return null
  }
  if (!content?.name) return null

  const priceTags = event.tags.filter(tag => tag[0] === 'price')
  const actSoftware = event.tags.find(tag => tag[0] === 'S' && tag[1] === 'act')

  return {
    pubkey: event.pubkey,
    name: String(content.name),
    description: typeof content.description === 'string' ? content.description : '',
    architecture: tagValue(event, 'A'),
    actVersion: actSoftware?.[2],
    pricing:
      priceTags.length > 0
        ? {perSecondRate: Number.parseFloat(priceTags[0]?.[2] || ''), unit: priceTags[0]?.[3]}
        : undefined,
    mints: priceTags
      .map(tag => tag[4])
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
    maxConcurrentJobs: Number.parseInt(String(content.max_concurrent_jobs ?? ''), 10) || undefined,
    currentQueueDepth: Number.parseInt(String(content.current_queue_depth ?? ''), 10) || undefined,
    lastSeen: event.created_at,
  }
}

/**
 * Whether an ad declares no pricing at all.
 *
 * Reporting only — runner selection does not gate on this. A worker that runs
 * unpaid jobs for its `ALLOW_UNPAID_PUBKEYS` freelist still advertises its
 * public rate, because a kind 10100 is one replaceable event serving every
 * reader. Only the explicit no-pricing representation counts as free, so a
 * malformed paid ad (NaN / zero / negative rate) still reads as priced.
 */
export function isFreeWorker(worker: LoomWorker | null | undefined): boolean {
  return !!worker && worker.pricing == null
}

export function isWorkerOnline(worker: LoomWorker, now = Date.now()): boolean {
  return now - worker.lastSeen * 1000 < WORKER_ONLINE_WINDOW_MS
}
