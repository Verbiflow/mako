import { useRef, useState, type KeyboardEvent } from "react"
import { toast } from "sonner"
import { ChevronDownIcon } from "lucide-react"
import { ROLE_RULES_CHARS, roleRulesPreview, type FinPolicy, type FinTarget } from "@mako/host/contracts/fin-tuning"
import { FIELD } from "@/components/ui/kit"
import { ROLE_FIELDS, roughTokens } from "@/lib/role-rules"
import { cn } from "@/lib/utils"
import { saveRoleRules, useFinDefaults } from "@/state/fin-defaults"

/** The person's standing rules for every Fin and every Apex, in their own words, each with what it adds to an agent's note. */
export function RoleRules({ target }: { target: (target: FinTarget) => string }) {
  const policy = useFinDefaults((state) => state.reading?.policy)
  if (!policy) return null
  return (
    <section className="flex flex-col gap-6" aria-label="Your rules for every Fin and Apex">
      {ROLE_FIELDS.map((field) => (
        <RoleField key={field.role} {...field} policy={policy} target={target} />
      ))}
    </section>
  )
}

function RoleField({ role, label, description, placeholder, reads, policy, target }: (typeof ROLE_FIELDS)[number] & {
  policy: FinPolicy
  target: (target: FinTarget) => string
}) {
  const saved = policy[role] ?? ""
  const [text, setText] = useState(saved)
  const [preview, setPreview] = useState(false)
  // Escape's blur runs before the reverted text renders, so the blur it causes must not save what it reverted.
  const cancelled = useRef(false)
  const id = `role-rules-${role}`
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const next = text.trim()
    if (next === saved) return
    void saveRoleRules(role, next).catch((error: Error) => {
      setText(saved)
      toast.error(error.message || "Your rules couldn't be saved. Try again.")
    })
  }
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      cancelled.current = true
      setText(saved)
      event.currentTarget.blur()
    }
  }
  const shown = roleRulesPreview(role, { ...policy, [role]: text.trim() || undefined }, target).join("\n")
  return (
    <div className="flex flex-col gap-3" data-role-rules={role}>
      <div>
        <label htmlFor={id} className="text-ui font-medium">{label}</label>
        <p className="mt-0.5 text-label text-muted-foreground">{description}</p>
      </div>
      <textarea
        id={id}
        value={text}
        rows={2}
        maxLength={ROLE_RULES_CHARS}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={keys}
        className={cn(FIELD, "h-auto min-h-14 resize-none py-2.5 leading-snug [field-sizing:content]")}
      />
      {shown ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            aria-expanded={preview}
            aria-controls={`${id}-preview`}
            onClick={() => setPreview((open) => !open)}
            className="pressable ml-auto flex h-7 items-center gap-1 px-2 text-label text-faint transition-colors duration-150 hover:text-muted-foreground"
          >
            {reads}
            <ChevronDownIcon className={cn("size-3 transition-transform duration-150", preview && "rotate-180")} />
          </button>
          {preview ? (
            <div id={`${id}-preview`} data-role-preview={role} className="flex flex-col gap-1.5 bg-shell/55 px-3 py-2.5">
              <span className="text-label text-faint tabular">{roughTokens(shown)}</span>
              <pre className="font-mono text-label leading-relaxed whitespace-pre-wrap text-muted-foreground">{shown}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
