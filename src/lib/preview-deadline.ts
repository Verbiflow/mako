/** Browser paint callbacks pause in hidden tabs; only visible render time consumes this budget. */
export function visiblePreviewDeadline(
  milliseconds: number,
  expire: () => void,
  page: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document
): () => void {
  let remaining = milliseconds
  let started = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const clear = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    remaining -= Date.now() - started
  }
  const release = () => {
    if (disposed) return
    disposed = true
    clear()
    page.removeEventListener("visibilitychange", resume)
  }
  const resume = () => {
    clear()
    if (disposed || page.hidden) return
    started = Date.now()
    timer = setTimeout(() => { release(); expire() }, Math.max(0, remaining))
  }
  page.addEventListener("visibilitychange", resume)
  resume()
  return release
}
