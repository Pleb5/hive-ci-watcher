import {describe, expect, it} from 'vitest'
import {getPublicKey} from 'nostr-tools'
import {loadConfig} from '../src/config.js'

const OWNER = 'a'.repeat(64)

describe('watcher key', () => {
  it('generates a fresh key per boot when none is configured', () => {
    const first = loadConfig({HIVE_CI_WATCHER_OWNER_PUBKEY: OWNER})
    const second = loadConfig({HIVE_CI_WATCHER_OWNER_PUBKEY: OWNER})
    expect(first.keySource).toBe('generated')
    expect(first.secretKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(first.secretKeyHex).not.toBe(second.secretKeyHex)
    // It is a usable secp256k1 key, not just 32 random bytes.
    expect(getPublicKey(Buffer.from(first.secretKeyHex, 'hex'))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses the configured key when one is given', () => {
    const config = loadConfig({HIVE_CI_WATCHER_OWNER_PUBKEY: OWNER, HIVE_CI_WATCHER_NSEC: '1'.repeat(64)})
    expect(config.keySource).toBe('env')
    expect(config.secretKeyHex).toBe('1'.repeat(64))
  })

  it('still requires the owner pubkey', () => {
    expect(() => loadConfig({})).toThrow(/OWNER_PUBKEY is required/)
  })
})

describe('key file persistence', () => {
  it('generates once, writes 0600, and reads the same key back on the next boot', async () => {
    const {mkdtempSync, statSync, readFileSync} = await import('node:fs')
    const {tmpdir} = await import('node:os')
    const {join} = await import('node:path')
    const keyFile = join(mkdtempSync(join(tmpdir(), 'hive-ci-key-')), 'nested', 'watcher.key')

    const first = loadConfig({HIVE_CI_WATCHER_OWNER_PUBKEY: OWNER, HIVE_CI_WATCHER_KEY_FILE: keyFile})
    expect(first.keySource).toBe('file')
    expect(first.keyFile).toBe(keyFile)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(keyFile, 'utf8')).toBe(`${first.secretKeyHex}\n`)

    const second = loadConfig({HIVE_CI_WATCHER_OWNER_PUBKEY: OWNER, HIVE_CI_WATCHER_KEY_FILE: keyFile})
    expect(second.secretKeyHex).toBe(first.secretKeyHex)
    expect(second.keySource).toBe('file')
  })

  it('lets an explicit nsec win over the key file', async () => {
    const {mkdtempSync} = await import('node:fs')
    const {tmpdir} = await import('node:os')
    const {join} = await import('node:path')
    const keyFile = join(mkdtempSync(join(tmpdir(), 'hive-ci-key-')), 'watcher.key')
    const config = loadConfig({
      HIVE_CI_WATCHER_OWNER_PUBKEY: OWNER,
      HIVE_CI_WATCHER_KEY_FILE: keyFile,
      HIVE_CI_WATCHER_NSEC: '2'.repeat(64),
    })
    expect(config.keySource).toBe('env')
    expect(config.secretKeyHex).toBe('2'.repeat(64))
  })
})
