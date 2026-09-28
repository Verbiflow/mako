import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const twMerge = extendTailwindMerge({
  extend: {
    theme: { container: ["content", "dialog"] },
    classGroups: { "font-size": [{ text: ["label", "ui", "title", "prose", "welcome"] }] },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
