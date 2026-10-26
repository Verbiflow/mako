import { useEffect, useState } from "react"

/**
 * Heavy transcript previews start only when close to the reading viewport.
 * `ref` is a callback, so an element that mounts after the component did
 * (a turn's shelf that fills once the turn has made something) is watched
 * from the moment it is there.
 */
export function useVisible() {
  const [element, ref] = useState<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!element || visible) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVisible(true)
      observer.disconnect()
    }, {rootMargin: "240px"})
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, visible])
  return {ref, visible}
}
