import {finalizeEvent, getPublicKey, nip44, type EventTemplate, type NostrEvent} from 'nostr-tools'

/**
 * The watcher's own key. Signs 5401 / 5100 / Blossom 24242 auth and, through
 * `@contextvm/sdk`, every CVM response.
 */
export class WatcherIdentity {
  readonly pubkey: string
  private readonly secretKey: Uint8Array

  constructor(secretKeyHex: string) {
    this.secretKey = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'))
    if (this.secretKey.length !== 32) throw new Error('watcher secret key must be 32 bytes')
    this.pubkey = getPublicKey(this.secretKey)
  }

  get secretKeyHex(): string {
    return Buffer.from(this.secretKey).toString('hex')
  }

  sign(template: EventTemplate): NostrEvent {
    return finalizeEvent(template, this.secretKey)
  }

  /** NIP-44 v2 encryption to a recipient — used for the 5100 `secret` tag. */
  nip44Encrypt(recipientPubkey: string, plaintext: string): string {
    const conversationKey = nip44.getConversationKey(this.secretKey, recipientPubkey)
    return nip44.encrypt(plaintext, conversationKey)
  }

  nip44Decrypt(senderPubkey: string, ciphertext: string): string {
    const conversationKey = nip44.getConversationKey(this.secretKey, senderPubkey)
    return nip44.decrypt(ciphertext, conversationKey)
  }
}
