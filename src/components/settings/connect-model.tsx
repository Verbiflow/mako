import { useCallback, useEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Action, IconAction } from "@/components/ui/kit"
import { ProviderIcon } from "@/components/ui/provider-icon"
import { utilityModels } from "@/state/model-runtime"
import type {
  UtilityCatalog,
  UtilityConnection,
  UtilityProviderInfo,
} from "@/lib/types"
import { SearchSelect } from "@/components/ui/search-select"
import { formatContextWindow } from "@/lib/format"
import {
  KeyRoundIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"

const inputClass =
  "h-9 w-full rounded-md bg-raised px-2.5 text-ui text-foreground ring-1 ring-hairline placeholder:text-faint focus:outline-none focus-visible:ring-border"

export function ConnectModel({
  provider,
  connection,
  onConnected,
  onClose,
}: {
  provider: UtilityProviderInfo
  connection?: UtilityConnection
  onConnected: (connection: UtilityConnection) => void
  onClose: () => void
}) {
  const key = useRef<HTMLInputElement>(null)
  const [model, setModel] = useState(connection?.model ?? "")
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "")
  const [contextTokens, setContextTokens] = useState(
    connection?.contextTokens ?? 128_000
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const custom = provider.id === "openai-compatible"
  const [catalog, setCatalog] = useState<UtilityCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<{
    message: string
    source: UtilityCatalog["source"]
  } | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const requestVersion = useRef(0)
  const pendingSource = useRef<UtilityCatalog["source"] | null>(null)

  const loadModels = useCallback(
    async (source: UtilityCatalog["source"], refresh = false) => {
      const version = ++requestVersion.current
      pendingSource.current = source
      setLoadingModels(true)
      setCatalogError(null)
      try {
        const next = await utilityModels.catalog(
          source === "catalog"
            ? { source, provider: provider.id, refresh }
            : {
                source,
                provider: provider.id,
                baseUrl: custom ? baseUrl : undefined,
                apiKey: key.current?.value || undefined,
              }
        )
        if (version === requestVersion.current) setCatalog(next)
      } catch (caught) {
        if (version === requestVersion.current)
          setCatalogError({
            source,
            message:
              caught instanceof Error
                ? caught.message
                : "Model discovery failed. Retry or enter a model ID.",
          })
      } finally {
        if (version === requestVersion.current) {
          pendingSource.current = null
          setLoadingModels(false)
        }
      }
    },
    [provider.id, custom, baseUrl]
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active && !custom) void loadModels("catalog")
    })
    return () => {
      active = false
      requestVersion.current += 1
    }
  }, [custom, loadModels])

  function invalidateAccountModels() {
    if (pendingSource.current === "provider") {
      requestVersion.current += 1
      pendingSource.current = null
      setLoadingModels(false)
    }
    setCatalog((current) => (current?.source === "provider" ? null : current))
    setCatalogError(null)
    setError(null)
  }

  async function connect(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const saved = await utilityModels.connect({
        provider: provider.id,
        model,
        baseUrl: custom ? baseUrl : undefined,
        contextTokens,
        apiKey: key.current?.value || undefined,
      })
      if (key.current) key.current.value = ""
      onConnected(saved)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not connect. Check the model details and retry."
      )
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className="max-h-[90vh] max-w-lg overflow-y-auto p-6"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          key.current?.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <header className="mb-6 flex items-center gap-3">
          <ProviderIcon
            provider={provider.id}
            tinted={false}
            className="size-6"
          />
          <div className="flex-1">
            <DialogTitle>
              {connection
                ? `Edit ${provider.name} connection`
                : `Connect ${provider.name}`}
            </DialogTitle>
            <p className="mt-1 text-label text-faint">
              For commit messages and pull request descriptions. Your agent accounts stay unchanged.
            </p>
          </div>
          <IconAction
            label="Close connection"
            disabled={busy}
            onClick={onClose}
          >
            <XIcon />
          </IconAction>
        </header>
        <form
          onSubmit={(event) => void connect(event)}
          className="flex flex-col gap-5"
        >
          <fieldset
            disabled={busy}
            className="flex min-w-0 flex-col gap-4 disabled:opacity-60"
          >
            <label className="flex flex-col gap-2 text-ui font-medium">
              <span className="flex items-center gap-2">
                <KeyRoundIcon className="size-3.5 text-faint" />
                API key{custom ? " (optional for local models)" : ""}
              </span>
              <input
                ref={key}
                type="password"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                maxLength={16_384}
                placeholder={
                  connection
                    ? "Leave blank to keep the saved key"
                    : "Paste your API key"
                }
                aria-describedby="model-key-note"
                onChange={invalidateAccountModels}
                className={inputClass}
              />
              <span
                id="model-key-note"
                className="text-label leading-relaxed font-normal text-faint"
              >
                Encrypted on this device using the system key store. Never saved
                in your project or sent back to the interface.
              </span>
            </label>
            {custom ? (
              <label className="flex flex-col gap-2 text-ui font-medium">
                Base URL
                <input
                  type="url"
                  required
                  value={baseUrl}
                  onChange={(event) => {
                    invalidateAccountModels()
                    setBaseUrl(event.target.value)
                  }}
                  placeholder="https://your-endpoint/v1"
                  spellCheck={false}
                  autoComplete="off"
                  className={inputClass}
                />
              </label>
            ) : null}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ui font-medium">Model</span>
                <div className="flex items-center gap-1">
                  {catalog?.source !== "provider" ? (
                    <Action
                      size="xs"
                      disabled={loadingModels || busy}
                      onClick={() => void loadModels("provider")}
                    >
                      {custom ? "Fetch models" : "Fetch with key"}
                    </Action>
                  ) : null}
                  <IconAction
                    label="Refresh model catalog"
                    size="xs"
                    disabled={loadingModels || busy}
                    onClick={() =>
                      void loadModels(
                        catalog?.source ?? (custom ? "provider" : "catalog"),
                        true
                      )
                    }
                  >
                    <RefreshCwIcon />
                  </IconAction>
                </div>
              </div>
              <SearchSelect
                label="Choose model"
                value={model}
                disabled={busy}
                className="h-9 w-full px-2.5"
                placeholder={
                  loadingModels ? "Loading models..." : "Choose a model"
                }
                searchPlaceholder="Search models or enter an ID"
                allowCustom
                customDetail="Use this custom model ID; checked when connecting"
                emptyMessage={
                  loadingModels
                    ? "Loading the catalog. You can also enter a model ID."
                    : "No models loaded. Enter a model ID or fetch the catalog."
                }
                options={(catalog?.models ?? []).map((entry) => ({
                  value: entry.id,
                  label: entry.name,
                  detail: `${entry.id}${entry.contextTokens ? ` · ${formatContextWindow(entry.contextTokens)} context tokens` : ""}`,
                  keywords: entry.id,
                }))}
                onChange={(next) => {
                  setModel(next)
                  setError(null)
                  const metadata = catalog?.models.find(
                    (entry) => entry.id === next
                  )
                  setContextTokens(
                    Math.min(
                      2_000_000,
                      Math.max(8_192, metadata?.contextTokens ?? 128_000)
                    )
                  )
                }}
              />
              <p
                role="status"
                className="text-label leading-relaxed text-faint"
              >
                {loadingModels
                  ? "Fetching model names and limits. No generation request is sent."
                  : catalog
                    ? `${catalog.models.length} models · ${catalog.source === "catalog" ? "models.dev catalog; account access not verified" : "returned by your provider; generation checked when connecting"}`
                    : custom
                      ? "Fetch from your endpoint, or type a custom model ID in the picker."
                      : "Browse the public catalog, or fetch available models with your key."}
              </p>
              {catalog?.notice ? (
                <p className="text-label text-caution">{catalog.notice}</p>
              ) : null}
              {catalogError ? (
                <div
                  role="alert"
                  className="text-label leading-relaxed text-negative"
                >
                  <p>{catalogError.message}</p>
                  <Action
                    size="xs"
                    onClick={() => void loadModels(catalogError.source, true)}
                  >
                    Retry discovery
                  </Action>
                </div>
              ) : null}
            </div>
            <details className="text-ui">
              <summary className="pressable cursor-pointer text-muted-foreground">
                Context limit
              </summary>
              <label className="mt-3 flex flex-col gap-2 text-label text-faint">
                Model context in tokens
                <input
                  type="number"
                  min={8_192}
                  max={2_000_000}
                  required
                  value={contextTokens}
                  onChange={(event) =>
                    setContextTokens(event.target.valueAsNumber)
                  }
                  className={inputClass}
                />
                The complete diff is sent in one call when it fits. Only context
                overflow triggers parallel summaries of every part.
              </label>
            </details>
          </fieldset>
          {error ? (
            <p role="alert" className="text-ui leading-relaxed text-negative">
              {error}
            </p>
          ) : null}
          <footer className="flex flex-col gap-3 border-t border-hairline pt-4">
            <p className="text-label leading-relaxed text-faint">
              Connecting sends a small test request. Your provider may charge
              for it. No repository content is sent during this test.
            </p>
            <div className="flex justify-end gap-2">
              <Action onClick={onClose} disabled={busy}>
                Cancel
              </Action>
              <Action
                type="submit"
                tone="solid"
                disabled={busy || !model.trim() || (custom && !baseUrl.trim())}
              >
                {busy ? (
                  <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                ) : null}
                {busy
                  ? "Testing connection..."
                  : connection
                    ? "Test and save"
                    : "Test and connect"}
              </Action>
            </div>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  )
}
