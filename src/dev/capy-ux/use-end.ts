import { useLayoutEffect, useRef } from "react"

/** A transcript held at its end, as a chat is. */
export function useEnd<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const crew = element.querySelector<HTMLElement>("[data-crew]")
    element.scrollTop = crew ? crew.offsetTop - element.offsetTop - 96 : element.scrollHeight
  })
  return ref
}
