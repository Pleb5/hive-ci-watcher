import {nip19} from 'nostr-tools'

export const DEFAULT_RELAYS = [
  'wss://relay.budabit.club',
  'wss://nos.lol',
  'wss://relay.damus.io',
]

export const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.budabit.club',
  'https://blossom.primal.net',
  'https://cdn.sovbit.host',
]

export interface WatcherConfig {
  /** Watcher secret key, 64 hex chars. */
  secretKeyHex: string
  /** Watcher owner pubkey, 64 hex chars. Implicitly authorized for every CVM tool. */
  ownerPubkey: string
  databasePath: string
  relays: string[]
  /** Ordered; the first server that answers wins. */
  blossomServers: string[]
}

const HEX64 = /^[0-9a-f]{64}$/i

/**
 * Accepts a bech32 `nsec1…` or a bare 64-char hex key and normalises to hex.
 * v1 reads this from the environment in plaintext; NIP-49 is deferred.
 */
export function normalizeSecretKey(raw: string): string {
  const value = raw.trim()
  if (HEX64.test(value)) return value.toLowerCase()

  if (value.startsWith('nsec1')) {
    const decoded = nip19.decode(value)
    if (decoded.type !== 'nsec') throw new Error('HIVE_CI_WATCHER_NSEC decoded to a non-nsec entity')
    return Buffer.from(decoded.data as Uint8Array).toString('hex')
  }

  throw new Error('HIVE_CI_WATCHER_NSEC must be an nsec1… string or 64 hex characters')
}

/** Accepts `npub1…` or bare hex and normalises to hex. */
export function normalizePubkey(raw: string, label: string): string {
  const value = raw.trim()
  if (HEX64.test(value)) return value.toLowerCase()

  if (value.startsWith('npub1')) {
    const decoded = nip19.decode(value)
    if (decoded.type !== 'npub') throw new Error(`${label} decoded to a non-npub entity`)
    return decoded.data as string
  }

  throw new Error(`${label} must be an npub1… string or 64 hex characters`)
}

function splitList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return [...fallback]
  const items = raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  return items.length > 0 ? items : [...fallback]
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  const nsec = env.HIVE_CI_WATCHER_NSEC
  if (!nsec) throw new Error('HIVE_CI_WATCHER_NSEC is required')

  const owner = env.HIVE_CI_WATCHER_OWNER_PUBKEY
  if (!owner) throw new Error('HIVE_CI_WATCHER_OWNER_PUBKEY is required')

  return {
    secretKeyHex: normalizeSecretKey(nsec),
    ownerPubkey: normalizePubkey(owner, 'HIVE_CI_WATCHER_OWNER_PUBKEY'),
    databasePath: env.HIVE_CI_WATCHER_DB?.trim() || './watcher.db',
    relays: normalizeRelays(splitList(env.HIVE_CI_WATCHER_RELAYS, DEFAULT_RELAYS)),
    blossomServers: splitList(env.HIVE_CI_WATCHER_BLOSSOM_SERVERS, DEFAULT_BLOSSOM_SERVERS).map(
      server => server.replace(/\/+$/, ''),
    ),
  }
}

/**
 * Relay URLs arrive from three places (env, 30617 `relays` tags, defaults) and
 * the same relay is routinely spelled with and without a trailing slash. The
 * subscription set is keyed by this normalised form so those do not open two
 * sockets to one relay.
 */
export function normalizeRelays(urls: Iterable<string>): string[] {
  const seen = new Set<string>()
  for (const raw of urls) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (!/^wss?:\/\//i.test(trimmed)) continue
    seen.add(trimmed.replace(/\/+$/, ''))
  }
  return [...seen].sort()
}
