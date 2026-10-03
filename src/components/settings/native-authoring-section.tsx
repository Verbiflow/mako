import { useCallback, useEffect, useRef, useState } from "react"
import { nativeAuthoring } from "@/state/native-authoring"
import type { NativeAuthoringCatalog, NativeAuthoringDocument, NativeAuthoringTarget } from "@/lib/types"
import { Action } from "@/components/ui/kit"

const errorText = ({ error }: { error: unknown }) => error instanceof Error ? error.message : "The native configuration could not be read."

export function NativeAuthoringSection() {
  const [catalog, setCatalog] = useState<NativeAuthoringCatalog | null>(null)
  const [selection, setSelection] = useState("")
  const [entries, setEntries] = useState<{ id: string; name: string }[]>([])
  const [document, setDocument] = useState<NativeAuthoringDocument | null>(null)
  const [draft, setDraft] = useState("")
  const [newName, setNewName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const generation = useRef(0)
  const active = catalog?.capabilities.find((value) => `${value.provider}:${value.family}` === selection)
  const target: NativeAuthoringTarget | null = active && catalog ? { provider: active.provider, family: active.family, cwd: catalog.cwd } : null
  const dirty = document !== null && draft !== document.contents

  const choose = useCallback(async (catalog: NativeAuthoringCatalog, selection: string) => {
    const active = catalog.capabilities.find((value) => `${value.provider}:${value.family}` === selection)
    if (!active?.supported) return
    const version = ++generation.current
    setSelection(selection)
    setBusy(true)
    setError(null)
    setNotice(null)
    const target = { provider: active.provider, family: active.family, cwd: catalog.cwd }
    nativeAuthoring.select(catalog.cwd, selection)
    const restored = nativeAuthoring.draft(target)
    setDocument(restored?.document ?? null)
    setDraft(restored?.contents ?? "")
    try { const entries = await nativeAuthoring.list(target); if (generation.current === version) setEntries(entries) }
    catch (failure) { if (generation.current === version) setError(errorText({ error: failure })) }
    finally { if (generation.current === version) setBusy(false) }
  }, [])

  useEffect(() => {
    let current = true
    nativeAuthoring.catalog().then((value) => {
      if (!current) return
      setCatalog(value)
      const restored = nativeAuthoring.selection(value.cwd)
      const first = value.capabilities.find((entry) => entry.supported && `${entry.provider}:${entry.family}` === restored) ?? value.capabilities.find((entry) => entry.supported)
      if (first) void choose(value, `${first.provider}:${first.family}`)
    }).catch((failure) => { if (current) setError(errorText({ error: failure })) })
    return () => { current = false; generation.current = -1 }
  }, [choose])

  const open = async (id: string) => {
    if (!target || busy) return
    const version = ++generation.current
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const value = await nativeAuthoring.read(target, id)
      if (generation.current === version) { setDocument(value); setDraft(value.contents); nativeAuthoring.remember(target, value, value.contents) }
    } catch (failure) { if (generation.current === version) setError(errorText({ error: failure })) }
    finally { if (generation.current === version) setBusy(false) }
  }
  const save = async () => {
    if (!target || !document || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const version = generation.current
    try {
      const saved = await nativeAuthoring.write({ ...target, id: document.id, contents: draft, revision: document.revision })
      nativeAuthoring.saved(target, document, draft, saved)
      if (generation.current !== version) return
      setDocument(saved)
      setDraft(saved.contents)
      setNotice("Saved to the native project file. Start a new agent connection to use it.")
      try { const entries = await nativeAuthoring.list(target); if (generation.current === version) setEntries(entries) }
      catch (failure) { if (generation.current === version) setError(`Saved, but the command list could not refresh: ${errorText({ error: failure })}`) }
    } catch (failure) { if (generation.current === version) setError(errorText({ error: failure })) }
    finally { if (generation.current === version) setBusy(false) }
  }
  const remove = async () => {
    if (!target || !document?.revision || busy || dirty) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const version = generation.current
    try {
      await nativeAuthoring.remove({ ...target, id: document.id, revision: document.revision })
      nativeAuthoring.removed(target, document)
      if (generation.current !== version) return
      setDocument(null)
      setDraft("")
      setNotice("Removed from the native project configuration.")
      try { const entries = await nativeAuthoring.list(target); if (generation.current === version) setEntries(entries) }
      catch (failure) { if (generation.current === version) setError(`Removed, but the command list could not refresh: ${errorText({ error: failure })}`) }
    } catch (failure) { if (generation.current === version) setError(errorText({ error: failure })) }
    finally { if (generation.current === version) setBusy(false) }
  }

  return <div className="flex flex-col gap-4">
    <p className="text-ui text-muted-foreground">Edit native project hooks and custom commands. The agent reads these files and runs hooks with its own permissions.</p>
    {catalog ? <>
      <label className="flex flex-col gap-1 text-label text-muted-foreground">Agent and configuration
        <select aria-label="Agent and configuration" value={selection} disabled={busy || dirty} onChange={(event) => { setEntries([]); void choose(catalog, event.target.value) }} className="rounded-md border border-border bg-surface px-2 py-2 text-ui text-foreground">
          {catalog.capabilities.map((entry) => <option key={`${entry.provider}:${entry.family}`} value={`${entry.provider}:${entry.family}`} disabled={!entry.supported}>{entry.label} · {entry.family}{entry.supported ? "" : " · unavailable"}</option>)}
        </select>
      </label>
      <p className="text-label text-faint">{active?.detail}</p>
      <div className="flex flex-wrap gap-2">
        {entries.map((entry) => <Action key={entry.id} tone="outline" disabled={busy || dirty} onClick={() => void open(entry.id)}>{entry.name}</Action>)}
      </div>
      {active?.supported && active.family === "commands" ? <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-label text-muted-foreground">New command name
          <input aria-label="New command name" value={newName} disabled={busy || dirty} onChange={(event) => setNewName(event.target.value)} placeholder="review" className="rounded-md border border-border bg-surface px-2 py-2 text-ui text-foreground" />
        </label>
        <Action tone="outline" disabled={busy || dirty || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(newName)} onClick={() => void open(newName)}>Create command</Action>
      </div> : null}
      {document ? <>
        <p className="break-all text-label text-faint">{document.path}</p>
        <label className="flex flex-col gap-1 text-label text-muted-foreground">{active?.family === "hooks" ? "Hooks JSON" : "Command instructions"}
          <textarea aria-label="Native configuration contents" value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); if (target) nativeAuthoring.remember(target, document, event.target.value) }} spellCheck={false} className="min-h-72 resize-y rounded-md border border-border bg-surface p-3 font-mono text-ui leading-relaxed text-foreground" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Action disabled={busy || (!dirty && document.revision !== null)} onClick={() => void save()}>{busy ? "Working…" : "Save configuration"}</Action>
          <Action tone="outline" disabled={busy || !dirty} onClick={() => { setDraft(document.contents); if (target) nativeAuthoring.remember(target, document, document.contents) }}>Discard edits</Action>
          <Action tone="outline" disabled={busy || dirty} onClick={() => void open(document.id)}>Reload file</Action>
          <Action tone="outline" disabled={busy || dirty || document.revision === null} onClick={() => void remove()}>{active?.family === "hooks" ? "Remove hooks section" : "Remove command"}</Action>
        </div>
        {dirty ? <p className="text-label text-faint">Unsaved changes. Save or discard before changing configuration.</p> : null}
      </> : null}
      <details className="text-label text-faint"><summary className="cursor-pointer">Other agent integrations</summary><ul className="mt-2 space-y-2">{catalog.capabilities.filter((entry) => !entry.supported).map((entry) => <li key={`${entry.provider}:${entry.family}`}>{entry.label} · {entry.family}: {entry.detail}</li>)}</ul></details>
    </> : error ? null : <p className="text-ui text-faint">Reading native integrations…</p>}
    {error ? <p role="alert" className="whitespace-pre-wrap text-ui text-negative">{error}</p> : null}
    {notice ? <p role="status" className="text-ui text-muted-foreground">{notice}</p> : null}
  </div>
}
