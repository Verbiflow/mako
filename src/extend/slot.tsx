import { Fragment, type ComponentType, type ReactNode } from "react"
import { useRegistry } from "@/extend/registry"
import {
  contributions,
  type Contribution,
  type SlotMap,
  type SlotName,
} from "@/extend/slots"

type SlotProps<K extends SlotName> = { name: K } & SlotMap[K]
type SlotInvocation = { [K in SlotName]: SlotProps<K> }[SlotName]
type ContributionEntry = [id: string, contribution: Contribution]
type RegisteredSlotContribution<K extends SlotName> = Contribution & {
  slot: K
  render: ComponentType<SlotMap[K]>
}
type RegisteredSlotEntry<K extends SlotName> = [
  id: string,
  contribution: RegisteredSlotContribution<K>,
]

function isForSlot<K extends SlotName>(
  entry: ContributionEntry,
  name: K
): entry is RegisteredSlotEntry<K> {
  return entry[1].slot === name
}

function assertSlotExhausted(slot: never): never {
  throw new Error(`Unknown slot: ${String(slot)}`)
}

function renderSlot<K extends SlotName>(
  entries: ContributionEntry[],
  name: K,
  props: SlotMap[K]
): ReactNode {
  const matches = entries
    .filter((entry) => isForSlot(entry, name))
    .sort((a, b) => a[1].order - b[1].order)

  if (matches.length === 0) return null

  return (
    <>
      {matches.map(([id, entry]) => {
        const Contribution: ComponentType<SlotMap[K]> = entry.render
        return (
          <Fragment key={id}>
            <Contribution {...props} />
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * Renders every contribution registered against a declared slot, in order.
 * Contributions are looked up through the registry hook, so one arriving late
 * — an extension loaded after boot — repaints exactly the seams it filled.
 */
export function Slot<K extends SlotName>(props: SlotProps<K>): ReactNode
export function Slot(props: SlotInvocation): ReactNode {
  const entries = useRegistry(contributions).entries()

  switch (props.name) {
    case "titlebar.leading":
    case "titlebar.trailing":
    case "rail.header":
    case "rail.footer":
      return renderSlot(entries, props.name, {})
    case "rail.session.trailing":
      return renderSlot(entries, props.name, {
        session: props.session,
        active: props.active,
      })
    case "transcript.overlay":
      return renderSlot(entries, props.name, {
        conversationId: props.conversationId,
      })
    case "transcript.header":
    case "transcript.empty":
    case "composer.above":
    case "titlebar.status":
      return renderSlot(entries, props.name, { meta: props.meta })
    case "transcript.turn.trailing":
      return renderSlot(entries, props.name, { message: props.message })
    case "composer.controls":
    case "composer.trailing":
      return renderSlot(entries, props.name, {
        meta: props.meta,
        disabled: props.disabled,
        attachFiles: props.attachFiles,
      })
    case "changes.file.trailing":
      return renderSlot(entries, props.name, { file: props.file })
  }

  return assertSlotExhausted(props)
}
