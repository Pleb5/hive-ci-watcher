/** Headless Communikeys V2 authority parsing. See docs/community-access.md for provenance. */
import {nip19, type NostrEvent} from 'nostr-tools'

export const HEX64 = /^[0-9a-f]{64}$/
const uint = /^(0|[1-9][0-9]*)$/
const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const text = (s: string | undefined, max: number) => !!s && s === s.trim() && bytes(s) <= max
export const tags = (event: Pick<NostrEvent, 'tags'>, name: string) => event.tags.filter(t => t[0] === name)

export interface CommunityPointer {address: string; owner: string; id: string}
export interface ListRef {address: string; owner: string; identifier: string; relay?: string}
export interface Section {name: string; refs: ListRef[]}
export interface Definition extends CommunityPointer {event: NostrEvent; relays: string[]; sections: Section[]}

export function communityPointer(address: string): CommunityPointer | undefined {
  const [kind, owner = '', id = '', ...extra] = address.split(':')
  if (kind !== '32222' || extra.length || !HEX64.test(owner) || !HEX64.test(id)) return undefined
  return {address, owner, id}
}

export function normalizeUrl(value: string | undefined, schemes = ['wss:']): string | undefined {
  if (!value || value !== value.trim() || bytes(value) > 2048) return undefined
  try {
    const url = new URL(value)
    if (!schemes.includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) return undefined
    let result = url.toString()
    if (url.pathname === '/' && !url.search) result = result.slice(0, -1)
    return result
  } catch { return undefined }
}

export function normalizePerson(value = ''): string {
  const trimmed = value.trim().toLowerCase()
  if (HEX64.test(trimmed)) return trimmed
  try {
    const decoded = nip19.decode(value.trim())
    return decoded.type === 'npub' ? decoded.data : ''
  } catch { return '' }
}

function kindNumber(value = ''): number | undefined {
  return uint.test(value) && Number(value) <= 65535 ? Number(value) : undefined
}

function addressRef(value = '', requiredKind?: number): ListRef | undefined {
  const [kindValue, owner = '', ...rest] = value.split(':')
  const kind = kindNumber(kindValue)
  const identifier = rest.join(':')
  if (kind === undefined || kind < 30000 || kind >= 40000 || (requiredKind !== undefined && kind !== requiredKind) ||
    !HEX64.test(owner) || !identifier || bytes(identifier) > 200) return undefined
  return {address: value, owner, identifier}
}

function scopedIdentifier(id: string, identifier: string): boolean {
  if (!identifier.startsWith(`${id}-`) || bytes(identifier) > 200) return false
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.(?:[2-9]|[1-9][0-9]+))?$/.test(identifier.slice(id.length + 1))
}

/** Signature/ID verification belongs at ingress; this parser also runs on trusted golden fixtures. */
export function parseDefinition(event: NostrEvent): Definition | undefined {
  if (event.kind !== 32222 || event.content !== '' || !HEX64.test(event.pubkey)) return undefined
  const d = tags(event, 'd')
  if (d.length !== 1 || d[0]!.length !== 2 || !HEX64.test(d[0]![1] ?? '') || tags(event, 'h').length) return undefined
  const id = d[0]![1]!
  const names = tags(event, 'name')
  if (names.length !== 1 || names[0]!.length !== 2 || !text(names[0]![1], 100)) return undefined
  for (const [name, max] of [['description', 4096], ['location', 256]] as const) {
    const found = tags(event, name)
    if (found.length > 1 || found.some(t => t.length !== 2 || !text(t[1], max))) return undefined
  }
  for (const name of ['picture', 'banner', 'website']) {
    const found = tags(event, name)
    if (found.length > 1 || found.some(t => t.length !== 2 || !normalizeUrl(t[1], name === 'website' ? ['https:', 'http:'] : ['https:']))) return undefined
  }
  const geo = tags(event, 'g')
  if (geo.length > 1 || geo.some(t => t.length !== 2 || !/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/.test(t[1] ?? ''))) return undefined
  for (const name of ['r', 'blossom', 'grasp']) {
    const found = tags(event, name)
    if ((name === 'r' && !found.length) || found.length > 20 || found.some(t =>
      t.length !== 2 || !t[1] || normalizeUrl(t[1], name === 'blossom' ? ['https:'] : ['wss:']) !== t[1],
    )) return undefined
  }
  const mints = tags(event, 'mint')
  if (mints.length > 20 || mints.some(t => ![2, 3].includes(t.length) || !t[1] || normalizeUrl(t[1], ['https:']) !== t[1] ||
    (t[2] && !/^[\x21-\x7e]{1,32}$/.test(t[2])))) return undefined
  const terms = tags(event, 'tos')
  if (terms.length > 1 || terms.some(t => ![2, 3].includes(t.length) || !(HEX64.test(t[1] ?? '') || addressRef(t[1])) ||
    (t[2] && normalizeUrl(t[2]) !== t[2]))) return undefined
  const services = tags(event, 'service')
  if (services.length > 50 || services.some(t => t.length !== 6 || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(t[1] ?? '') ||
    !HEX64.test(t[2] ?? '') || !t[3] || normalizeUrl(t[3]) !== t[3] || !addressRef(t[4]) || !t[5] || normalizeUrl(t[5]) !== t[5])) return undefined

  const top = new Set(['d', 'name', 'description', 'picture', 'banner', 'website', 'r', 'blossom', 'grasp', 'mint', 'location', 'g', 'tos', 'service'])
  const sections: Section[] = []
  const seenNames = new Set<string>(), seenKinds = new Set<string>()
  let section: Section | undefined
  let kindCount = 0
  for (const t of event.tags) {
    if (t[0] === 'content') {
      if (section && !kindCount) return undefined
      if (t.length !== 2 || !text(t[1], 100)) return undefined
      const key = t[1]!.replace(/[A-Z]/g, s => s.toLowerCase())
      if (seenNames.has(key)) return undefined
      seenNames.add(key)
      section = {name: t[1]!, refs: []}
      sections.push(section)
      kindCount = 0
    } else if (section && top.has(t[0]!)) return undefined
    else if (['k', 'a', 'badge', 'retention'].includes(t[0]!)) {
      if (!section) return undefined
      if (t[0] === 'k') {
        if (![2, 3].includes(t.length) || kindNumber(t[1]) === undefined || (t.length === 3 && !text(t[2], 64))) return undefined
        const key = `${t[1]}:${t[2] ?? ''}`
        if (seenKinds.has(key)) return undefined
        seenKinds.add(key)
        kindCount++
      } else if (t[0] === 'a' || t[0] === 'badge') {
        const ref = addressRef(t[1], t[0] === 'a' ? 30000 : 30009)
        if (![2, 3].includes(t.length) || !ref || (t[2] && !normalizeUrl(t[2]))) return undefined
        if (t[0] === 'a') {
          if (!scopedIdentifier(id, ref.identifier)) return undefined
          section.refs.push({...ref, ...(t[2] ? {relay: normalizeUrl(t[2])} : {})})
        }
      } else if (t.length !== 4 || kindNumber(t[1]) === undefined || !uint.test(t[2] ?? '') ||
        !Number.isSafeInteger(Number(t[2])) || Number(t[2]) <= 0 || !['time', 'count'].includes(t[3]!)) return undefined
    }
  }
  if (!sections.length || !kindCount) return undefined
  return {event, owner: event.pubkey, id, address: `32222:${event.pubkey}:${id}`, relays: [...new Set(tags(event, 'r').map(t => t[1]!))], sections}
}

