import { useEffect, useState } from "react"
import { SearchSelect } from "@/components/ui/search-select"
import { desktop } from "@/state/desktop"
import type { ExternalEditor } from "@/lib/types"
import { setPref, usePrefs } from "@/state/prefs"

export function EditorSection() {
  const selected = usePrefs((prefs) => prefs.externalEditor)
  const [editors, setEditors] = useState<ExternalEditor[]>([])

  useEffect(() => {
    void desktop.externalEditors().then(setEditors).catch(() => setEditors([]))
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ui leading-relaxed text-muted-foreground">
        Files open in a detected editor without changing the app that macOS uses
        for every file type. Mako checks Zed, Cursor, VS Code, Windsurf, Sublime
        Text, and Xcode on this machine.
      </p>
      <div className="flex items-center gap-3 bg-raised px-3 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium text-foreground">
            Open files with
          </span>
          <span className="block text-label text-faint">
            {editors.length > 0
              ? `${editors.length} editors detected`
              : "No supported editor detected yet"}
          </span>
        </span>
        <SearchSelect
          value={selected ?? "auto"}
          label="External editor"
          searchPlaceholder="Search editors"
          className="w-52"
          options={[
            {
              value: "auto",
              label: "Auto-detect",
              detail: "Zed, Cursor, then VS Code",
            },
            ...editors.map((editor) => ({
              value: editor.id,
              label: editor.label,
              detail: "Installed on this Mac",
            })),
          ]}
          onChange={(next) =>
            setPref("externalEditor", next === "auto" ? undefined : next)
          }
        />
      </div>
    </div>
  )
}
