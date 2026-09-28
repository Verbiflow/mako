import { createContext, useContext, type ComponentProps, type ReactNode } from "react"
import { ContextMenu as ContextMenuPrimitive, DropdownMenu } from "radix-ui"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * One menu surface for the desk: a floating panel, rows that highlight
 * with a tint of the text colour, submenus that open on hover and keep
 * their row lit while open. Entrances rise 4px over 140ms; exits are
 * faster and do not travel. The same rows serve a right-click menu
 * (`ContextMenu`), so one list of items can open from a button and from
 * the thing itself.
 */
export function Menu(props: ComponentProps<typeof DropdownMenu.Root>) {
  return <DropdownMenu.Root {...props} />
}

/** Which Radix menu the rows below belong to; their primitives must match it. */
const Flavor = createContext<"dropdown" | "context">("dropdown")

export function ContextMenu(props: ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root {...props} />
}

export function ContextMenuTrigger(props: ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger {...props} />
}

export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <Flavor.Provider value="context">
        <ContextMenuPrimitive.Content
          collisionPadding={8}
          className={cn(panel, "origin-(--radix-context-menu-content-transform-origin)", className)}
          {...props}
        />
      </Flavor.Provider>
    </ContextMenuPrimitive.Portal>
  )
}

export function MenuTrigger(props: ComponentProps<typeof DropdownMenu.Trigger>) {
  return <DropdownMenu.Trigger {...props} />
}

export function MenuSub(props: ComponentProps<typeof DropdownMenu.Sub>) {
  return <DropdownMenu.Sub {...props} />
}

export function MenuRadioGroup(props: ComponentProps<typeof DropdownMenu.RadioGroup>) {
  return <DropdownMenu.RadioGroup {...props} />
}

const panel =
  "overlay-panel z-50 min-w-48 p-1 text-ui text-popover-foreground outline-none " +
  "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98 data-open:duration-140 " +
  "data-[side=top]:data-open:slide-in-from-bottom-1 data-[side=bottom]:data-open:slide-in-from-top-1 " +
  "data-[side=right]:data-open:slide-in-from-left-1 data-[side=left]:data-open:slide-in-from-right-1 " +
  "data-closed:animate-out data-closed:fade-out-0 data-closed:duration-100"

const row =
  "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 outline-none " +
  "transition-colors duration-100 data-[highlighted]:bg-fill-hover " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-45"

export function MenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(panel, "origin-(--radix-dropdown-menu-content-transform-origin)", className)}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

export function MenuSubContent({
  className,
  ...props
}: ComponentProps<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        sideOffset={6}
        alignOffset={-4}
        collisionPadding={8}
        className={cn(panel, className)}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

export function MenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenu.Item>) {
  const Item = useContext(Flavor) === "context" ? ContextMenuPrimitive.Item : DropdownMenu.Item
  return <Item className={cn(row, className)} {...props} />
}

export function MenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.SubTrigger>) {
  return (
    <DropdownMenu.SubTrigger
      className={cn(row, "data-[state=open]:bg-fill-hover", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="size-3.5 shrink-0 text-faint" />
    </DropdownMenu.SubTrigger>
  )
}

export function MenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem className={cn(row, className)} {...props}>
      {children}
      <DropdownMenu.ItemIndicator className="ml-auto">
        <CheckIcon className="size-3.5" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  )
}

export function MenuSeparator({ className }: { className?: string }) {
  const Separator = useContext(Flavor) === "context" ? ContextMenuPrimitive.Separator : DropdownMenu.Separator
  return <Separator className={cn("-mx-1 my-1 h-px bg-hairline", className)} />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  const Label = useContext(Flavor) === "context" ? ContextMenuPrimitive.Label : DropdownMenu.Label
  return (
    <Label className="truncate px-2 pt-1.5 pb-1 text-label font-medium text-faint">
      {children}
    </Label>
  )
}
