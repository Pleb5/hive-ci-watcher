import {nip19, type EventTemplate} from 'nostr-tools'
import {KIND_LOOM_JOB, KIND_WORKFLOW_RUN} from '../nostr/events.js'

export type TriggerKind = 'push' | 'schedule'

export interface WorkflowRunEventArgs {
  repoAddr: string
  workflowPath: string
  /** The watcher's own pubkey — it is what triggered the run. */
  watcherPubkey: string
  /** The run's ephemeral pubkey; its secret key goes to the runner encrypted. */
  ephemeralPubkey: string
  trigger: TriggerKind
  /** Branch *or* tag short name. */
  branch: string
  /** Full ref name; this is what disambiguates a branch from a tag for readers. */
  ref: string
  commitId: string
  createdAt?: number
}

/**
 * Builds the kind 5401 workflow run anchor.
 *
 * Tag-for-tag identical to what `budabit-pipelines-extension` publishes, plus
 * the `ref` tag: `branch` carries the short name either way (that is what
 * `git clone --branch` wants), so `ref` is the only thing telling a reader
 * whether `v1.2.0` was a branch or a tag.
 */
export function buildWorkflowRunEvent(args: WorkflowRunEventArgs): EventTemplate {
  return {
    kind: KIND_WORKFLOW_RUN,
    created_at: args.createdAt ?? Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['a', args.repoAddr],
      ['workflow', args.workflowPath],
      ['triggered-by', args.watcherPubkey],
      ['publisher', args.ephemeralPubkey],
      ['trigger', args.trigger],
      ['branch', args.branch],
      ['ref', args.ref],
      ['commit', args.commitId],
      ['t', 'hive-ci'],
    ],
  }
}

export interface LoomJobEventArgs {
  runnerPubkey: string
  runId: string
  args: string[]
  env: Array<[string, string]>
  /** Already NIP-44-encrypted to the runner. */
  encryptedNsec: string
  command?: string
  createdAt?: number
}

/**
 * Builds the kind 5100 loom job.
 *
 * **No `payment` tag** — every watcher-triggered run goes out unpaid, on the
 * strength of the watcher pubkey sitting in the worker's
 * `ALLOW_UNPAID_PUBKEYS`. The tag is omitted entirely rather than sent empty:
 * a loom worker only treats a job as trusted-unpaid when the tag is absent, so
 * an empty one would be rejected.
 */
export function buildLoomJobEvent(args: LoomJobEventArgs): EventTemplate {
  return {
    kind: KIND_LOOM_JOB,
    created_at: args.createdAt ?? Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['p', args.runnerPubkey],
      ['e', args.runId],
      ['cmd', args.command ?? 'bash'],
      ['args', ...args.args],
      ...args.env.map(([key, value]) => ['env', key, value]),
      ['secret', 'HIVE_CI_NSEC', args.encryptedNsec],
    ],
  }
}

export interface RunEnvArgs {
  runId: string
  repoNostrUrl: string
  workflowPath: string
  /** Branch *or* tag short name — `git clone --branch` accepts either. */
  branch: string
  commitId: string
  relays: string[]
  blossomServer: string
}

export function buildRunEnv(args: RunEnvArgs): Array<[string, string]> {
  return [
    ['HIVE_CI_RUN_ID', args.runId],
    ['HIVE_CI_REPOSITORY', args.repoNostrUrl],
    ['HIVE_CI_WORKFLOW', args.workflowPath],
    ['HIVE_CI_BRANCH', args.branch],
    ['HIVE_CI_COMMIT', args.commitId],
    ['HIVE_CI_RELAYS', args.relays.join(',')],
    ['HIVE_CI_BLOSSOM_SERVER', args.blossomServer],
  ]
}

/**
 * `nostr://<npub>/<url-encoded relay>/…/<identifier>` — the form ngit clones.
 * Returns `''` for an unparseable address, matching the extension.
 */
export function toRepoNostrUrl(repoAddress: string | undefined, relays: string[]): string {
  if (!repoAddress) return ''

  try {
    const parts = repoAddress.split(':')
    if (parts.length < 3) return ''

    const pubkey = parts[1]
    const identifier = parts.slice(2).join(':')
    if (!pubkey || !identifier) return ''

    const npub = nip19.npubEncode(pubkey)
    const relayHints = relays.map(relay => encodeURIComponent(relay)).join('/')
    return relayHints ? `nostr://${npub}/${relayHints}/${identifier}` : `nostr://${npub}/${identifier}`
  } catch {
    return ''
  }
}
