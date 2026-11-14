import { createRoot } from "react-dom/client"
import { OceanScene } from "@/components/ui/ocean-scene"
import { MakoMark } from "@/components/ui/mako-mark"
import { setPref, usePrefs } from "@/state/prefs"
import "../index.css"

// The selected treatment, not a gallery of alternatives.
setPref("oceanTone", "ink")

export function Studies() {
  const motion = usePrefs((prefs) => prefs.oceanMotion)
  return (
    <div className="flex h-full flex-col bg-background text-ui text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-6">
        <span className="flex items-center gap-2 font-medium">
          <MakoMark className="size-4" /> Mako
        </span>
        <button
          type="button"
          aria-pressed={motion}
          onClick={() => setPref("oceanMotion", !motion)}
          className="pressable ocean-preview-controls px-3 py-1.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground focus-visible:outline focus-visible:outline-1"
        >
          {motion ? "Pause animation" : "Play animation"}
        </button>
      </header>
      <main className="min-h-0 flex-1">
        <div className="ocean-preview ocean-preview-selected flex flex-col items-center">
          <div className="relative mt-20 px-6 text-center">
            <MakoMark className="mx-auto mb-5 size-9 text-muted-foreground" />
            <h1 className="text-welcome font-medium">What are we working on?</h1>
            <p className="mt-3 text-muted-foreground">A little room for your next idea.</p>
          </div>
          <OceanScene tone="ink" animated={motion} />
          <div className="relative mt-auto w-full max-w-content px-6 pb-6">
            <textarea
              rows={3}
              aria-label="Draft"
              placeholder="Start with a thought…"
              className="ocean-preview-controls w-full resize-none border border-border bg-popover p-4 text-ui outline-none focus:border-ring"
            />
            <p className="mt-2 text-center text-label text-faint">The water rests while you write.</p>
          </div>
        </div>
      </main>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Studies />)
