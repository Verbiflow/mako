import { usePrefs } from "@/state/prefs"

const TOKENS = [
  "--foreground",
  "--surface",
  "--raised",
  "--border",
  "--muted-foreground",
  "--fill-hover",
  "--fill-selected",
  "--caution",
  "--negative",
  "--text-ui",
  "--text-label",
  "--text-title",
]

/** Compiled artifact code runs in an opaque origin with no Mako bridge. */
export function ArtifactPreview({
  html,
  name,
  kind,
}: {
  html: string
  name: string
  /** What the harness calls this artifact, when one wrote it. */
  kind?: string
}) {
  const theme = usePrefs((prefs) => prefs.theme)
  const style = getComputedStyle(document.documentElement)
  const variables = TOKENS.map(
    (token) => `${token}:${style.getPropertyValue(token)}`
  ).join(";")
  const documentHtml = html.replace(
    "</head>",
    `<style>:root{color-scheme:${theme === "light" ? "light" : "dark"};${variables}}</style></head>`
  )
  return (
    <div className="flex h-full min-h-96 flex-col">
      <p className="border-b border-hairline px-4 py-2 text-label text-faint">
        {kind ? `${kind} preview` : "Interactive preview"} · changes stay in
        this preview
      </p>
      <iframe
        title={`Preview ${name}`}
        sandbox="allow-scripts"
        srcDoc={documentHtml}
        className="min-h-96 w-full flex-1 border-0"
      />
    </div>
  )
}
