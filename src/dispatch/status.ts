import type {NostrEvent} from 'nostr-tools'
import {verified} from '../community/transport.js'
import type {WatcherDb, RunJob} from '../db/index.js'
import {preferred} from '../community/protocol.js'

/** Native Loom status is evidence of execution, independent of Hive workflow reports. */
export function acceptJobEvidence(db: WatcherDb, event: NostrEvent): boolean {
  if (![30100, 5101].includes(event.kind) || !verified(event)) return false
  const references = event.tags.filter(t => t[0] === 'e')
  if (references.length !== 1) return false
  const job = db.jobs().find(job => job.jobId === references[0]![1] && job.runnerPubkey === event.pubkey)
  if (!job) return false
  if (event.kind === 30100 && event.tags.find(t => t[0] === 'd')?.[1] !== job.jobId) return false
  if (job.evidence?.kind === 5101 && event.kind !== 5101) return false
  if (job.evidence && job.evidence.kind === event.kind && !preferred(event, job.evidence)) return false
  const status = event.kind === 5101
    ? event.tags.find(t => t[0] === 'success')?.[1] === 'true' ? 'completed' : event.tags.find(t => t[0] === 'success')?.[1] === 'false' ? 'failed' : undefined
    : event.tags.find(t => t[0] === 'status')?.[1]
  if (!status || !['queued', 'running', 'completed', 'failed'].includes(status)) return false
  db.updateJob(job.jobId, status as RunJob['state'], event)
  return true
}
