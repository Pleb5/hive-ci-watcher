import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'
import {generateSecretKey, nip19} from 'nostr-tools'
import {normalizeRelays} from './nostr/relays.js'

export {normalizeRelays}

export const DEFAULT_RELAYS = [
  'wss://relay.budabit.club',
  'wss://nos.lol',
  'wss://relay.damus.io',
]

/**
 * ContextVM's own relays. The CVM server listens here as well as on the
 * defaults, announces here, and retracts here; the CLI reaches the daemon
 * here. Not used for repo watching or run publishing.
 */
export const CVM_RELAYS = ['wss://relay.contextvm.org', 'wss://relay2.contextvm.org']

export const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.budabit.club',
  'https://blossom.primal.net',
  'https://cdn.sovbit.host',
]

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
  /** Where the ContextVM server listens and announces: `relays` ∪ `CVM_RELAYS`. */
  cvmRelays: string[]
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

function splitList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return [...fallback]
  const items = raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  return items.length > 0 ? items : [...fallback]
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  const owner = env.HIVE_CI_WATCHER_OWNER_PUBKEY
  if (!owner) throw new Error('HIVE_CI_WATCHER_OWNER_PUBKEY is required')

  const key = resolveSecretKey(env)

  return {
    secretKeyHex: key.secretKeyHex,
    keySource: key.keySource,
    ...(key.keyFile ? {keyFile: key.keyFile} : {}),
    ownerPubkey: normalizePubkey(owner, 'HIVE_CI_WATCHER_OWNER_PUBKEY'),
    databasePath: env.HIVE_CI_WATCHER_DB?.trim() || './watcher.db',
    relays: normalizeRelays(splitList(env.HIVE_CI_WATCHER_RELAYS, DEFAULT_RELAYS)),
    cvmRelays: normalizeRelays([...splitList(env.HIVE_CI_WATCHER_RELAYS, DEFAULT_RELAYS), ...CVM_RELAYS]),
    blossomServers: splitList(env.HIVE_CI_WATCHER_BLOSSOM_SERVERS, DEFAULT_BLOSSOM_SERVERS).map(
      server => server.replace(/\/+$/, ''),
    ),
  }
}
