import { useCallback, useEffect, useState } from "react"
import { Action, Keys } from "@/components/ui/kit"
import { ProviderIcon } from "@/components/ui/provider-icon"
import { ConnectCommitModel } from "./connect-commit-model"
import { UtilityModelPicker } from "./utility-model-picker"
import { formatChord } from "@/extend/commands"
import { setPref, usePrefs } from "@/state/prefs"
import { git } from "@/state/git"
import { utilityModels } from "@/state/model-runtime"
import { refreshCommitModel } from "@/state/commit-model"
import type {
  UtilityModelSettings,
  UtilityProvider,
  UtilityProviderInfo,
} from "@/lib/types"
import { CheckIcon, PlusIcon, RotateCcwIcon } from "lucide-react"

export function CommitPromptSection() {
  const stored = usePrefs((prefs) => prefs.commitPrompt)
  const draftKeys = usePrefs(
    (prefs) => prefs.keybindings["workspace.generate-commit"] ?? "mod+shift+g"
  )
  const [fallback, setFallback] = useState("")
  const [settings, setSettings] = useState<UtilityModelSettings | null>(null)
  const [editing, setEditing] = useState<UtilityProviderInfo | null>(null)
  const [disconnecting, setDisconnecting] = useState<UtilityProvider | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? stored ?? fallback
  const customized = Boolean(stored && stored !== fallback)
  const commit = settings?.work?.commit
  const draftingModel = commit?.resolved?.id

  const refresh = useCallback(async () => {
    try {
      const [next, prompt] = await Promise.all([
        utilityModels.settings(),
        git.defaultPrompt(),
      ])
      setSettings(next)
      setFallback(prompt)
      setError(null)
      // The commit box reads the same choice; a change made here reaches
      // its toolbar without waiting for a window focus.
      void refreshCommitModel()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Model connections could not be loaded."
      )
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => void refresh())
    const focus = () => void refresh()
    window.addEventListener("focus", focus)
    return () => window.removeEventListener("focus", focus)
  }, [refresh])

  async function disconnect(provider: UtilityProvider) {
    try {
      await utilityModels.disconnect(provider)
      setDisconnecting(null)
      await refresh()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The connection could not be removed. Try again."
      )
    }
  }

  async function choose(choice: string) {
    try {
      await utilityModels.choose("commit", choice)
      await refresh()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The choice could not be saved. Try again."
      )
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-ui leading-relaxed text-muted-foreground">
        Draft from your changes with a light model from an agent app you're
        signed in to, on your own subscription, or with a model you connect
        here. No conversation is started or read.
      </p>
      {error ? (
        <div
          role="alert"
          className="flex items-center gap-3 text-ui text-negative"
        >
          <span className="flex-1">{error}</span>
          <Action onClick={() => void refresh()}>Retry</Action>
        </div>
      ) : null}
      {!settings && !error ? (
        <p role="status" className="text-ui text-faint">
          Loading model connections...
        </p>
      ) : null}
      {settings ? (
        <>
          <section
            className="flex flex-col gap-3"
            aria-label="Commit drafting model"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-ui font-medium">Drafting model</span>
              <UtilityModelPicker
                task="commit"
                state={commit}
                label="Commit drafting model"
                onChoose={(next) => void choose(next)}
              />
            </div>
            {commit && !commit.resolved ? (
              <p role="alert" className="text-label leading-relaxed text-caution">
                {commit.reason}
              </p>
            ) : null}
            <p className="text-label leading-relaxed text-faint">
              Generating sends the complete diff to the model's provider. Only
              context overflow uses parallel summaries. Sensitive-file
              exclusions are reported with the draft.
            </p>
          </section>
          <section
            aria-label="Model connections"
            className="flex flex-col gap-2"
          >
            <h3 className="text-ui font-medium">Model connections</h3>
            {!settings.secureStorage ? (
              <p role="alert" className="text-label text-caution">
                Secure key storage is unavailable. Unlock your system keychain
                to connect a model.
              </p>
            ) : null}
            <div className="divide-y divide-hairline rounded-lg border border-hairline px-3">
              {settings.providers.map((provider) => {
                const connection = settings.connections.find(
                  (entry) => entry.provider === provider.id
                )
                const selected =
                  connection &&
                  draftingModel === `${connection.provider}/${connection.model}`
                const issue = settings.issues.find(
                  (entry) => entry.provider === provider.id
                )
                return (
                  <div key={provider.id} className="flex flex-col gap-2 py-3">
                    <div className="flex items-center gap-3">
                      <ProviderIcon
                        provider={provider.id}
                        tinted={false}
                        className="size-5"
                      />
                      <div className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-ui font-medium">
                          {provider.name}
                          {selected ? (
                            <span className="flex items-center gap-1 text-label font-normal text-faint">
                              <CheckIcon className="size-3" />
                              Used for commits
                            </span>
                          ) : null}
                        </span>
                        <p className="mt-0.5 truncate text-label text-faint">
                          {connection?.model ?? provider.description}
                        </p>
                      </div>
                      <Action
                        tone={connection ? "ghost" : "outline"}
                        disabled={!settings.secureStorage}
                        onClick={() => setEditing(provider)}
                        aria-label={`${connection ? "Edit" : "Connect"} ${provider.name}`}
                      >
                        {!connection ? <PlusIcon /> : null}
                        {connection ? "Edit" : "Connect"}
                      </Action>
                      {connection ? (
                        <Action
                          size="xs"
                          onClick={() => setDisconnecting(provider.id)}
                          aria-label={`Disconnect ${provider.name}`}
                        >
                          Disconnect
                        </Action>
                      ) : null}
                    </div>
                    {issue ? (
                      <p className="pl-8 text-label text-caution">
                        {issue.message}
                      </p>
                    ) : null}
                    {disconnecting === provider.id ? (
                      <div className="flex flex-wrap items-center gap-2 pl-8 text-label text-muted-foreground">
                        <span className="flex-1">
                          Remove this device's saved connection?
                        </span>
                        <Action
                          size="xs"
                          onClick={() => setDisconnecting(null)}
                        >
                          Keep
                        </Action>
                        <Action
                          size="xs"
                          tone="danger"
                          onClick={() => void disconnect(provider.id)}
                        >
                          Remove connection
                        </Action>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        </>
      ) : null}
      <details className="border-t border-hairline pt-4">
        <summary className="pressable cursor-pointer text-ui font-medium">
          Commit instructions{" "}
          <span className="ml-2 text-label font-normal text-faint">
            {customized ? "Customized" : "Default"}
          </span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <textarea
            aria-label="Commit instructions"
            value={value}
            spellCheck={false}
            rows={8}
            maxLength={12_000}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (draft !== null)
                setPref("commitPrompt", draft.trim() ? draft : undefined)
              setDraft(null)
            }}
            className="w-full resize-y rounded-lg bg-raised px-2.5 py-2 font-mono text-ui leading-relaxed ring-1 ring-hairline focus:outline-none focus-visible:ring-border"
          />
          <div className="flex items-center gap-2">
            <Action
              tone="ghost"
              size="xs"
              disabled={!customized}
              onClick={() => {
                setDraft(null)
                setPref("commitPrompt", undefined)
              }}
            >
              <RotateCcwIcon />
              Restore default
            </Action>
            <span className="ml-auto flex items-center gap-1 text-label text-faint">
              <Keys keys={formatChord(draftKeys)} /> drafts
            </span>
          </div>
        </div>
      </details>
      {editing ? (
        <ConnectCommitModel
          key={editing.id}
          provider={editing}
          connection={settings?.connections.find(
            (entry) => entry.provider === editing.id
          )}
          onClose={() => setEditing(null)}
          onConnected={(connection) => {
            setEditing(null)
            void choose(`${connection.provider}/${connection.model}`)
          }}
        />
      ) : null}
    </div>
  )
}
