import { useEffect, useState, type CSSProperties } from "react"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react"

interface ToasterStyle extends CSSProperties {
  "--normal-bg": string
  "--normal-text": string
  "--normal-border": string
  "--border-radius": string
}

const TOASTER_STYLE: ToasterStyle = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--border-radius": "var(--radius-lg)",
}

const Toaster = ({ ...props }: ToasterProps) => {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("light") ? "light" : "dark"
  )
  useEffect(() => {
    const sync = () =>
      setTheme(
        document.documentElement.classList.contains("light") ? "light" : "dark"
      )
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    // The theme can be applied by an effect that runs before this one.
    sync()
    return () => observer.disconnect()
  }, [])

  return (
    <Sonner
      theme={theme}
      hotkey={[]}
      closeButton
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={TOASTER_STYLE}
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
