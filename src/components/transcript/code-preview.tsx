import { useEffect, useState } from "react"
import type { ThemedToken } from "shiki"
import { useVisible } from "./use-visible"
import { MediaContent } from "./media-preview"

export function HighlightedCode({source, language, streaming}: {source: string; language: string; streaming: boolean}) {
  const {ref, visible} = useVisible()
  const [result, setResult] = useState<{source: string; language: string; tokens: ThemedToken[][]}>()
  useEffect(() => {
    if (!visible || streaming || source.length > 100_000) return
    let canceled = false
    void import("@/lib/highlight-code").then((module) => module.highlightCode(source, language)).then(
      (tokens) => { if (!canceled) setResult({source, language, tokens}) },
      () => { /* Plain source remains readable when a grammar cannot load. */ }
    )
    return () => { canceled = true }
  }, [visible, streaming, source, language])
  return <div ref={ref}><pre><code>{result?.source === source && result.language === language
    ? result.tokens.map((line, index) => <span key={index} className="code-line">{line.map((token, part) => <span key={part} style={{color: token.color}}>{token.content}</span>)}{index < result.tokens.length - 1 ? "\n" : null}</span>)
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
