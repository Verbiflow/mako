export interface DeskNavigationEvent {
  preventDefault(): void
}

export interface DeskNavigationSource {
  on(
    event: "will-navigate" | "will-redirect",
    listener: (event: DeskNavigationEvent, url: string) => void
  ): void
}

/** Keep a privileged hidden renderer inside the document policy it opened with. */
export function guardDeskNavigation(
  source: DeskNavigationSource,
  allowsUrl: (url: string) => boolean,
  blocked: (url: string) => void
): void {
  const guard = (event: DeskNavigationEvent, url: string) => {
    if (allowsUrl(url)) return
    event.preventDefault()
    blocked(url)
  }
  source.on("will-navigate", guard)
  source.on("will-redirect", guard)
}
