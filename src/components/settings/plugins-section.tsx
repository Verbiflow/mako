import { useEffect, useState } from "react"
import { Action } from "@/components/ui/kit"
import { IfCanReveal } from "@/components/ui/machine-gate"
import { pluginFiles } from "@/state/plugins"
import { plugins } from "@/extend/plugin-host"
import { useRegistry } from "@/extend/registry"
import { cn } from "@/lib/utils"
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, FolderOpenIcon, PlusIcon, Trash2Icon } from "lucide-react"

/**
 * The app, editing itself — with a place to watch it happen.
 *
 * Local UI extensions are trusted single files that hot-load into the running
 * window: save one — here, in an editor, or by asking the agent to write it —
 * and its commands, slots, and panels appear without a reload. This section is
 * the loop's dashboard: every extension with its live status, its source editable
 * in place, and a broken one wearing its error instead of failing silently.
 *
 * The editor is a textarea on purpose. A plugin is a page of code; the
 * agent writes most of them; and the moment one outgrows a textarea it
 * deserves the real editor — which is one "open folder" away.
 */

const TEMPLATE = `// A trusted local Mako UI extension, hot-loaded on save.
// \`mako\` is in scope — commands, slots, session state, every thread on
// this machine, and toasts. No imports, no build step.

export function setup() {
  if (mako.apiVersion !== 1) throw new Error("This extension requires Mako UI API 1")
  mako.registerCommand({
    id: "hello",
    title: "Say hello from a plugin",
    section: "Extension",
    run: () => {
      const threads = mako.threads.read().threads
      mako.toast(\`Hello — this machine has \${threads.length} agent threads.\`)
    },
  })

  // Render into a named slot. This one sits at the bottom of the rail.
  mako.registerSlot("rail.footer", () => (
    <div style={{ padding: "6px 10px", fontSize: 10.5, opacity: 0.5 }}>
      hello from a plugin
    </div>
  ))
}
`

export function PluginsSection() {
  const registry = useRegistry(plugins)
  const loaded = registry.list().filter((plugin) => plugin.source !== "")
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [dir, setDir] = useState("")

  useEffect(() => {
    if (!pluginFiles.available()) return
    void pluginFiles.directory().then(setDir).catch(() => {})
  }, [])

  const edit = (id: string, source: string) => {
    setOpen(open === id ? null : id)
    setDraft(source)
  }

  const save = async (id: string) => {
    setSaving(true)
    try {
      await pluginFiles.write(id, draft)
      // The watcher reloads it; the row's status updates itself through the
      // registry. Nothing to await here except the write.
    } finally {
      setSaving(false)
    }
  }

  const create = async () => {
    const base = "my-plugin"
    let name = base
    let counter = 2
    while (loaded.some((plugin) => plugin.id === name)) name = `${base}-${counter++}`
    await pluginFiles.write(name, TEMPLATE)
    setOpen(name)
    setDraft(TEMPLATE)
  }

  return (
    <div>
      <p className="pb-3 text-ui leading-relaxed text-muted-foreground">
        Trusted local UI code that hot-loads into this window. Extensions can
        read and change the open session, preferences, and thread state, so use
        only code you control. Ask the agent to write one in{" "}
        <code className="rounded bg-raised px-1 text-label">{dir || "the extensions folder"}</code>{" "}
        and the window picks it up without a reload.
      </p>

      {loaded.length === 0 ? (
        <p className="pb-2 text-ui text-faint">No local UI extensions yet.</p>
      ) : (
        loaded.map((plugin) => {
          const editing = open === plugin.id
          return (
            <div key={plugin.id} className="border-b border-hairline last:border-b-0">
              <button
                type="button"
                onClick={() => edit(plugin.id, plugin.source)}
                className="flex w-full items-center gap-2.5 py-2 text-left"
              >
                <ChevronRightIcon
                  className={cn(
                    "size-3 shrink-0 text-faint transition-transform duration-200 ease-out",
                    editing && "rotate-90"
                  )}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-ui">{plugin.id}</span>
                {plugin.error ? (
                  <span
                    className="flex min-w-0 items-center gap-1 text-label text-negative"
                    title={plugin.error}
                  >
                    <AlertTriangleIcon className="size-3 shrink-0" />
                    <span className="max-w-56 truncate">{plugin.error}</span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-label text-positive/80">
                    <CheckIcon className="size-3" />
                    loaded
                  </span>
                )}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Delete ${plugin.id}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    void pluginFiles.remove(plugin.id)
                    if (open === plugin.id) setOpen(null)
                  }}
                  className="shrink-0 rounded p-1 text-faint transition-colors hover:text-negative"
                >
                  <Trash2Icon className="size-3" />
                </span>
              </button>

              {editing ? (
                <div className="pb-3 pl-5">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                        event.preventDefault()
                        void save(plugin.id)
                      }
                    }}
                    spellCheck={false}
                    rows={Math.min(24, Math.max(10, draft.split("\n").length + 1))}
                    className="w-full resize-y rounded-md bg-surface p-2.5 font-mono text-label leading-relaxed text-foreground/90 focus:ring-1 focus:ring-hairline focus:outline-none"
                  />
                  <div className="flex items-center gap-2 pt-1.5">
                    <Action disabled={saving || draft === plugin.source} onClick={() => void save(plugin.id)}>
                      Save — reloads live
                    </Action>
                    <span className="text-label text-faint">⌘S saves too</span>
                    {plugin.error ? (
                      <span className="min-w-0 truncate text-label text-negative">{plugin.error}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })
      )}

      <div className="flex items-center gap-2 pt-3">
        <Action onClick={() => void create()}>
          <PlusIcon className="size-3" />
          New UI extension
        </Action>
        <IfCanReveal>
          <Action tone="outline" onClick={() => void pluginFiles.reveal()}>
            <FolderOpenIcon className="size-3" />
            Open folder
          </Action>
        </IfCanReveal>
      </div>
    </div>
  )
}
