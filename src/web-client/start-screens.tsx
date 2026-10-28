import { MakoMark } from "@/components/ui/mako-mark"

/** What shows while the web app connects: the mark, still, on the shell. */
export function Starting() {
  return (
    <div className="flex h-dvh items-center justify-center bg-shell" aria-busy aria-label="Opening Mako">
      <MakoMark className="size-8 opacity-60" />
    </div>
  )
}

export function Unreachable({ message }: { message: string }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-shell px-8 text-center">
      <MakoMark className="size-8 opacity-60" />
      <p className="text-title font-medium text-foreground">Mako can't be reached</p>
      <p className="max-w-[320px] text-ui text-muted-foreground">{message}</p>
      <button type="button" className="web-button" onClick={() => location.reload()}>
        Try again
      </button>
    </div>
  )
}
