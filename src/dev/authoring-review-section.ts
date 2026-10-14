/** Which Settings section the authoring review page shows; the test moves it. */
let section = "native-authoring"
const listeners = new Set<() => void>()

export const reviewSection = {
  get: () => section,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  show(next: string) {
    section = next
    for (const listener of listeners) listener()
  },
}
