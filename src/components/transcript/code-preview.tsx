import { useEffect, useState } from "react"
import { codeHighlights, type CodeLines } from "@/lib/highlight-client"
import { useVisible } from "./use-visible"
import { MediaContent } from "./media-preview"

/**
 * A code block's source, coloured once its lines are tokenized. The tokens come from the window's cache
 * (`codeHighlights`): there already, they're drawn in this render, so a block mounting again shows no plain frame;
 * not there, they're asked of the highlight worker once the block is near the viewport, and arrive a frame apart from
 * any other block's.
 */
export function HighlightedCode({source, language, streaming}: {source: string; language: string; streaming: boolean}) {
  const {ref, visible} = useVisible()
  const [result, setResult] = useState<{source: string; language: string; lines: CodeLines}>()
  const kept = streaming ? undefined : codeHighlights.get(source, language)
  useEffect(() => {
    if (!visible || streaming || source.length > 100_000 || kept) return
    let canceled = false
    void codeHighlights.want(source, language).then(
      (lines) => { if (!canceled && lines) setResult({source, language, lines}) },
      () => { /* Plain source remains readable when a grammar cannot load. */ }
    )
    return () => { canceled = true }
  }, [visible, streaming, source, language, kept])
  const lines = kept ?? (result?.source === source && result.language === language ? result.lines : undefined)
  return <div ref={ref}><pre><code>{lines
    ? lines.map((line, index) => <span key={index} className="code-line">{line.map((token, part) => <span key={part} style={{color: token.color}}>{token.content}</span>)}{index < lines.length - 1 ? "\n" : null}</span>)
    : source}</code></pre></div>
}

export function DiagramPreview({source}: {source: string}) {
  const [result, setResult] = useState<{source: string; url: string} | {source: string; error: string}>()
  useEffect(() => {
    if (source.length > 50_000) return
    let canceled = false
    let url: string | undefined
    // A mounted diagram must start without waiting for an intersection event.
    // CodeBlock mounts this preview only once the source has settled.
    async function render() {
      try {
        const module = await import("@/lib/render-diagram")
        if (canceled) return
        const svg = await module.renderDiagram(source)
        if (canceled) return
        url = URL.createObjectURL(new Blob([svg], {type: "image/svg+xml"}))
        setResult({source, url})
      } catch {
        if (!canceled) setResult({source, error: "Diagram could not render. The source is available above."})
      }
    }
    void render()
    return () => { canceled = true; if (url) URL.revokeObjectURL(url) }
  }, [source])
  const current = result?.source === source ? result : undefined
  return <div className="min-h-12 p-3">
    {current && "url" in current
      ? <MediaContent name="Diagram" url={current.url} mimeType="image/svg+xml" onError={() => setResult({source, error: "Diagram preview unavailable"})} />
      : <p className="text-ui text-faint">{current && "error" in current ? current.error : source.length > 50_000 ? "Diagram is too large to preview. View its source." : "Rendering diagram…"}</p>}
  </div>
}
