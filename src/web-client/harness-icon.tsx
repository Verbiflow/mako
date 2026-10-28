import { DeclaredMark, Initials } from "@/components/ui/harness-mark"
import { harnessDescriptors } from "@/dev/harness-descriptors"

/**
 * A harness's mark from its definition, drawn as the desk draws it (`DeclaredMark`), without the desk's stores: the
 * list paints before anything of the renderer's live state is read.
 */
export function WebHarnessIcon({ harness, className }: { harness: string; className?: string }) {
  const mark = harnessDescriptors.find((descriptor) => descriptor.provider === harness)?.presentation?.mark
  return mark ? <DeclaredMark mark={mark} tinted className={className} /> : <Initials name={harness} className={className} />
}
