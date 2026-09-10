import {loadConfig} from './config.js'
import {Authorizer} from './cvm/auth.js'
import {startCvmServer} from './cvm/server.js'
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
    owner: config.ownerPubkey,
    db: config.databasePath,
    relays: config.relays.length,
  })

  const watcher = new Watcher(config, db, identity)
  await watcher.start()

  const cvm = await startCvmServer({
    config,
    db,
    identity,
    watcher,
    authorizer: new Authorizer(db, config.ownerPubkey),
  })

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', {signal})
    await cvm.close().catch(err => log.warn('cvm close failed', {error: errorMessage(err)}))
    await watcher.stop().catch(err => log.warn('watcher stop failed', {error: errorMessage(err)}))
    db.close()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(err => {
  log.error('fatal', {error: errorMessage(err)})
  process.exit(1)
})
