import { Notice } from "@/components/ui/notice"

interface BannerProps {
  text: string
}

export function Banner({ text }: BannerProps) {
  return <Notice tone="progress" title={text} className="mx-2 mt-2" />
}
