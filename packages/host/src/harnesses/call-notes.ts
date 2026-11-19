/**
 * Which routing notes each conversation has heard. A note names the Mako call
 * that does what a native call did; said on every such call it became noise
 * (2026-11-03 to 17: "pull_request_status reads this branch's pull request…"
 * 2,246 times on Claude, "Don't wait in a loop" 931), so each rule's note is
 * given once per conversation. Refusals are never held back: a deny is the
 * answer to its call, every time.
 *
 * One per host, made where the host is composed (or per driver), never at
 * module scope. Bounded: past `limit` conversations the one heard from least
 * recently is forgotten, and would hear its notes again.
 */
export class CallNotes {
  private readonly heard = new Map<string, Set<string>>()
  private readonly limit: number

  constructor(limit = 2_048) {
    this.limit = limit
  }

  /** Whether this conversation hears `rule`'s note now: only the first time. */
  first(conversation: string, rule: string): boolean {
    let rules = this.heard.get(conversation)
    if (rules) this.heard.delete(conversation)
    else rules = new Set()
    this.heard.set(conversation, rules)
    if (this.heard.size > this.limit) this.heard.delete(this.heard.keys().next().value!)
    if (rules.has(rule)) return false
    rules.add(rule)
    return true
  }

  /** The conversation's model lost what it heard (a compaction, a new session): its notes are said again. */
  forget(conversation: string): void {
    this.heard.delete(conversation)
  }
}
