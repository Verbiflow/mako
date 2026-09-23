import sharp from "sharp"
import { imageSize } from "image-size"
import {
  ControlFault,
  type NativeScreenshotOptions,
} from "@mako/control/control"

export interface NativeCaptureGeometry {
  imageWidth: number
  imageHeight: number
  sourceWidth: number
  sourceHeight: number
}

/** Preserve the driver's coordinate frame while applying explicit output options. */
export async function nativeCapture(
  image: { data: string; mimeType: "image/png" | "image/jpeg" },
  options: NativeScreenshotOptions
) {
  const source = Buffer.from(image.data, "base64")
  const size = imageSize(source)
  const format =
    options.format ?? (image.mimeType === "image/png" ? "png" : "jpeg")
  const resize =
    options.maxSide !== undefined &&
    Math.max(size.width, size.height) > options.maxSide
  const changed =
    resize ||
    image.mimeType !== `image/${format}` ||
    (format === "jpeg" && options.quality !== undefined)
  let bytes = source
  if (changed) {
    let pipeline = sharp(source)
    if (resize)
      pipeline = pipeline.resize({
        width: options.maxSide,
        height: options.maxSide,
        fit: "inside",
        withoutEnlargement: true,
      })
    bytes = await (
      format === "png"
        ? pipeline.png()
        : pipeline.jpeg({ quality: options.quality ?? 85 })
    ).toBuffer()
  }
  const output = changed ? imageSize(bytes) : size
  const geometry: NativeCaptureGeometry = {
    imageWidth: output.width,
    imageHeight: output.height,
    sourceWidth: size.width,
    sourceHeight: size.height,
  }
  return {
    data: changed ? bytes.toString("base64") : image.data,
    mimeType:
      format === "png" ? ("image/png" as const) : ("image/jpeg" as const),
    coordinates: {
      ...geometry,
      units: "image pixels",
      instruction:
        "Click using this image's pixel coordinates and view token. Mako maps them to the driver's original window capture; do not rescale them yourself.",
    },
    geometry,
    changed,
  }
}

export function nativeCapturePoint(
  geometry: NativeCaptureGeometry,
  point: { x: number; y: number }
) {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= geometry.imageWidth ||
    point.y >= geometry.imageHeight
  )
    throw new ControlFault(
      "invalid-coordinates",
      "Coordinates must be inside this native screenshot. Nothing was dispatched.",
      "not-dispatched"
    )
  return {
    x: (point.x * geometry.sourceWidth) / geometry.imageWidth,
    y: (point.y * geometry.sourceHeight) / geometry.imageHeight,
  }
}
