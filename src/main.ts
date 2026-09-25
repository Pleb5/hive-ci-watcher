import './env-defaults.js'
import {nip19} from 'nostr-tools'
import {loadConfig} from './config.js'
import {startCvmServer, type CvmServerHandle} from './cvm/server.js'
import {WatcherDb} from './db/index.js'
import {WatcherIdentity} from './identity.js'
import {createLogger, errorMessage} from './log.js'
import {Watcher} from './watcher.js'

const log = createLogger('main')

async function main(): Promise<void> {
  const config = loadConfig()
  const identity = new WatcherIdentity(config.secretKeyHex)
  const db = new WatcherDb(config.databasePath)

  log.info('starting hive-ci-watcher', {
    pubkey: identity.pubkey,
    npub: nip19.npubEncode(identity.pubkey),
    keySource: config.keySource,
    keyFile: config.keyFile ?? null,
    owner: config.ownerPubkey,
    db: config.databasePath,
    relays: config.relays.length,
  })

  if (config.keySource === 'generated') {
    // The identity is new every boot. This is the line an operator needs to
    // whitelist it on a worker and to point the CLI at it.
    log.warn('watcher identity generated for this boot only', {
      pubkey: identity.pubkey,
      npub: nip19.npubEncode(identity.pubkey),
      hint: 'set HIVE_CI_WATCHER_KEY_FILE (generated once, reused) or HIVE_CI_WATCHER_NSEC for an identity that survives restarts',
    })
  }

  const watcher = new Watcher(config, db, identity)
  let cvm: CvmServerHandle | null = null

  // Registered before the slow parts of startup (relay discovery, the CVM
  // announcement) so a signal that lands mid-start still tears down cleanly
  // — and, for an ephemeral identity, still retracts whatever was announced.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', {signal})
    if (cvm) {
      // An identity that dies with the process should not leave a
      // discoverable 11316 behind pointing at nothing.
      if (config.keySource === 'generated') {
        await cvm.retract('watcher stopped; identity was ephemeral').catch(err =>
          log.warn('announcement retraction failed', {error: errorMessage(err)}),
        )
      }
      await cvm.close().catch(err => log.warn('cvm close failed', {error: errorMessage(err)}))
    }
    await watcher.stop().catch(err => log.warn('watcher stop failed', {error: errorMessage(err)}))
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await watcher.start()
  if (shuttingDown) return

  cvm = await startCvmServer({
    config,
    db,
    identity,
    watcher,
    authorizer: watcher.authorizer,
  })
}

main().catch(err => {
  log.error('fatal', {error: errorMessage(err)})
  process.exit(1)
})
