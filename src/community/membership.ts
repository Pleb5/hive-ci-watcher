import type {NostrEvent} from 'nostr-tools'
import {communityPointer, HEX64, listAddress, personReportTarget, preferred, parseDefinition, retractedReport, tags, type Definition} from './protocol.js'

/** A private authority view: generic NIP-09 processing must never erase 32222/30000 here. */
export class CommunityView {
  definition?: Definition
  private readonly lists = new Map<string, NostrEvent>()
  private readonly reports = new Map<string, NostrEvent>()
  private readonly retractions = new Map<string, NostrEvent>()

  constructor(readonly address: string) {
    if (!communityPointer(address)) throw new Error('invalid community address')
  }

  /** Accepts trusted events only. The service verifies both live and persisted input. */
  apply(event: NostrEvent): boolean {
    if (event.kind === 32222) {
      const definition = parseDefinition(event)
      if (!definition || definition.address !== this.address || !preferred(event, this.definition?.event)) return false
      this.definition = definition
      const referenced = new Set(this.refs().map(ref => ref.address))
      for (const address of this.lists.keys()) if (!referenced.has(address)) this.lists.delete(address)
      return true
    }
    if (event.kind === 30000) {
      const address = listAddress(event)
      if (!address || !this.refs().some(ref => ref.address === address) || !preferred(event, this.lists.get(address))) return false
      this.lists.set(address, event)
      return true
    }
    if (event.kind === 1984) {
      if (!personReportTarget(event, this.address) || this.reports.has(event.id)) return false
      this.reports.set(event.id, event)
      return true
    }
    if (event.kind === 5) {
      // Keep same-author report tombstones, including retractions received before
      // their report. They have no effect whatsoever on definitions or lists.
      const target = retractedReport(event, this.address)
      const key = `${event.pubkey}:${target}`
      if (!target || this.retractions.has(key)) return false
      this.retractions.set(key, event)
      return true
    }
    return false
  }

  refs() { return this.definition?.sections.flatMap(section => section.refs) ?? [] }

  snapshot(): NostrEvent[] {
    const referenced = new Set(this.refs().map(ref => ref.address))
    return [
      ...(this.definition ? [this.definition.event] : []),
      ...[...this.lists].filter(([address]) => referenced.has(address)).map(([, event]) => event),
      ...this.reports.values(),
      ...new Map([...this.retractions.values()].map(event => [event.id, event])).values(),
    ]
  }

  members(): Set<string> {
    const owner = communityPointer(this.address)!.owner
    const members = new Set([owner])
    const definition = this.definition
    if (!definition) return members // Same pinned-owner bootstrap rule as client/relay readers.
    const moderatorSets: Set<string>[] = []
    for (const section of definition.sections) {
      const moderators = new Set([owner])
      for (const ref of section.refs) {
        members.add(ref.owner) // Structural member even if the list is missing/declined.
        const list = this.lists.get(ref.address)
        if (!list || tags(list, 'status')[0]?.[1] === 'declined') continue
        moderators.add(ref.owner)
        for (const p of tags(list, 'p')) if (HEX64.test(p[1] ?? '')) members.add(p[1]!)
      }
      moderatorSets.push(moderators)
    }
    const moderators = new Set(moderatorSets.flatMap(set => [...set]))
    const allModerators = new Set([...moderators].filter(key => moderatorSets.every(set => set.has(key))))
    const reports = [...this.reports.values()].flatMap(event => {
      const target = personReportTarget(event, this.address)
      if (!target || event.pubkey === target || this.retractions.has(`${event.pubkey}:${event.id}`)) return []
      if (event.pubkey !== owner && (moderators.has(target) || !allModerators.has(event.pubkey))) return []
      return [{event, target}]
    })
    let banned = new Set<string>()
    // Match the client's fixpoint: an effectively banned reporter loses authority.
    for (let i = 0; i <= reports.length; i++) {
      const next = new Set(reports.filter(r => !banned.has(r.event.pubkey)).map(r => r.target))
      if (next.size === banned.size && [...next].every(key => banned.has(key))) break
      banned = next
    }
    for (const key of banned) if (key !== owner) members.delete(key)
    return members
  }
}
