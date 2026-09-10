import {describe, expect, it} from 'vitest'
import {assertPubkey, Authorizer, NOT_AUTHORIZED} from '../src/cvm/auth.js'
import {WatcherDb} from '../src/db/index.js'

const OWNER = 'a'.repeat(64)
const ALLOWED = 'b'.repeat(64)
const UNKNOWN = 'c'.repeat(64)

/** Mirrors the audience each tool is registered with in `src/cvm/server.ts`. */
const TOOL_AUDIENCES = {
  follow_repo: 'allowlisted',
  unfollow_repo: 'allowlisted',
  list_followed: 'allowlisted',
  status: 'allowlisted',
  list_runners: 'allowlisted',
  runners_add: 'owner',
  runners_remove: 'owner',
  allow_pubkey: 'owner',
  revoke_pubkey: 'owner',
  list_allowed: 'owner',
} as const

function setup() {
  const db = new WatcherDb(':memory:')
  db.allowPubkey(ALLOWED)
  return {db, authorizer: new Authorizer(db, OWNER)}
}

describe('tool authorization matrix', () => {
  it('lets the owner through every tool without an allowlist entry', () => {
    const {db, authorizer} = setup()
    expect(db.isAllowed(OWNER)).toBe(false)
    for (const audience of Object.values(TOOL_AUDIENCES)) {
      expect(authorizer.authorize(OWNER, audience)).toBe(true)
    }
    db.close()
  })

  it('lets an allowlisted requester through allowlisted tools only', () => {
    const {db, authorizer} = setup()
    for (const [tool, audience] of Object.entries(TOOL_AUDIENCES)) {
      expect([tool, authorizer.authorize(ALLOWED, audience)]).toEqual([
        tool,
        audience === 'allowlisted',
      ])
    }
    db.close()
  })

  it('refuses an unknown caller everywhere', () => {
    const {db, authorizer} = setup()
    for (const audience of Object.values(TOOL_AUDIENCES)) {
      expect(authorizer.authorize(UNKNOWN, audience)).toBe(false)
      expect(authorizer.authorize(undefined, audience)).toBe(false)
    }
    db.close()
  })

  it('stops honouring a revoked pubkey immediately', () => {
    const {db, authorizer} = setup()
    expect(authorizer.authorize(ALLOWED, 'allowlisted')).toBe(true)
    db.revokePubkey(ALLOWED)
    expect(authorizer.authorize(ALLOWED, 'allowlisted')).toBe(false)
    db.close()
  })

  it('is case-insensitive about pubkey hex', () => {
    const {db, authorizer} = setup()
    expect(authorizer.authorize(OWNER.toUpperCase(), 'owner')).toBe(true)
    expect(authorizer.authorize(ALLOWED.toUpperCase(), 'allowlisted')).toBe(true)
    db.close()
  })

  it('gives the same flat refusal regardless of why', () => {
    // The daemon must not disclose whether a pubkey exists in the allowlist,
    // so "allowlisted caller hitting an owner tool" and "unknown caller" are
    // indistinguishable from outside.
    expect(NOT_AUTHORIZED).toBe('not authorized')
  })
})

describe('caller identity source', () => {
  /** Mirrors `callerPubkey` in `src/cvm/server.ts`. */
  const callerPubkey = (extra: {_meta?: Record<string, unknown>}) => {
    const value = extra._meta?.clientPubkey
    return typeof value === 'string' ? value.toLowerCase() : undefined
  }

  it('reads the caller from the injected inner-event pubkey', () => {
    // The transport's `injectClientPubkey` writes the *decrypted inner*
    // event's pubkey here; the gift wrap's ephemeral pubkey never reaches us.
    expect(callerPubkey({_meta: {clientPubkey: OWNER.toUpperCase()}})).toBe(OWNER)
  })

  it('yields no caller — and therefore no authorization — when the meta is absent', () => {
    const {db, authorizer} = setup()
    expect(callerPubkey({})).toBeUndefined()
    expect(authorizer.authorize(callerPubkey({}), 'allowlisted')).toBe(false)
    db.close()
  })
})

describe('argument validation', () => {
  it('rejects anything that is not bare 64-char hex', () => {
    expect(assertPubkey(OWNER.toUpperCase(), 'pubkey')).toBe(OWNER)
    expect(() => assertPubkey('npub1abc', 'pubkey')).toThrow(/64 hex/)
    expect(() => assertPubkey('a'.repeat(63), 'pubkey')).toThrow(/64 hex/)
    expect(() => assertPubkey(42, 'pubkey')).toThrow(/must be a string/)
  })
})
