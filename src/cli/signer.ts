import type {NostrSigner} from '@contextvm/sdk/core'
import {PrivateKeySigner} from '@contextvm/sdk/signer'
import {normalizeSecretKey} from '../config.js'
import {NakAccountSigner} from './nak-account-signer.js'

export function loadCliSigner(env: NodeJS.ProcessEnv = process.env): NostrSigner {
  const account = env.HIVE_CI_WATCHER_CLI_ACCOUNT?.trim()
  const nsec = env.HIVE_CI_WATCHER_CLI_NSEC?.trim()
  if (account && nsec) throw new Error('set only one of HIVE_CI_WATCHER_CLI_ACCOUNT or HIVE_CI_WATCHER_CLI_NSEC')
  if (account) return new NakAccountSigner(account)
  if (nsec) return new PrivateKeySigner(normalizeSecretKey(nsec))
  throw new Error('HIVE_CI_WATCHER_CLI_ACCOUNT or HIVE_CI_WATCHER_CLI_NSEC is required')
}
