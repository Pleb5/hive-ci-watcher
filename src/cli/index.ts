#!/usr/bin/env node
import {EncryptionMode, GiftWrapMode} from '@contextvm/sdk/core'
import {ApplesauceRelayPool} from '@contextvm/sdk/relay'
import {PrivateKeySigner} from '@contextvm/sdk/signer'
import {NostrClientTransport} from '@contextvm/sdk/transport'
import {Client} from '@contextvm/mcp-sdk/client/index.js'
import {DEFAULT_RELAYS, normalizePubkey, normalizeRelays, normalizeSecretKey} from '../config.js'
import {errorMessage} from '../log.js'

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
    usage: 'unfollow <30617:owner:identifier>',
    args: ([repoAddr]) => ({repo_addr: required(repoAddr, 'repo address')}),
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
    '  HIVE_CI_WATCHER_CLI_NSEC     required — the caller identity (owner or an allowlisted requester)',
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

  const nsec = process.env.HIVE_CI_WATCHER_CLI_NSEC
  if (!nsec) throw new Error('HIVE_CI_WATCHER_CLI_NSEC is required')
  const serverPubkey = process.env.HIVE_CI_WATCHER_PUBKEY
  if (!serverPubkey) throw new Error('HIVE_CI_WATCHER_PUBKEY is required')

  const relays = normalizeRelays(
    (process.env.HIVE_CI_WATCHER_RELAYS || DEFAULT_RELAYS.join(',')).split(','),
  )

  const relayPool = new ApplesauceRelayPool(relays)
  const transport = new NostrClientTransport({
    signer: new PrivateKeySigner(normalizeSecretKey(nsec)),
    relayHandler: relayPool,
    serverPubkey: normalizePubkey(serverPubkey, 'HIVE_CI_WATCHER_PUBKEY'),
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
  }
}

main().catch(err => {
  process.stderr.write(`${errorMessage(err)}\n`)
  process.exit(1)
})
