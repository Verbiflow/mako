import { useLayoutEffect, useRef, type ReactNode } from "react"
import { newView, SceneContext, useExit, viewIs, type ExitOptions, type View } from "./exit-motion"

/* What leaves with motion, as components; the mechanism is `exit-motion.ts`. */

/**
 * One view of a place: what leaves inside it while it shows another (a page of the queue, a folder folded, another
 * conversation in the same pane) or while it goes itself is put away at once, as it always was.
 */
export function ExitScene({ scene, quiet = false, children }: { scene: string; quiet?: boolean; children: ReactNode }) {
  const view = useRef<View>(newView(scene, quiet))
  // Runs after this commit's removals: a removal made by the view changing, or the place going, finds it so.
  useLayoutEffect(() => {
    viewIs(view.current, scene, quiet)
  }, [scene, quiet])
  useLayoutEffect(() => {
    const held = view.current
    return () => {
      held.live = false
    }
  }, [])
  return <SceneContext value={view}>{children}</SceneContext>
}

/**
 * A block that leaves with motion (`useExit`) for what draws its own root: the child sits in a plain `div`, which is
 * what leaves. Rendered conditionally by its parent, as the child was.
 */
export function Exit({ id, className, children, ...options }: ExitOptions & { id: string; className?: string; children: ReactNode }) {
  const exit = useExit<HTMLDivElement>(id, options)
  return (
    <div ref={exit} className={className}>
      {children}
    </div>
  )
}
