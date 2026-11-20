// mako-video for macOS: the same program as native/video-linux/mako-video.c, on ScreenCaptureKit and VideoToolbox.
//
// It captures a display or one window with ScreenCaptureKit, which sends a frame only when the picture changes, in
// the encoder's own pixel format, and encodes H.264 on the Mac's media engine. Or it takes pictures on its input (a
// JPEG, or raw RGB/RGBA as a recording draws them). Mako runs it where the desktop app doesn't do this itself: a Mac
// host joined without the app, and recordings.
//
//   mako-video display [<id>] [options]   a display (the main one without an id)
//   mako-video window <id> [options]      one window, by its CGWindowID
//   mako-video frames [options]           the pictures on its input
//   mako-video overlay <video> [options]  a video's frames, each under the transparent RGBA picture sent for its time
//                                         (a recording's cursor), at the pictures' size
//   options: --fps N (30)  --bitrate BPS (from the size)  --box WxH (none)  --keyint N (0: only when asked)
//            --quality Q (0–100, constant quality for recordings, instead of a bitrate)
//
// Its input and output are the Linux helper's: units out as length-prefixed ControlVideoPackets, commands in as a
// type byte and a big-endian length ('K' key frame, 'B' box, 'R' bitrate, 'F' picture). The end of its input ends
// it; a source that went away ends it with "ended: <why>" on stderr, and the last line on stderr is a JSON summary.
import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import VideoToolbox

// MARK: Options

enum Source { case display(CGDirectDisplayID?), window(CGWindowID), frames, overlay(URL) }

struct Options {
  var source = Source.frames
  var fps = 30
  var bitrate = 0
  var keyint = 0
  var quality = 0
  var box: (width: Int, height: Int)? = nil
}

func usage() -> Never {
  FileHandle.standardError.write("usage: mako-video display [<id>]|window <id>|frames|overlay <video> [--fps N] [--bitrate BPS] [--box WxH] [--keyint N] [--quality Q]\n".data(using: .utf8)!)
  exit(64)
}

var options = Options()
var arguments = Array(CommandLine.arguments.dropFirst())
guard let kind = arguments.first else { usage() }
arguments.removeFirst()
switch kind {
case "frames": options.source = .frames
case "display":
  if let first = arguments.first, !first.hasPrefix("--"), let id = UInt32(first) {
    options.source = .display(id)
    arguments.removeFirst()
  } else {
    options.source = .display(nil)
  }
case "overlay":
  guard let first = arguments.first, !first.hasPrefix("--") else { usage() }
  options.source = .overlay(URL(fileURLWithPath: first))
  arguments.removeFirst()
case "window":
  guard let first = arguments.first, let id = UInt32(first) else { usage() }
  options.source = .window(id)
  arguments.removeFirst()
default: usage()
}
while arguments.count >= 2 {
  let name = arguments.removeFirst(), value = arguments.removeFirst()
  switch name {
  case "--fps": options.fps = Int(value) ?? 0
  case "--bitrate": options.bitrate = Int(value) ?? 0
  case "--keyint": options.keyint = Int(value) ?? 0
  case "--quality": options.quality = Int(value) ?? 0
  case "--box":
    let parts = value.split(separator: "x").compactMap { Int($0) }
    guard parts.count == 2 else { usage() }
    options.box = (parts[0], parts[1])
  default: usage()
  }
}
if !arguments.isEmpty || options.fps < 1 || options.fps > 120 { usage() }

// MARK: Output

let output = DispatchQueue(label: "mako-video.output")
var stats = (frames: 0, keys: 0, bytes: 0, started: Date(), encodeMs: [Double]())

func be16(_ value: Int) -> [UInt8] { [UInt8(value >> 8 & 0xff), UInt8(value & 0xff)] }
func be32(_ value: Int) -> [UInt8] { [UInt8(value >> 24 & 0xff), UInt8(value >> 16 & 0xff), UInt8(value >> 8 & 0xff), UInt8(value & 0xff)] }

