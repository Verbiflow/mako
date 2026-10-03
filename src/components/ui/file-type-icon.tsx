import {
  ActivityIcon, CodeXmlIcon, FileIcon, FileTextIcon, FilmIcon,
  ImageIcon, Music2Icon, PresentationIcon, SheetIcon,
  type LucideIcon,
} from "lucide-react"
import { filePreviewFormat, type FilePreviewFormat } from "../../../electron/contracts/file-preview"

const marks = {
  image: ImageIcon,
  video: FilmIcon,
  audio: Music2Icon,
  pdf: FileTextIcon,
  word: FileTextIcon,
  workbook: SheetIcon,
  presentation: PresentationIcon,
  markdown: FileTextIcon,
  html: CodeXmlIcon,
  table: SheetIcon,
  text: FileTextIcon,
  har: ActivityIcon,
  "cpu-profile": ActivityIcon,
  "heap-profile": ActivityIcon,
  "heap-snapshot": ActivityIcon,
  trace: ActivityIcon,
} satisfies Record<FilePreviewFormat, LucideIcon>

/** Every preview surface uses the shared format policy and the same quiet marks. */
export function FileTypeIcon({ path, mimeType, className }: {
  path: string
  mimeType?: string
  className?: string
}) {
  const format = filePreviewFormat(path, mimeType)
  const Icon = format ? marks[format] : FileIcon
  return <Icon aria-hidden className={className} />
}
