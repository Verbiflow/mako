import { toast } from "sonner"
import { ListCard, SettingRow, Toggle } from "@/components/ui/kit"
import { chooseMoveOnLimit, useFinDefaults } from "@/state/fin-defaults"

const TITLE = "When an account runs out, continue on the next one"

/**
 * Settings › Fins: whether a Fin whose harness's account reaches its limit goes on at the next step of its order
 * (`contracts/fin-fallback.ts`): the person's next account of that harness, a connection serving its model, then
 * their next harness. Off until chosen; a Fin otherwise waits in place for its limit to reset.
 */
export function FinMoveOnLimit() {
  const reading = useFinDefaults((state) => state.reading)
  const on = reading?.moveOnLimit ?? false
  return (
    <section data-fin-move-on-limit className="flex flex-col gap-3">
      <ListCard>
        <SettingRow
          title={TITLE}
          description="A Fin at its account's limit goes on with your next account of that harness, then a connection serving its model, then your next harness, never above its access. Its row says where it went and why."
        >
          <Toggle
            label={TITLE}
            on={on}
            disabled={!reading}
            onChange={() => void chooseMoveOnLimit(!on).catch((error: Error) => toast.error(error.message || "That choice couldn't be saved. Try again."))}
          />
        </SettingRow>
      </ListCard>
    </section>
  )
}