/** One ControlVideoPacket, with its length before it. */
func emit(key: Bool, width: Int, height: Int, description: Data, sequence: UInt32, capturedAt: Double, data: Data) {
  var header = [UInt8]()
  header += be32(24 + description.count + data.count)
  header += [1, key ? 1 : 0]
  header += be16(width) + be16(height) + be16(description.count) + be32(Int(sequence))
  let bits = capturedAt.bitPattern
  for shift in stride(from: 56, through: 0, by: -8) { header.append(UInt8(bits >> UInt64(shift) & 0xff)) }
  header += be32(data.count)
  var packet = Data(header)
  packet.append(description)
  packet.append(data)
  output.async {
    stats.bytes += packet.count
    FileHandle.standardOutput.write(packet)
  }
}

func finish(_ ended: String?) -> Never {
  output.sync {}
  let seconds = Date().timeIntervalSince(stats.started)
  let sorted = stats.encodeMs.sorted()
  let p50 = sorted.isEmpty ? 0 : sorted[sorted.count / 2], p95 = sorted.isEmpty ? 0 : sorted[sorted.count * 95 / 100]
  if let ended { FileHandle.standardError.write("ended: \(ended)\n".data(using: .utf8)!) }
  let summary = String(format: "{\"frames\":%d,\"keys\":%d,\"seconds\":%.1f,\"fps\":%.1f,\"kbps\":%.0f,\"encodeMs\":[%.2f,%.2f]}\n",
                       stats.frames, stats.keys, seconds, Double(stats.frames) / max(seconds, 0.001), Double(stats.bytes) * 8 / max(seconds, 0.001) / 1000, p50, p95)
  FileHandle.standardError.write(summary.data(using: .utf8)!)
  exit(0)
}

// MARK: The encoder

/** The bitrate a size and rate get unless told otherwise: what live video spends (`liveVideoBitrate`). */
func defaultBitrate(_ width: Int, _ height: Int) -> Int {
  Int(min(8e6, max(4e5, Double(width * height * options.fps) * 0.08)))
}

final class Encoder {
  private var session: VTCompressionSession?
  private(set) var width = 0, height = 0
  private var description = Data()
  var forceKey = true
  /** The last picture encoded, kept so a key frame asked for while nothing changes shows it. */
  private var last: (buffer: CVPixelBuffer, sequence: UInt32, capturedAt: Double)?

  private func open(_ width: Int, _ height: Int) -> Bool {
    close()
    var made: VTCompressionSession?
    // Live video takes the low-latency rate control, which keeps a bitrate; a recording's constant quality is the
    // ordinary encoder's (with low-latency rate control and no bitrate it dropped every frame after the first).
    let specification = (options.quality > 0
      ? [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true]
      : [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true]) as CFDictionary
    guard VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
                                     encoderSpecification: specification, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                     outputCallback: nil, refcon: nil, compressionSessionOut: &made) == noErr, let session = made else { return false }
    let set = { (key: CFString, value: CFTypeRef) in VTSessionSetProperty(session, key: key, value: value) }
    _ = set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
    _ = set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
    _ = set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
    _ = set(kVTCompressionPropertyKey_ExpectedFrameRate, options.fps as CFNumber)
    // Said in the stream, so every decoder turns it back into the same RGB: BT.709, as browsers assume for HD.
    _ = set(kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2)
    _ = set(kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2)
    _ = set(kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2)
    _ = set(kVTCompressionPropertyKey_MaxKeyFrameInterval, (options.keyint > 0 ? options.keyint : Int(Int32.max)) as CFNumber)
    if options.quality > 0 {
      _ = set(kVTCompressionPropertyKey_Quality, (Double(options.quality) / 100) as CFNumber)
    } else {
      let bitrate = options.bitrate > 0 ? options.bitrate : defaultBitrate(width, height)
      _ = set(kVTCompressionPropertyKey_AverageBitRate, bitrate as CFNumber)
      // A ceiling over each second, as the Linux helper's rate control keeps one: over a reliable link an overshoot
      // queues behind the viewer.
      _ = set(kVTCompressionPropertyKey_DataRateLimits, [bitrate / 8, 1] as CFArray)
    }
    VTCompressionSessionPrepareToEncodeFrames(session)
    self.session = session
    self.width = width
    self.height = height
    forceKey = true
    return true
  }

  /** Every frame given is written before the session goes. */
  func close() {
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(session)
    }
    session = nil
  }

  func setBitrate(_ bitrate: Int) {
    options.bitrate = bitrate
    guard let session, options.quality == 0 else { return }
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: [bitrate / 8, 1] as CFArray)
  }

  func encode(_ buffer: CVPixelBuffer, sequence: UInt32, capturedAt: Double) {
    let width = CVPixelBufferGetWidth(buffer) & ~1, height = CVPixelBufferGetHeight(buffer) & ~1
    if session == nil || width != self.width || height != self.height {
      guard open(width, height) else { finish("VideoToolbox couldn't encode a \(width)×\(height) picture") }
    }
    guard let session else { return }
    last = (buffer, sequence, capturedAt)
    let key = forceKey
    forceKey = false
    let properties = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let started = Date()
    let time = CMTime(value: Int64(Date().timeIntervalSince(stats.started) * 1_000_000), timescale: 1_000_000)
    let (encodedWidth, encodedHeight) = (self.width, self.height)
    VTCompressionSessionEncodeFrame(session, imageBuffer: buffer, presentationTimeStamp: time, duration: .invalid,
                                    frameProperties: properties, infoFlagsOut: nil) { [weak self] status, _, sample in
      guard let self, status == noErr, let sample, let block = CMSampleBufferGetDataBuffer(sample) else { return }
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
      let sync = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
      if sync, let format = CMSampleBufferGetFormatDescription(sample),
         let atoms = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any],
         let avcC = atoms["avcC"] as? Data {
        self.description = avcC
      }
      var data = Data(count: CMBlockBufferGetDataLength(block))
      data.withUnsafeMutableBytes { _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!) }
      stats.frames += 1
      if sync { stats.keys += 1 }
      if stats.encodeMs.count < 65536 { stats.encodeMs.append(Date().timeIntervalSince(started) * 1000) }
      emit(key: sync, width: encodedWidth, height: encodedHeight, description: sync ? self.description : Data(), sequence: sequence, capturedAt: capturedAt, data: data)
    }
  }

  /** The kept picture again, as a key frame. */
  func again() {
    forceKey = true
    if let last { encode(last.buffer, sequence: last.sequence, capturedAt: last.capturedAt) }
  }
}

