import {WebSocketServer, type WebSocket} from 'ws'
import {matchFilter, verifyEvent, type Filter, type NostrEvent} from 'nostr-tools'

/** A recording NIP-01/NIP-42 relay. All sockets stay on loopback. */
export async function relayFixture(auth = false) {
  const server = new WebSocketServer({host: '127.0.0.1', port: 0})
  await new Promise<void>(resolve => server.on('listening', resolve))
  const address = server.address() as {port: number}
  const url = `ws://127.0.0.1:${address.port}`
  const events: NostrEvent[] = []
  const requests: Filter[] = []
  const authentications: string[] = []
  const sockets = new Map<WebSocket, Map<string, Filter[]>>()
  const fixture = {url, events, requests, authentications, accept: true,
    close: async () => {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
  server.on('connection', socket => {
    const subs = new Map<string, Filter[]>()
    sockets.set(socket, subs)
    let authenticated = !auth
    if (auth) socket.send(JSON.stringify(['AUTH', 'test-challenge']))
    socket.on('close', () => sockets.delete(socket))
    socket.on('message', bytes => {
      const [type, id, ...rest] = JSON.parse(bytes.toString())
      if (type === 'AUTH') {
        const event = id as NostrEvent
        authenticated = verifyEvent(event) && event.kind === 22242 && event.tags.some(t => t[0] === 'challenge' && t[1] === 'test-challenge')
        if (authenticated) authentications.push(event.pubkey)
        socket.send(JSON.stringify(['OK', event.id, authenticated, '']))
      } else if (type === 'REQ') {
        if (rest.some(f => !f || typeof f !== 'object')) {
          socket.send(JSON.stringify(['CLOSED', id, 'error: invalid filter']))
          return
        }
        requests.push(...rest)
        if (!authenticated) { socket.send(JSON.stringify(['CLOSED', id, 'auth-required: authenticate'])); return }
        subs.set(id, rest)
        for (const event of events) if (rest.some((f: Filter) => matchFilter(f, event))) socket.send(JSON.stringify(['EVENT', id, event]))
        socket.send(JSON.stringify(['EOSE', id]))
      } else if (type === 'CLOSE') subs.delete(id)
      else if (type === 'EVENT') {
        const event = id as NostrEvent
        const accepted = fixture.accept && authenticated && verifyEvent(event)
        socket.send(JSON.stringify(['OK', event.id, accepted, accepted ? '' : authenticated ? 'blocked: test rejection' : 'auth-required: authenticate']))
        if (!accepted) return
        if (!events.some(e => e.id === event.id)) events.push(event)
        for (const [peer, filters] of sockets) for (const [sub, queries] of filters) {
          if (queries.some(f => matchFilter(f, event))) peer.send(JSON.stringify(['EVENT', sub, event]))
        }
      }
    })
  })
  return fixture
}
