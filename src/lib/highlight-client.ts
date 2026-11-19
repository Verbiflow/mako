import { KeptResults } from "./kept-results"

/** A piece of a highlighted line: its words and the colour they're drawn in. */
export interface CodeToken {
  content: string
  color?: string
}
export type CodeLines = CodeToken[][]
export type HighlightReply = { ok: true; lines: CodeLines } | { ok: false }

/** What tokenizes: a worker in the window, and whatever a test gives. */
export type Tokenizer = (source: string, language: string) => Promise<CodeLines | null>

const SEPARATOR = "\u0000"
/** About what a long session's code blocks come to; a block's tokens are several times its source. */
const KEPT = { entries: 300, weight: 1_500_000 }

/**
 * The transcript's highlighted code blocks, by language and source. Tokenized in a worker, never on the page: a
 * block's grammar ran in the click that showed it, and every visible block of an answer in the tick it settled.
 * Kept, so a block that mounts again (a Thread opened again, a turn scrolled back to) draws its colours in its first
 * render, with no plain frame before them. One block's result is handed over per frame (`frame`), so an answer with a
 * dozen blocks colours them over a dozen frames, not in one.
 */
export class HighlightCache {
  private readonly kept: KeptResults<CodeLines>
  private readonly landing: (() => void)[] = []
  private landingSoon = false
  private readonly frame: (run: () => void) => void

  constructor(tokenize: Tokenizer, frame: (run: () => void) => void = nextFrame, limits = KEPT) {
    this.frame = frame
    this.kept = new KeptResults<CodeLines>((key) => {
      const cut = key.indexOf(SEPARATOR)
      return tokenize(key.slice(cut + 1), key.slice(0, cut))
    }, limits)
  }

  /** The block's lines if they're kept: read while rendering, so a block mounting again never draws plain first. */
  get(source: string, language: string): CodeLines | undefined {
    return this.kept.get(language + SEPARATOR + source)
  }

  /** The block's lines, tokenized once however many blocks ask, and handed over a frame apart from any other's. */
  want(source: string, language: string): Promise<CodeLines | null> {
    const key = language + SEPARATOR + source
    const kept = this.kept.get(key)
    if (kept) return Promise.resolve(kept)
    return this.kept.want(key).then((lines) => new Promise<CodeLines | null>((resolve) => {
      this.landing.push(() => resolve(lines))
      this.land()
    }))
  }

  private land(): void {
    if (this.landingSoon) return
    this.landingSoon = true
    this.frame(() => {
      this.landingSoon = false
      this.landing.shift()?.()
      if (this.landing.length) this.land()
    })
  }
}

function nextFrame(run: () => void): void {
  if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(run)
  else setTimeout(run, 0)
}

let worker: Worker | null = null
let unavailable = false

/** On the page, as it was, where there is no worker or it failed: plain source stays readable either way. */
async function onPage(source: string, language: string): Promise<CodeLines | null> {
  const { highlightCode } = await import("./highlight-code")
  return (await highlightCode(source, language)).map((line) => line.map((token) => ({ content: token.content, color: token.color })))
}

function inWorker(source: string, language: string): Promise<CodeLines | null> {
  if (!globalThis.Worker || unavailable) return onPage(source, language)
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    let done = false
    const finish = (lines: CodeLines | null) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      channel.port1.onmessage = null
      channel.port1.onmessageerror = null
      channel.port1.close()
      resolve(lines)
    }
    const failed = () => {
      unavailable = true
      worker?.terminate()
      worker = null
      void onPage(source, language).then(finish, () => finish(null))
    }
    // A grammar can take seconds to load the first time; past this the worker isn't coming back.
    const timeout = setTimeout(failed, 30_000)
    channel.port1.onmessage = (event: MessageEvent<HighlightReply>) => finish(event.data.ok ? event.data.lines : null)
    channel.port1.onmessageerror = failed
    try {
      worker ??= new Worker(new URL("./highlight-code.worker.ts", import.meta.url), { type: "module" })
      worker.onerror = (event) => {
        console.error("Highlight worker failed:", event.message)
        failed()
      }
      worker.postMessage({ source, language }, [channel.port2])
    } catch (error) {
      console.error("Highlight worker could not start:", error)
      failed()
    }
  })
}

/** The window's own: every code block of every transcript reads and fills this one. */
export const codeHighlights = new HighlightCache(inWorker)
