import {spawn} from 'node:child_process'
import type {NostrSigner} from '@contextvm/sdk/core'
import {getEventHash, verifyEvent, type EventTemplate, type NostrEvent} from 'nostr-tools'
import {normalizePubkey} from '../config.js'

type RunAccount = (args: string[], input?: string) => Promise<string>

/** No shell, key-file access, or child output in errors. Kill the wrapper and nak on timeout. */
export function runNakAccount(args: string[], input?: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('nak-account', args, {
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    const fail = () => {
      clearTimeout(timer)
      if (child.pid) {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch { /* already exited */ }
      }
      reject(new Error('nak-account operation failed; check nak-account status and start the account in a terminal'))
    }
    const timer = setTimeout(fail, timeoutMs)
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) fail()
      else chunks.push(chunk)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) fail()
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    child.stdin.end(input)
  })
}

/** Delegate operator signing and NIP-44 to an already-authorized nak-account alias. */
export class NakAccountSigner implements NostrSigner {
  private publicKey?: Promise<string>

  constructor(private readonly account: string, private readonly run: RunAccount = runNakAccount) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(account)) throw new Error('invalid nak-account alias')
  }

  getPublicKey(): Promise<string> {
    return this.publicKey ??= this.readPublicKey()
  }

  private async readPublicKey(): Promise<string> {
    const status = (await this.run(['status', this.account])).split('\n')[0] ?? ''
    const active = status.startsWith(`${this.account} active `) && /\bauth=ok(?:\s|$)/.test(status)
    const external = status.startsWith(`${this.account} authorized pid=external `)
    if (!active && !external) {
      throw new Error(`nak-account ${this.account} is not ready; run nak-account start ${this.account} in a terminal`)
    }
    const npub = /\bnpub=(npub1[023456789acdefghjklmnpqrstuvwxyz]+)$/.exec(status)?.[1]
    if (!npub) throw new Error('nak-account status did not return a public key')
    return normalizePubkey(npub, 'nak-account public key')
  }

  private operation(args: string[], input?: string): Promise<string> {
    return this.run(['run', '--as', this.account, '--', ...args], input)
  }

  async signEvent(event: EventTemplate): Promise<NostrEvent> {
    const pubkey = await this.getPublicKey()
    const unsigned = {pubkey, kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content}
    const expectedId = getEventHash(unsigned)
    // nak otherwise replaces a zero timestamp. No relay arguments: the SDK publishes.
    const output = await this.operation(['event', '--force-sign', '--created-at', String(event.created_at)], JSON.stringify(unsigned))
    try {
      const signed: NostrEvent = JSON.parse(output)
      if (signed.pubkey === pubkey && signed.id === expectedId && verifyEvent(signed)) return signed
    } catch { /* Never include potentially private event content in errors. */ }
    throw new Error('nak-account returned an invalid signature, changed event, or unexpected identity')
  }

  readonly nip44 = {
    encrypt: async (pubkey: string, plaintext: string): Promise<string> => {
      await this.getPublicKey()
      // nak 0.19.7 accepts NIP-44 inputs as arguments, not stdin. No operator key is passed.
      const output = await this.operation(['encrypt', '-p', normalizePubkey(pubkey, 'recipient'), '--', plaintext])
      const ciphertext = output.trim()
      if (!ciphertext) throw new Error('nak-account returned empty ciphertext')
      return ciphertext
    },
    decrypt: async (pubkey: string, ciphertext: string): Promise<string> => {
      await this.getPublicKey()
      const output = await this.operation(['decrypt', '-p', normalizePubkey(pubkey, 'sender'), '--', ciphertext])
      // Strip only nak's output newline, preserving whitespace in the decrypted message.
      return output.replace(/\n$/, '')
    },
  }
}
