/** A controlled browser-observer boundary; no geometry or real-DOM claim. */
export class RowIntersection implements IntersectionObserver {
  static instances: RowIntersection[] = []
  readonly root = null
  readonly rootMargin = "0px"
  readonly scrollMargin = "0px"
  readonly thresholds = [0]
  readonly targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback) { RowIntersection.instances.push(this) }
  observe(element: Element) { this.targets.add(element) }
  unobserve(element: Element) { this.targets.delete(element) }
  disconnect() { this.targets.clear() }
  takeRecords(): IntersectionObserverEntry[] { return [] }
  emit(element: Element, visible: boolean, time = performance.now()) {
    const rectangle: DOMRectReadOnly = { x: 0, y: 0, width: 1, height: 1, top: 0, right: 1, bottom: 1, left: 0, toJSON: () => ({}) }
    this.callback([{ target: element, isIntersecting: visible, time, boundingClientRect: rectangle, intersectionRect: rectangle, intersectionRatio: visible ? 1 : 0, rootBounds: rectangle }], this)
  }
}
