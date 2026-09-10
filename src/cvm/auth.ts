import type {WatcherDb} from '../db/index.js'

export type ToolAudience = 'owner' | 'allowlisted'

/**
 * The flat refusal every unauthorized caller gets. Deliberately identical for
 * "not in the allowlist", "allowlisted but this tool is owner-only" and
 * "unknown pubkey" — the daemon does not disclose whether a pubkey exists in
 * the allowlist.
 */
export const NOT_AUTHORIZED = 'not authorized'

export class Authorizer {
  constructor(
    private readonly db: WatcherDb,
    private readonly ownerPubkey: string,
  ) {}

  isOwner(pubkey: string | undefined): boolean {
    return !!pubkey && pubkey.toLowerCase() === this.ownerPubkey.toLowerCase()
  }

  /**
   * The owner is implicitly authorized for every tool and needs no allowlist
   * entry.
   */
  authorize(pubkey: string | undefined, audience: ToolAudience): boolean {
    if (!pubkey) return false
    if (this.isOwner(pubkey)) return true
    if (audience === 'owner') return false
    return this.db.isAllowed(pubkey.toLowerCase())
  }
}

const HEX64 = /^[0-9a-f]{64}$/

/** Tool arguments arrive from the network; a pubkey must be bare lowercase hex. */
export function assertPubkey(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const normalized = value.trim().toLowerCase()
  if (!HEX64.test(normalized)) throw new Error(`${label} must be 64 hex characters`)
  return normalized
}
