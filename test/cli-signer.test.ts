import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, type EventTemplate} from 'nostr-tools'
import {NakAccountSigner, runNakAccount} from '../src/cli/nak-account-signer.js'
import {loadCliSigner} from '../src/cli/signer.js'

// Throwaway test identities, unrelated to local nak accounts.
const key = generateSecretKey()
const pubkey = getPublicKey(key)
const npub = nip19.npubEncode(pubkey)
const status = `five active pid=123 auth=ok profile=Five npub=${npub}\n  bunker_uri=unused\n`
const template: EventTemplate = {kind: 24133, created_at: 0, tags: [['p', pubkey]], content: 'private request'}

describe('CLI identity selection', () => {
  it('requires an explicit identity and rejects ambiguous selection', () => {
    expect(() => loadCliSigner({})).toThrow(/is required/)
    expect(() => loadCliSigner({HIVE_CI_WATCHER_CLI_ACCOUNT: 'five', HIVE_CI_WATCHER_CLI_NSEC: 'unused'})).toThrow(/only one/)
    expect(loadCliSigner({HIVE_CI_WATCHER_CLI_ACCOUNT: 'five'})).toBeInstanceOf(NakAccountSigner)
  })

  it('retains the direct-key option', async () => {
    const signer = loadCliSigner({HIVE_CI_WATCHER_CLI_NSEC: Buffer.from(key).toString('hex')})
    expect(await signer.getPublicKey()).toBe(pubkey)
  })

  it.each(['--help', '../five', 'five; echo wrong', 'five\nother'])('rejects an unsafe alias: %s', alias => {
    expect(() => new NakAccountSigner(alias)).toThrow(/invalid/)
  })
})

describe('nak-account signer', () => {
  it('pins the public identity and accepts a valid signature over exactly the supplied event', async () => {
    const run = vi.fn(async (args: string[], input?: string) => {
      if (args[0] === 'status') return status
      expect(args).toEqual(['run', '--as', 'five', '--', 'event', '--force-sign', '--created-at', '0'])
      return JSON.stringify(finalizeEvent(JSON.parse(input!), key))
    })
    const signer = new NakAccountSigner('five', run)
    const signed = await signer.signEvent(template)
    expect(signed).toMatchObject({...template, pubkey})
    expect(await signer.getPublicKey()).toBe(pubkey)
    expect(run.mock.calls.filter(([args]) => args[0] === 'status')).toHaveLength(1)
  })

  it.each([
    `five inactive profile=Five npub=${npub}\n`,
    `five active pid=123 auth=failed profile=Five npub=${npub}\n`,
    `other active pid=123 auth=ok profile=Five npub=${npub}\n`,
    'five active pid=123 auth=ok profile=Five npub=(unset)\n',
  ])('fails closed when status is unusable', async output => {
    const run = vi.fn(async () => output)
    const signer = new NakAccountSigner('five', run)
    await expect(signer.signEvent(template)).rejects.toThrow(/not ready|public key/)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('supports an authorized external signer', async () => {
    const signer = new NakAccountSigner('five', async () => `five authorized pid=external profile=Five npub=${npub}\n`)
    expect(await signer.getPublicKey()).toBe(pubkey)
  })

  it.each(['changed', 'wrong-key', 'bad-signature', 'malformed'])('rejects %s output without echoing private content', async mode => {
    const signer = new NakAccountSigner('five', async args => {
      if (args[0] === 'status') return status
      if (mode === 'malformed') return 'private request (malformed JSON)'
      const event = finalizeEvent(mode === 'changed' ? {...template, content: 'changed private request'} : template,
        mode === 'wrong-key' ? generateSecretKey() : key)
      return JSON.stringify(mode === 'bad-signature' ? {...event, sig: '0'.repeat(128)} : event)
    })
    await expect(signer.signEvent(template)).rejects.toThrow('nak-account returned an invalid signature, changed event, or unexpected identity')
  })

  it('uses NIP-44 with exact message bytes and handles option-like plaintext without a shell', async () => {
    const conversationKey = nip44.getConversationKey(key, pubkey)
    const plaintext = '--help $(echo do-not-execute)\n  private payload  \n\n'
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'status') return status
      expect(args.slice(0, 4)).toEqual(['run', '--as', 'five', '--'])
      expect(args.slice(5, 8)).toEqual(['-p', pubkey, '--'])
      const payload = args[8]!
      return (args[4] === 'encrypt' ? nip44.encrypt(payload, conversationKey) : nip44.decrypt(payload, conversationKey)) + '\n'
    })
    const signer = new NakAccountSigner('five', run)
    const ciphertext = await signer.nip44.encrypt(pubkey, plaintext)
    expect(await signer.nip44.decrypt(pubkey, ciphertext)).toBe(plaintext)
  })
})

describe('nak-account subprocess boundary', () => {
  let dir: string | undefined

  afterEach(() => {
    vi.unstubAllEnvs()
    if (dir) rmSync(dir, {recursive: true, force: true})
    dir = undefined
  })

  function fakeAccount(body: string): void {
    dir = mkdtempSync(join(tmpdir(), 'hive-cli-signer-'))
    writeFileSync(join(dir, 'nak-account'), `#!${process.execPath}\n${body}\n`, {mode: 0o700})
    vi.stubEnv('PATH', dir)
  }

  it('passes arguments literally and sends event data through stdin', async () => {
    fakeAccount(`let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({args: process.argv.slice(2), input}));
    });`)
    const args = ['run', '--as', 'five', '--', 'encrypt', '-p', pubkey, '--', '$(false); private payload']
    expect(JSON.parse(await runNakAccount(args, 'private event'))).toEqual({args, input: 'private event'})
  })

  it('does not expose child diagnostics or request arguments on failure', async () => {
    fakeAccount("process.stderr.write('private diagnostic'); process.stdout.write('private output'); process.exit(1);")
    await expect(runNakAccount(['private argument'])).rejects.toThrow(
      'nak-account operation failed; check nak-account status and start the account in a terminal',
    )
  })

  it('bounds a hung signer operation', async () => {
    fakeAccount('setInterval(() => {}, 1000);')
    await expect(runNakAccount(['status', 'five'], undefined, 100)).rejects.toThrow(/operation failed/)
  })

  it('bounds unexpected output', async () => {
    fakeAccount("process.stdout.write('x'.repeat(2 * 1024 * 1024));")
    await expect(runNakAccount(['status', 'five'])).rejects.toThrow(/operation failed/)
  })
})
