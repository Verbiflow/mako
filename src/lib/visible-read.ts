/** Intersection owns detail demand; list membership, badges and ordering stay live elsewhere. */
interface Interest {
  start: () => (() => void) | undefined
  release?: () => void
  visible: boolean
  active: boolean
  since: number
}

const interests = new Map<Element, Set<Interest>>()
let observer: IntersectionObserver | undefined

function show(entry: Interest, visible: boolean) {
  if (!entry.active || visible === entry.visible) return
  entry.visible = visible
  if (!visible) { entry.release?.(); entry.release = undefined; return }
  const release = entry.start()
  if (entry.active && entry.visible) entry.release = release
  else release?.()
}

/** A callback ref can return this release. Unknown intersection makes no detail read. */
export function observeVisibleRead(element: Element, start: Interest["start"]): () => void {
  // Older renderers without intersection support retain their existing mounted-reader policy.
  if (!globalThis.IntersectionObserver) {
    const release = start()
    let released = false
    return () => { if (!released) { released = true; release?.() } }
  }
  const interest: Interest = { start, visible: false, active: true, since: performance.now() }
  if (!observer) observer = new IntersectionObserver((records, source) => {
    if (source !== observer) return
    for (const record of records) for (const entry of interests.get(record.target) ?? []) {
      if (record.time < entry.since) continue
      show(entry, record.isIntersecting)
    }
  })
  let entries = interests.get(element)
  if (!entries) {
    entries = new Set()
    interests.set(element, entries)
  }
  entries.add(interest)
  // A second consumer must get a fresh initial record too. An older queued
  // exit may predate this interest, so copying another consumer's state is unsafe.
  observer.unobserve(element)
  observer.observe(element)
  let released = false
  return () => {
    if (released) return
    released = true
    interest.active = false
    interest.release?.()
    entries.delete(interest)
    if (!entries.size) { interests.delete(element); observer?.unobserve(element) }
    if (!interests.size) { observer?.disconnect(); observer = undefined }
  }
}
