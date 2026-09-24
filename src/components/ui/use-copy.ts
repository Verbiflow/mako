import { useEffect, useRef, useState } from "react"
import { actions } from "@/state/session"
import type { Attachment } from "@/lib/attachments"
import { toast } from "sonner"

export function useCopy(text: string, attachments?: readonly Attachment[], resolveText?: () => Promise<string>) {
  const [result, setResult] = useState({ text, copied: false })
  if (result.text !== text) setResult({ text, copied: false })
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(
    () => () => {
      generation.current++
      clearTimeout(timer.current)
    },
    [text]
  )
  const copy = async () => {
    const current = ++generation.current
    clearTimeout(timer.current)
    setResult({ text, copied: false })
    let complete = text
    try { if (resolveText) complete = await resolveText() }
    catch (error) {
      toast.error("Could not copy the complete answer", { description: error instanceof Error ? error.message : String(error) })
      return
    }
    if (current !== generation.current) return
    const success = await actions.copy(complete, { notify: false, attachments })
    if (current !== generation.current || !success) return
    setResult({ text, copied: true })
    timer.current = setTimeout(() => setResult({ text, copied: false }), 1400)
  }
  return { copied: result.text === text && result.copied, copy }
}
