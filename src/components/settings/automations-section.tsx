import { useEffect } from "react"
import { Action, Toggle } from "@/components/ui/kit"
import { formatRelative } from "@/lib/format"
import {
  automationTriggerAvailable,
  type AutomationTrigger,
} from "@/lib/types"
import { automations, useAutomations } from "@/state/automations"

/**
 * Saved prompts, and what makes them run.
 *
 * Every one arrives switched off. The definitions come from a file in the
 * project — committable, shareable — but whether one is allowed to run an
 * agent on this machine is a decision made here, and cloning a repository must
 * never make it for you.
 */
export function AutomationsSection() {
  const list = useAutomations((state) => state.list)
  const recent = useAutomations((state) => state.recent)

  useEffect(() => {
    void automations.load()
  }, [])

  return (
    <div className="flex flex-col gap-1">
      <p className="pb-2 text-ui leading-relaxed text-muted-foreground">
        Prompts that can run on their own, defined in{" "}
        <code className="text-faint">.mako/automations.json</code>. Each one
        starts switched off — a file from a checkout does not get to run an
        agent because you opened the folder. A run opens a tab in the
        background; it never takes the window.
      </p>

      {list.length === 0 ? (
        <p className="bg-raised px-3 py-4 text-center text-ui text-faint">
          This project has none. Add <code>.mako/automations.json</code> with a
          name, a prompt, and a trigger of <code>manual</code>,{" "}
          <code>files</code>, or <code>commit</code>.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {list.map((entry) => (
            <div
              key={entry.id}
              className="bg-raised px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <Toggle
                  label={entry.name}
                  on={entry.enabled}
                  disabled={!automationTriggerAvailable(entry.trigger)}
                  onChange={() =>
                    void automations.setEnabled(entry.id, !entry.enabled)
                  }
                />
                <span className="min-w-0 flex-1 truncate text-ui font-medium">
                  {entry.name}
                </span>
                <Action tone="ghost" onClick={() => automations.run(entry.id)}>
                  Run now
                </Action>
              </div>
              <p className="mt-1.5 line-clamp-2 pl-[42px] text-ui leading-relaxed text-muted-foreground">
                {entry.prompt}
              </p>
              <p className="mt-1 pl-[42px] text-label text-faint">
                {triggerDescription(entry.trigger)}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Action tone="outline" onClick={() => void automations.reload()}>
          Reload from disk
        </Action>
        {recent.length > 0 ? (
          <span className="text-label text-faint">
            last run: {recent[0]?.name} · {recent[0]?.status} ·{" "}
            {formatRelative(new Date(recent[0]?.at ?? 0).toISOString())}
          </span>
        ) : null}
      </div>

      <p className="mt-3 text-ui leading-relaxed text-faint">
        Slack, Gmail, Calendar, and webhook definitions are recognized but stay
        off until their provider-owned event receiver is connected. File
        triggers wait a minute between runs, so an agent editing watched files
        cannot loop.
      </p>
    </div>
  )
}

function triggerDescription(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "manual":
      return "only when you ask"
    case "files":
      return `when ${trigger.paths.join(", ") || "nothing"} changes`
    case "commit":
      return "when you commit"
    case "slack":
      return `Slack ${trigger.event.replaceAll("_", " ")} · receiver not connected`
    case "gmail":
      return "Gmail message received · receiver not connected"
    case "google_calendar":
      return `Calendar ${trigger.event.replaceAll("_", " ")} · receiver not connected`
    case "webhook":
      return `POST ${trigger.path || "webhook"} · receiver not connected`
  }
}
