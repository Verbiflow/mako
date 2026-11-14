/**
 * What a test's headless Chrome needs to keep serving a page whatever covers it. A window Chrome reads as covered or in
 * the background stops producing frames, and input waits for one: on a Mac runner one click went unanswered past its
 * cell's 30 s. The renderer runs as a person's foreground tab does.
 */
export const HEADLESS_CHROME_ARGS = [
  "--headless=new",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
]
