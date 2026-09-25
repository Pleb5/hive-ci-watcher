#!/usr/bin/env node
import '../env-defaults.js'
import {EncryptionMode, GiftWrapMode} from '@contextvm/sdk/core'
import {NostrClientTransport} from '@contextvm/sdk/transport'
import {Client} from '@contextvm/mcp-sdk/client/index.js'
import {normalizePubkey, normalizeRelays} from '../config.js'
import {endpointList, IDENTITY_DISCOVERY_RELAYS, SERVICE_DISCOVERY_RELAYS} from '../infrastructure.js'
import {NostrClient} from '../nostr/client.js'
import {DirectedRelayHandler} from '../cvm/relay-handler.js'
import {of} from 'rxjs'
import {errorMessage} from '../log.js'
import {loadCliSigner} from './signer.js'

/**
 * Every subcommand is exactly one ContextVM tool call — the CLI holds no state
 * and knows nothing the daemon does not expose as a tool.
 */
const COMMANDS: Record<string, {tool: string; usage: string; args: (rest: string[]) => any}> = {
  follow: {
    tool: 'follow_repo',
    usage: 'follow <30617:owner:identifier | naddr1…> [relay …]',
    args: ([repoAddr, ...relays]) => ({repo_addr: required(repoAddr, 'repo address'), relays}),
  },
  unfollow: {
    tool: 'unfollow_repo',
    usage: 'unfollow <30617:owner:identifier> [requester-pubkey | --all (operator only)]',
    args: ([repoAddr, target]) => ({repo_addr: required(repoAddr, 'repo address'),
      ...(target === '--all' ? {all: true} : target ? {requester_pubkey: target} : {}),
    }),
  },
  list: {tool: 'list_followed', usage: 'list', args: () => ({})},
  status: {tool: 'status', usage: 'status', args: () => ({})},
  runners: {tool: 'list_runners', usage: 'runners', args: () => ({})},
  'runners-add': {
    tool: 'runners_add',
    usage: 'runners-add <pubkey-hex>',
    args: ([pubkey]) => ({pubkey: required(pubkey, 'pubkey')}),
  },
  'runners-remove': {
    tool: 'runners_remove',
    usage: 'runners-remove <pubkey-hex>',
    args: ([pubkey]) => ({pubkey: required(pubkey, 'pubkey')}),
  },
  allow: {
    tool: 'allow_pubkey',
    usage: 'allow <pubkey-hex>',
    args: ([pubkey]) => ({pubkey: required(pubkey, 'pubkey')}),
  },
  revoke: {
    tool: 'revoke_pubkey',
    usage: 'revoke <pubkey-hex>',
    args: ([pubkey]) => ({pubkey: required(pubkey, 'pubkey')}),
  },
  allowed: {tool: 'list_allowed', usage: 'allowed', args: () => ({})},
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`)
  return value
}

function usage(): string {
  return [
    'hive-ci-watcher <command> [args]',
    '',
    'Commands:',
    ...Object.values(COMMANDS).map(command => `  ${command.usage}`),
    '',
    'Environment:',
    '  HIVE_CI_WATCHER_CLI_ACCOUNT  caller identity via an active local nak-account alias',
    '  HIVE_CI_WATCHER_CLI_NSEC     alternative caller identity (set exactly one signer option)',
    '  HIVE_CI_WATCHER_PUBKEY       required — the watcher daemon pubkey to talk to',
    '  HIVE_CI_WATCHER_RELAYS       optional — comma-separated relays',
  ].join('\n')
}

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2)
  if (!name || name === '--help' || name === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const command = COMMANDS[name]
  if (!command) throw new Error(`unknown command '${name}'\n\n${usage()}`)

  const signer = loadCliSigner()
  const serverPubkey = process.env.HIVE_CI_WATCHER_PUBKEY
  if (!serverPubkey) throw new Error('HIVE_CI_WATCHER_PUBKEY is required')
  await signer.getPublicKey()

  const target = normalizePubkey(serverPubkey, 'HIVE_CI_WATCHER_PUBKEY')
  const discovery = normalizeRelays([
    ...(endpointList(process.env.HIVE_CI_WATCHER_IDENTITY_DISCOVERY_RELAYS) ?? IDENTITY_DISCOVERY_RELAYS),
    ...(endpointList(process.env.HIVE_CI_WATCHER_SERVICE_DISCOVERY_RELAYS) ?? SERVICE_DISCOVERY_RELAYS),
  ])
  const explicit = endpointList(process.env.HIVE_CI_WATCHER_RELAYS)
  const nostr = new NostrClient(explicit ?? [], discovery, signer)
  let inbox: string[], outbox: string[]
  try {
    if (explicit !== undefined) inbox = outbox = explicit
    else {
      await nostr.requestAll(discovery, {kinds: [10002], authors: [target]}, 8000, 'watcher-mailboxes')
      const list = nostr.store.getReplaceable(10002, target)
      inbox = normalizeRelays(list?.tags.filter(t => t[0] === 'r' && (!t[2] || t[2] === 'read')).map(t => t[1]!) ?? [])
      outbox = normalizeRelays(list?.tags.filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write')).map(t => t[1]!) ?? [])
    }
    if (!inbox.length || !outbox.length) throw new Error('watcher inbox/outbox unresolved; supply an explicit HIVE_CI_WATCHER_RELAYS override or publish its signed NIP-65 list')
  } catch (error) { nostr.close(); throw error }
  const relayPool = new DirectedRelayHandler(nostr, of(outbox), () => inbox, () => normalizeRelays([...inbox, ...outbox]))
  const transport = new NostrClientTransport({
    signer,
    relayHandler: relayPool,
    discoveryRelayUrls: [],
    serverPubkey: target,
    encryptionMode: EncryptionMode.REQUIRED,
    giftWrapMode: GiftWrapMode.EPHEMERAL,
  })

  const client = new Client({name: 'hive-ci-watcher-cli', version: '0.1.0'})

  try {
    await client.connect(transport)
    const result: any = await client.callTool({
      name: command.tool,
      arguments: command.args(rest),
    })

    const text = (result?.content ?? [])
      .filter((entry: any) => entry?.type === 'text')
      .map((entry: any) => entry.text)
      .join('\n')

    process.stdout.write(`${text || JSON.stringify(result, null, 2)}\n`)
    if (result?.isError) process.exitCode = 1
  } finally {
    await client.close().catch(() => undefined)
    await relayPool.disconnect().catch(() => undefined)
    nostr.close()
  }
}

main().catch(err => {
  process.stderr.write(`${errorMessage(err)}\n`)
  process.exit(1)
})
