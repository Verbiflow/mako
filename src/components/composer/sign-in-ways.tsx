import { useState } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { Action } from "@/components/ui/kit"

/** The ways back in that don't fit the line: the CLI's own login, another account, or trying now. */
export function SignInWays({ loginCommand, onResumeAnyway }: { loginCommand?: string; onResumeAnyway(): void }) {
  const [copied, setCopied] = useState(false)
  async function copyCommand() {
    if (!loginCommand) return
    await navigator.clipboard.writeText(loginCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="flex flex-col gap-2">
      {loginCommand ? (
        <p className="flex flex-wrap items-center gap-1">
          <span>Run</span>
          <code className="rounded bg-fill-hover px-1 py-0.5 font-mono text-foreground">{loginCommand}</code>
          <span>in a terminal, then come back here.</span>
          <Action size="xs" aria-label="Copy the login command" onClick={() => void copyCommand()}>
            {copied ? <CheckIcon className="text-positive" /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </Action>
        </p>
      ) : null}
      <span className="flex items-center gap-1">
        <Action size="xs" onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))}>
          Use another account
        </Action>
        <Action size="xs" title="Try now, without waiting to see a new sign-in" onClick={onResumeAnyway}>
          Resume anyway
        </Action>
      </span>
    </div>
  )
}
