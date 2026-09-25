import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'
import {generateSecretKey, nip19} from 'nostr-tools'
import {normalizeRelays} from './nostr/relays.js'
import {loadCommunityConfig, type CommunityConfig} from './community/config.js'
import {endpointList, IDENTITY_DISCOVERY_RELAYS, GIT_DISCOVERY_RELAYS, SERVICE_DISCOVERY_RELAYS, type InfrastructureOverrides} from './infrastructure.js'

export {normalizeRelays}

export const DEFAULT_RELAYS: string[] = []

/** ContextVM discovery seeds, independent of operational inboxes/outboxes. */
export const CVM_RELAYS = SERVICE_DISCOVERY_RELAYS

export const DEFAULT_BLOSSOM_SERVERS: string[] = []

export interface WatcherConfig {
  /** Watcher secret key, 64 hex chars. */
  secretKeyHex: string
  /**
   * Where the key came from. `generated` is the default: a fresh key every
   * boot, so a watcher identity lives exactly as long as the process that
   * announced it. `file` means `HIVE_CI_WATCHER_KEY_FILE` — generated once,
   * written there, read back on every later boot. `env` is an explicit
   * `HIVE_CI_WATCHER_NSEC`.
   */
  keySource: 'env' | 'file' | 'generated'
  /** Set when `keySource` is `file`. */
  keyFile?: string
  /** Watcher owner pubkey, 64 hex chars. Implicitly authorized for every CVM tool. */
  ownerPubkey: string
  databasePath: string
  relays: string[]
  /** Legacy initial inbox projection; live transports use ServiceInfrastructure. */
  cvmRelays: string[]
  /** Ordered; the first server that answers wins. */
  blossomServers: string[]
  /**
   * How long to keep polling a remote that has not yet caught up with an
   * announced commit, in ms. State events routinely precede object uploads.
   */
  fetchRetryWindowMs: number
  communityAccess: CommunityConfig
  infrastructure: InfrastructureOverrides
  identityDiscoveryRelays: string[]
  gitDiscoveryRelays: string[]
  serviceDiscoveryRelays: string[]
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

function freshSecretKeyHex(): string {
  return Buffer.from(generateSecretKey()).toString('hex')
}

/**
 * Key precedence: an explicit `HIVE_CI_WATCHER_NSEC`; else the key file, read
 * if present and otherwise generated and written (mode 0600, one line of hex);
 * else a fresh key for this boot only.
 */
export function resolveSecretKey(env: NodeJS.ProcessEnv): Pick<WatcherConfig, 'secretKeyHex' | 'keySource' | 'keyFile'> {
  const nsec = env.HIVE_CI_WATCHER_NSEC?.trim()
  if (nsec) return {secretKeyHex: normalizeSecretKey(nsec), keySource: 'env'}

  const keyFile = env.HIVE_CI_WATCHER_KEY_FILE?.trim()
  if (keyFile) {
    if (existsSync(keyFile)) {
      const raw = readFileSync(keyFile, 'utf8').trim()
      if (!raw) throw new Error(`HIVE_CI_WATCHER_KEY_FILE ${keyFile} is empty`)
      return {secretKeyHex: normalizeSecretKey(raw), keySource: 'file', keyFile}
    }
    const secretKeyHex = freshSecretKeyHex()
    mkdirSync(dirname(keyFile), {recursive: true, mode: 0o700})
    writeFileSync(keyFile, `${secretKeyHex}\n`, {mode: 0o600, flag: 'wx'})
    return {secretKeyHex, keySource: 'file', keyFile}
  }

  return {secretKeyHex: freshSecretKeyHex(), keySource: 'generated'}
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  const owner = env.HIVE_CI_WATCHER_OWNER_PUBKEY
  if (!owner) throw new Error('HIVE_CI_WATCHER_OWNER_PUBKEY is required')

  const communityAccess = loadCommunityConfig(env.HIVE_CI_WATCHER_COMMUNITIES_FILE)
  const legacy = endpointList(env.HIVE_CI_WATCHER_RELAYS)
  const infrastructure = {
    inbox: endpointList(env.HIVE_CI_WATCHER_INBOX_RELAYS) ?? legacy,
    outbox: endpointList(env.HIVE_CI_WATCHER_OUTBOX_RELAYS) ?? legacy,
    blossom: endpointList(env.HIVE_CI_WATCHER_BLOSSOM_SERVERS, true),
  }
  for (const role of ['inbox', 'outbox'] as const) {
    if (infrastructure[role]?.length === 0 || (!communityAccess.communities.length && !infrastructure[role]?.length)) {
      throw new Error(`configure HIVE_CI_WATCHER_${role.toUpperCase()}_RELAYS (or RELAYS); alternatively configure an optional community source`)
    }
  }
  const key = resolveSecretKey(env)

  return {
    secretKeyHex: key.secretKeyHex,
    keySource: key.keySource,
    ...(key.keyFile ? {keyFile: key.keyFile} : {}),
    ownerPubkey: normalizePubkey(owner, 'HIVE_CI_WATCHER_OWNER_PUBKEY'),
    databasePath: env.HIVE_CI_WATCHER_DB?.trim() || './watcher.db',
    relays: normalizeRelays([...(infrastructure.inbox ?? []), ...(infrastructure.outbox ?? [])]),
    cvmRelays: infrastructure.inbox ?? [],
    blossomServers: infrastructure.blossom ?? [],
    infrastructure,
    identityDiscoveryRelays: endpointList(env.HIVE_CI_WATCHER_IDENTITY_DISCOVERY_RELAYS) ?? IDENTITY_DISCOVERY_RELAYS,
    gitDiscoveryRelays: endpointList(env.HIVE_CI_WATCHER_GIT_DISCOVERY_RELAYS) ?? GIT_DISCOVERY_RELAYS,
    serviceDiscoveryRelays: endpointList(env.HIVE_CI_WATCHER_SERVICE_DISCOVERY_RELAYS) ?? SERVICE_DISCOVERY_RELAYS,
    fetchRetryWindowMs: parseSeconds(env.HIVE_CI_WATCHER_FETCH_RETRY_WINDOW, 600) * 1000,
    communityAccess,
  }
}

function parseSeconds(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