export function listAddress(event: NostrEvent): string | undefined {
  const d = tags(event, 'd')
  return event.kind === 30000 && HEX64.test(event.pubkey) && d.length === 1 && d[0]!.length === 2 && d[0]![1]
    ? `30000:${event.pubkey}:${d[0]![1]}` : undefined
}

export function preferred(candidate: NostrEvent, current?: NostrEvent): boolean {
  return !current || candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id)
}

export function authority(event: NostrEvent): CommunityPointer | undefined {
  const h = tags(event, 'h'), a = tags(event, 'a').filter(t => t[3] === 'community')
  if (h.length !== 1 || h[0]!.length !== 2 || a.length !== 1 || a[0]!.length !== 4) return undefined
  const pointer = communityPointer(a[0]![1] ?? '')
  if (!pointer || h[0]![1] !== pointer.id || (a[0]![2] && normalizeUrl(a[0]![2]) !== a[0]![2])) return undefined
  return pointer
}

const reason = (t: string[]) => !!(t[3]?.trim() || (t[2]?.trim() && !/^wss?:\/\//i.test(t[2].trim())))

/** Event reports do not ban people, even when they contain a reason-bearing p tag. */
export function personReportTarget(event: NostrEvent, branch: string): string | undefined {
  if (event.kind !== 1984 || authority(event)?.address !== branch) return undefined
  if (tags(event, 'e').some(t => t[4] !== 'report' && reason(t) && t[1]) ||
    tags(event, 'a').some(t => t[3] !== 'community' && reason(t) && addressRef(t[1]))) return undefined
  return normalizePerson(tags(event, 'p').find(t => t[4] !== 'report' && reason(t))?.[1]) || undefined
}

/** The protocol's marked, community-scoped retraction, not a generic NIP-09 delete. */
export function retractedReport(event: NostrEvent, branch: string): string | undefined {
  if (event.kind !== 5) return undefined
  const pointer = communityPointer(branch)!
  const h = tags(event, 'h')
  if (h.length !== 1 || h[0]!.length !== 2 || h[0]![1] !== pointer.id) return undefined
  if (tags(event, 'a').some(t => t[3] === 'community') && authority(event)?.address !== branch) return undefined
  const refs = tags(event, 'e').filter(t => t[4] === 'report')
  if (refs.length !== 1 || refs[0]!.length !== 5) return undefined
  const ref = refs[0]!
  if (!ref[1]?.trim() || normalizePerson(ref[3]) !== event.pubkey || (ref[2] && normalizeUrl(ref[2]) !== ref[2])) return undefined
  const kinds = tags(event, 'k')
  if (kinds.length && !kinds.some(t => t[1] === '1984')) return undefined
  return ref[1].trim()
}