let work = DispatchQueue(label: "mako-video.work")
let encoder = Encoder()

/** `width`×`height` scaled to fit the box, even. */
@Sendable func fit(_ width: Int, _ height: Int) -> (Int, Int) {
  var scale = 1.0
  if let box = options.box, box.width > 0, box.height > 0 {
    scale = min(1, Double(box.width) / Double(width), Double(box.height) / Double(height))
  }
  return (max(2, Int(Double(width) * scale) & ~1), max(2, Int(Double(height) * scale) & ~1))
}

// MARK: Pictures on the input

/** A picture drawn into a BGRA pixel buffer at the box's size; VideoToolbox converts it to YUV on the media engine. */
@Sendable func pixelBuffer(_ image: CGImage) -> CVPixelBuffer? {
  let (width, height) = fit(image.width, image.height)
  var buffer: CVPixelBuffer?
  let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
  guard CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attributes, &buffer) == kCVReturnSuccess, let buffer else { return nil }
  CVPixelBufferLockBaseAddress(buffer, [])
  defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
  guard let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
                                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
  context.interpolationQuality = .high
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return buffer
}

func picture(_ body: Data) {
  guard body.count >= 13 else { finish("A picture's header was cut short") }
  let bytes = [UInt8](body)
  let format = bytes[0]
  let sequence = UInt32(bytes[1]) << 24 | UInt32(bytes[2]) << 16 | UInt32(bytes[3]) << 8 | UInt32(bytes[4])
  var bits: UInt64 = 0
  for index in 5..<13 { bits = bits << 8 | UInt64(bytes[index]) }
  let capturedAt = Double(bitPattern: bits)
  var image: CGImage?
  if format == 0 {
    if let source = CGImageSourceCreateWithData(body.subdata(in: 13..<body.count) as CFData, nil) {
      image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
  } else if format == 1 || format == 2, bytes.count >= 17 {
    let width = Int(bytes[13]) << 8 | Int(bytes[14]), height = Int(bytes[15]) << 8 | Int(bytes[16])
    let channels = format == 1 ? 3 : 4
    let pixels = body.subdata(in: 17..<body.count)
    guard width > 0, height > 0, pixels.count == width * height * channels else { finish("A raw picture's size didn't match its bytes") }
    if let provider = CGDataProvider(data: pixels as CFData) {
      image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8 * channels, bytesPerRow: width * channels,
                      space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGBitmapInfo(rawValue: format == 1 ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.last.rawValue),
                      provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
  } else {
    finish("Unknown picture format \(format)")
  }
  guard let image else { return }
  if let overlay {
    guard let buffer = overlay.compose(image, at: capturedAt / 1000) else { return }
    encoder.encode(buffer, sequence: sequence, capturedAt: capturedAt)
    return
  }
  guard let buffer = pixelBuffer(image) else { return }
  encoder.encode(buffer, sequence: sequence, capturedAt: capturedAt)
}

// MARK: A video under pictures

/**
 * A video's frames read in order with AVFoundation, each the one shown at a picture's time (the last one held past
 * its end), letterboxed into the picture's size on a dark ground, with the picture drawn over it.
 */
final class Overlay {
  private let reader: AVAssetReader
  private let output: AVAssetReaderTrackOutput
  /** Decoded frames copied out of the reader's buffers, which it decodes the next frames into. */
  private var current: CGImage?
  private var next: (time: Double, image: CGImage?)?
  private var done = false

  init(_ url: URL) {
    let asset = AVURLAsset(url: url)
    let semaphore = DispatchSemaphore(value: 0)
    var found: AVAssetTrack?
    Task {
      found = try? await asset.loadTracks(withMediaType: .video).first
      semaphore.signal()
    }
    semaphore.wait()
    guard let track = found, let reader = try? AVAssetReader(asset: asset) else { finish("The video can't be read") }
    output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    guard reader.startReading() else { finish("The video can't be read: \(reader.error?.localizedDescription ?? "unknown")") }
    self.reader = reader
    advance()
  }

  private func advance() {
    guard !done, let sample = output.copyNextSampleBuffer() else {
      done = true
      next = nil
      return
    }
    var image: CGImage?
    if let buffer = sample.imageBuffer {
      var wrapped: CGImage?
      VTCreateCGImageFromCVPixelBuffer(buffer, options: nil, imageOut: &wrapped)
      if let wrapped, let space = wrapped.colorSpace,
         let copy = CGContext(data: nil, width: wrapped.width, height: wrapped.height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                              bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
        copy.draw(wrapped, in: CGRect(x: 0, y: 0, width: wrapped.width, height: wrapped.height))
        image = copy.makeImage()
      }
    }
    next = (sample.presentationTimeStamp.seconds, image)
  }

  func compose(_ picture: CGImage, at time: Double) -> CVPixelBuffer? {
    while let upcoming = next, upcoming.time <= time + 1e-6 {
      if let image = upcoming.image { current = image }
      advance()
    }

    let width = picture.width & ~1, height = picture.height & ~1
    var buffer: CVPixelBuffer?
    let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
    guard CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attributes, &buffer) == kCVReturnSuccess, let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    // Drawn in the video's own color space, so its pixels come out as they went in rather than converted for a screen.
    let frame = current
    let space = frame?.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    context.setFillColor(red: 0x17 / 255, green: 0x16 / 255, blue: 0x14 / 255, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .high
    if let frame {
      let scale = min(Double(width) / Double(frame.width), Double(height) / Double(frame.height))
      let drawn = CGSize(width: Double(frame.width) * scale, height: Double(frame.height) * scale)
      context.draw(frame, in: CGRect(x: (Double(width) - drawn.width) / 2, y: (Double(height) - drawn.height) / 2, width: drawn.width, height: drawn.height))
    }
    context.draw(picture, in: CGRect(x: 0, y: 0, width: width, height: height))
    return buffer
  }
}

let overlay: Overlay? = { if case .overlay(let url) = options.source { return Overlay(url) } else { return nil } }()

// MARK: ScreenCaptureKit

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
  var stream: SCStream?
  var configuration = SCStreamConfiguration()
  /** The source's size in pixels, which the box scales. */
  var size = (width: 0, height: 0)
  var sequence: UInt32 = 0

  func start() async {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      let filter: SCContentFilter
      switch options.source {
      case .window(let id):
        guard let window = content.windows.first(where: { $0.windowID == id }) else { finish("That window is gone") }
        filter = SCContentFilter(desktopIndependentWindow: window)
      case .display(let id):
        guard let display = content.displays.first(where: { id == nil || $0.displayID == id }) else { finish("That display is gone") }
        filter = SCContentFilter(display: display, excludingWindows: [])
      case .frames, .overlay: return
      }
      let scale = Double(filter.pointPixelScale)
      size = (Int(filter.contentRect.width * scale), Int(filter.contentRect.height * scale))
      configure()
      let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: work)
      try await stream.startCapture()
      self.stream = stream
    } catch {
      finish("Screen capture isn't allowed or failed: \(error.localizedDescription)")
    }
  }

  func configure() {
    let (width, height) = fit(size.width, size.height)
    configuration.width = width
    configuration.height = height
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
    // The encoder's own format: no conversion between the capture and the media engine.
    configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    configuration.queueDepth = 4
    configuration.showsCursor = false
    configuration.scalesToFit = true
  }

  func resize() {
    configure()
    stream?.updateConfiguration(configuration) { _ in }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sample.isValid, let buffer = sample.imageBuffer else { return }
    // ScreenCaptureKit marks a frame that repeats the last picture `idle`: nothing to encode.
    let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]]
    guard let attachments = info?.first, let raw = attachments[SCStreamFrameInfo.status.rawValue] as? Int,
          SCFrameStatus(rawValue: raw) == .complete else { return }
    // A window's capture repeats its picture as `complete` frames at the capture's rate, each with a dirty
    // rectangle, so the planes themselves say whether this one differs: compared whole, so a caret's blink counts.
    if !changed(buffer) { return }
    sequence += 1
    encoder.encode(buffer, sequence: sequence, capturedAt: Date().timeIntervalSince1970 * 1000)
  }

  /** The last picture's planes, to compare the next with. */
  private var previous = [Data]()

  private func changed(_ buffer: CVPixelBuffer) -> Bool {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    var planes = [Data]()
    for plane in 0..<max(1, CVPixelBufferGetPlaneCount(buffer)) {
      guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane) else { return true }
      planes.append(Data(bytes: base, count: CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane)))
    }
    defer { previous = planes }
    return planes != previous
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    finish("The capture ended: \(error.localizedDescription)")
  }
}

let capture = Capture()
switch options.source {
case .frames, .overlay: break
default:
  // ScreenCaptureKit needs this process's window server connection, which nothing else here would open.
  _ = CGMainDisplayID()
  Task { await capture.start() }
}

// MARK: Commands

/** Reads commands until the input ends. */
Thread.detachNewThread {
  var buffer = Data()
  let input = FileHandle.standardInput
  while true {
    let chunk = input.availableData
    if chunk.isEmpty { work.sync { encoder.close() }; finish(nil) }
    buffer.append(chunk)
    while buffer.count >= 5 {
      let head = [UInt8](buffer.prefix(5))
      let length = Int(head[1]) << 24 | Int(head[2]) << 16 | Int(head[3]) << 8 | Int(head[4])
      guard length <= 64 << 20 else { finish("A command was too long") }
      guard buffer.count >= 5 + length else { break }
      let body = buffer.subdata(in: buffer.startIndex + 5 ..< buffer.startIndex + 5 + length)
      buffer = buffer.subdata(in: buffer.startIndex + 5 + length ..< buffer.endIndex)
      work.sync {
        switch head[0] {
        case UInt8(ascii: "K"): encoder.again()
        case UInt8(ascii: "B") where length == 4:
          let bytes = [UInt8](body)
          let width = Int(bytes[0]) << 8 | Int(bytes[1]), height = Int(bytes[2]) << 8 | Int(bytes[3])
          options.box = width > 0 && height > 0 ? (width, height) : nil
          capture.resize()
        case UInt8(ascii: "R") where length == 4:
          let bytes = [UInt8](body)
          encoder.setBitrate(Int(bytes[0]) << 24 | Int(bytes[1]) << 16 | Int(bytes[2]) << 8 | Int(bytes[3]))
        case UInt8(ascii: "F"):
          picture(body)
        default:
          finish("Unknown command")
        }
      }
    }
  }
}

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM) { _ in finish(nil) }
dispatchMain()
