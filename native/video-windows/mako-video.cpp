// mako-video for Windows: the same program as native/video-linux/mako-video.c, on Windows Graphics Capture and Media
// Foundation.
//
// It captures a display or one window with Windows Graphics Capture, which sends a frame only when the picture
// changes, or takes pictures on its input (a JPEG, decoded by WIC, or raw RGB/RGBA as a recording draws them). It
// scales them to the viewers' box, converts them to NV12 (BT.601) and encodes H.264 with Media Foundation: the GPU's
// hardware encoder where there is one, else Windows' own software encoder (CLSID_MSH264EncoderMFT). Nothing GPL, no
// FFmpeg; it links only what Windows ships. With nothing changing it waits: no frame, no CPU.
//
//   mako-video display [<n>] [options]    a display (the primary one without a number; else the nth, from 0)
//   mako-video window <hwnd> [options]    one window, by its HWND in decimal (Electron's "window:<hwnd>:0")
//   mako-video frames [options]           the pictures on its input
//   options: --fps N (30)  --bitrate BPS (from the size)  --box WxH (none)  --keyint N (0: only when asked)
//            --quality Q (0–100: constant quality for recordings, instead of a bitrate)
//            --encoder auto|hardware|software (auto; also MAKO_VIDEO_ENCODER)
//            --content and --threads are taken and ignored, as the Linux helper's options
//
// Its input and output are the Linux helper's: units out as length-prefixed ControlVideoPackets, commands in as a
// type byte and a big-endian length ('K' key frame, 'B' box, 'R' bitrate, 'F' picture). The end of its input ends
// it; a source that went away ends it with "ended: <why>" on stderr, and the last line on stderr is a JSON summary.
// The pointer is never drawn into a capture, as on a Mac and Linux: a recording draws its own.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <fcntl.h>
#include <io.h>

#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <initguid.h>
#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <strmif.h>
#include <wincodec.h>
#include <wmcodecdsp.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "wmcodecdspuuid.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "windowsapp.lib")

namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgd = winrt::Windows::Graphics::DirectX;
using winrt::com_ptr;

static constexpr int LIMIT = 4096;
static constexpr size_t SAMPLES = 65536;

// ---- options and state ----------------------------------------------------------------------------------------

enum class Source { Display, Window, Frames };
enum class EncoderChoice { Auto, Hardware, Software };

static struct {
  Source source = Source::Frames;
  int display = -1;
  HWND window = nullptr;
  int fps = 30, bitrate = 0, keyint = 0, quality = 0;
  int boxWidth = 0, boxHeight = 0;
  EncoderChoice encoder = EncoderChoice::Auto;
} options;

static double nowMs() {
  static LARGE_INTEGER frequency = [] { LARGE_INTEGER f; QueryPerformanceFrequency(&f); return f; }();
  LARGE_INTEGER t;
  QueryPerformanceCounter(&t);
  return double(t.QuadPart) * 1000.0 / double(frequency.QuadPart);
}
static double wallMs() {
  FILETIME t;
  GetSystemTimePreciseAsFileTime(&t);
  uint64_t ticks = uint64_t(t.dwHighDateTime) << 32 | t.dwLowDateTime;
  return double(ticks - 116444736000000000ULL) / 10000.0;
}

static struct {
  long frames = 0, keys = 0, arrived = 0, unchanged = 0;
  long long bytes = 0;
  double started = 0;
  std::vector<double> capture, convert, encode;
  std::string encoder = "none";
} stats;

static std::mutex outputLock;
static std::string endedReason;

// ---- output -------------------------------------------------------------------------------------------------

static void put16(uint8_t *p, unsigned v) { p[0] = uint8_t(v >> 8); p[1] = uint8_t(v); }
static void put32(uint8_t *p, uint32_t v) { p[0] = uint8_t(v >> 24); p[1] = uint8_t(v >> 16); p[2] = uint8_t(v >> 8); p[3] = uint8_t(v); }
static uint32_t get32(const uint8_t *p) { return uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 | uint32_t(p[2]) << 8 | p[3]; }

static bool writeAll(const uint8_t *data, size_t length) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  while (length) {
    DWORD written = 0;
    if (!WriteFile(out, data, DWORD(std::min<size_t>(length, 1 << 30)), &written, nullptr) || !written) return false;
    data += written;
    length -= written;
  }
  return true;
}

/** One ControlVideoPacket, with its length before it. */
static bool emit(bool key, int width, int height, const std::vector<uint8_t> &description, uint32_t sequence, double capturedAt,
                 const std::vector<uint8_t> &data) {
  std::vector<uint8_t> packet(4 + 24 + description.size() + data.size());
  uint8_t *p = packet.data();
  put32(p, uint32_t(packet.size() - 4));
  p += 4;
  p[0] = 1;
  p[1] = key ? 1 : 0;
  put16(p + 2, unsigned(width));
  put16(p + 4, unsigned(height));
  put16(p + 6, unsigned(description.size()));
  put32(p + 8, sequence);
  uint64_t bits;
  memcpy(&bits, &capturedAt, 8);
  for (int i = 0; i < 8; i++) p[12 + i] = uint8_t(bits >> (56 - 8 * i));
  put32(p + 20, uint32_t(data.size()));
  if (!description.empty()) memcpy(p + 24, description.data(), description.size());
  memcpy(p + 24 + description.size(), data.data(), data.size());
  std::lock_guard<std::mutex> lock(outputLock);
  stats.bytes += long long(packet.size() - 4);
  return writeAll(packet.data(), packet.size());
}

static void sample(std::vector<double> &into, double value) {
  if (into.size() < SAMPLES) into.push_back(value);
}

static void summary() {
  std::lock_guard<std::mutex> lock(outputLock);
  double seconds = (nowMs() - stats.started) / 1000;
  auto percentile = [](std::vector<double> values, double p) {
    if (values.empty()) return 0.0;
    std::sort(values.begin(), values.end());
    return values[std::min(values.size() - 1, size_t(values.size() * p))];
  };
  if (!endedReason.empty()) fprintf(stderr, "ended: %s\n", endedReason.c_str());
  fprintf(stderr,
          "{\"frames\":%ld,\"keys\":%ld,\"seconds\":%.1f,\"fps\":%.1f,\"kbps\":%.0f,\"arrived\":%ld,\"unchanged\":%ld,"
          "\"captureMs\":[%.2f,%.2f],\"convertMs\":[%.2f,%.2f],\"encodeMs\":[%.2f,%.2f],\"encoder\":\"%s\"}\n",
          stats.frames, stats.keys, seconds, seconds > 0 ? stats.frames / seconds : 0, seconds > 0 ? stats.bytes * 8 / seconds / 1000 : 0,
          stats.arrived, stats.unchanged, percentile(stats.capture, 0.5), percentile(stats.capture, 0.95), percentile(stats.convert, 0.5),
          percentile(stats.convert, 0.95), percentile(stats.encode, 0.5), percentile(stats.encode, 0.95), stats.encoder.c_str());
  fflush(stderr);
}

[[noreturn]] static void finish(const std::string &ended, int code = 0) {
  static std::atomic<bool> finishing{false};
  // One summary: whichever thread finishes second waits for the first to end the process.
  if (finishing.exchange(true)) for (;;) Sleep(INFINITE);
  if (!ended.empty() && endedReason.empty()) endedReason = ended;
  summary();
  ExitProcess(UINT(code));
}

static std::string hresultText(HRESULT hr) {
  char buffer[32];
  snprintf(buffer, sizeof buffer, "0x%08lx", (unsigned long)hr);
  return buffer;
}

// ---- pictures: BGRA scaled to the box, then NV12 ------------------------------------------------------------

/** `width`×`height` scaled to fit the box (and the packet's 4096 limit), even. */
static void fit(int width, int height, int &outWidth, int &outHeight) {
  double scale = 1;
  int boxWidth = options.boxWidth ? options.boxWidth : LIMIT, boxHeight = options.boxHeight ? options.boxHeight : LIMIT;
  if (width > boxWidth) scale = std::min(scale, double(boxWidth) / width);
  if (height > boxHeight) scale = std::min(scale, double(boxHeight) / height);
  outWidth = std::max(2, int(std::floor(width * scale)) & ~1);
  outHeight = std::max(2, int(std::floor(height * scale)) & ~1);
}

/** An area-averaged downscale of BGRA (each output pixel the mean of the source pixels it covers), for legible text. */
static void scaleBgra(const uint8_t *src, int srcStride, int srcWidth, int srcHeight, uint8_t *dst, int dstWidth, int dstHeight) {
  std::vector<int> x0(dstWidth + 1), y0(dstHeight + 1);
  for (int x = 0; x <= dstWidth; x++) x0[x] = int(int64_t(x) * srcWidth / dstWidth);
  for (int y = 0; y <= dstHeight; y++) y0[y] = int(int64_t(y) * srcHeight / dstHeight);
  for (int y = 0; y < dstHeight; y++) {
    int ya = y0[y], yb = std::max(y0[y + 1], ya + 1);
    uint8_t *out = dst + size_t(y) * dstWidth * 4;
    for (int x = 0; x < dstWidth; x++) {
      int xa = x0[x], xb = std::max(x0[x + 1], xa + 1);
      uint32_t b = 0, g = 0, r = 0, n = 0;
      for (int sy = ya; sy < yb; sy++) {
        const uint8_t *row = src + size_t(sy) * srcStride + size_t(xa) * 4;
        for (int sx = xa; sx < xb; sx++, row += 4) {
          b += row[0];
          g += row[1];
          r += row[2];
        }
        n += uint32_t(xb - xa);
      }
      out[x * 4 + 0] = uint8_t((b + n / 2) / n);
      out[x * 4 + 1] = uint8_t((g + n / 2) / n);
      out[x * 4 + 2] = uint8_t((r + n / 2) / n);
      out[x * 4 + 3] = 255;
    }
  }
}

/**
 * BGRA to NV12, BT.601 in studio range: Media Foundation's encoders write no color description, and decoders (FFmpeg's,
 * a browser's) take an untagged stream as BT.601, as the Linux helper's libyuv converts. Each 2×2 block's chroma is the
 * mean of its four.
 * Rows go to up to four threads at large sizes.
 */
static void bgraToNv12(const uint8_t *src, int stride, int width, int height, uint8_t *nv12) {
  uint8_t *yPlane = nv12, *uvPlane = nv12 + size_t(width) * height;
  auto rows = [&](int from, int to) {
    for (int y = from; y < to; y += 2) {
      const uint8_t *a = src + size_t(y) * stride, *b = a + stride;
      uint8_t *ya = yPlane + size_t(y) * width, *yb = ya + width, *uv = uvPlane + size_t(y / 2) * width;
      for (int x = 0; x < width; x += 2) {
        int r0 = a[2], g0 = a[1], b0 = a[0], r1 = a[6], g1 = a[5], b1 = a[4];
        int r2 = b[2], g2 = b[1], b2 = b[0], r3 = b[6], g3 = b[5], b3 = b[4];
        ya[0] = uint8_t(((66 * r0 + 129 * g0 + 25 * b0 + 128) >> 8) + 16);
        ya[1] = uint8_t(((66 * r1 + 129 * g1 + 25 * b1 + 128) >> 8) + 16);
        yb[0] = uint8_t(((66 * r2 + 129 * g2 + 25 * b2 + 128) >> 8) + 16);
        yb[1] = uint8_t(((66 * r3 + 129 * g3 + 25 * b3 + 128) >> 8) + 16);
        int r = r0 + r1 + r2 + r3, g = g0 + g1 + g2 + g3, bl = b0 + b1 + b2 + b3;
        uv[0] = uint8_t(((-38 * r - 74 * g + 112 * bl + 512) >> 10) + 128);
        uv[1] = uint8_t(((112 * r - 94 * g - 18 * bl + 512) >> 10) + 128);
        a += 8;
        b += 8;
        ya += 2;
        yb += 2;
        uv += 2;
      }
    }
  };
  int threads = std::clamp(int(int64_t(width) * height / 600000) + 1, 1, 4);
  if (threads == 1) return rows(0, height);
  std::vector<std::thread> workers;
  int band = ((height / threads) + 1) & ~1;
  for (int t = 0; t < threads; t++) {
    int from = t * band, to = std::min(height, from + band);
    if (from < to) workers.emplace_back(rows, from, to);
  }
  for (auto &worker : workers) worker.join();
}

// ---- the encoder: a Media Foundation H.264 transform ----------------------------------------------------------

/** NAL units in Annex B: each start code's position and the unit after it. */
static const uint8_t *nextNal(const uint8_t *p, const uint8_t *end, size_t &length) {
  auto start = [&](const uint8_t *q) { return q + 3 <= end && q[0] == 0 && q[1] == 0 && (q[2] == 1 || (q + 4 <= end && q[2] == 0 && q[3] == 1)); };
  while (p + 3 <= end && !start(p)) p++;
  if (p + 3 > end) return nullptr;
  p += p[2] == 1 ? 3 : 4;
  const uint8_t *q = p;
  while (q + 3 <= end && !start(q)) q++;
  if (q + 3 > end) q = end;
  // A zero before the next start code is that code's, not this unit's.
  while (q > p && q < end && q[-1] == 0) q--;
  length = size_t(q - p);
  return p;
}

static void setUint(ICodecAPI *api, const GUID &key, ULONG value) {
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_UI4;
  v.ulVal = value;
  api->SetValue(&key, &v);
}
static void setBool(ICodecAPI *api, const GUID &key, bool value) {
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_BOOL;
  v.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
  api->SetValue(&key, &v);
}

static int defaultBitrate(int width, int height) {
  double bits = double(width) * height * options.fps * 0.08;
  return int(std::min(8e6, std::max(4e5, bits)));
}

/**
 * One encoder at one size. A software encoder is synchronous: a picture in, its unit out. A hardware one is
 * asynchronous: its events say when it wants a picture and when it has a unit, and a thread of the session's own
 * answers them, so a unit goes out the moment it's made, whatever the capture is doing.
 */
struct Session : std::enable_shared_from_this<Session> {
  com_ptr<IMFTransform> transform;
  com_ptr<ICodecAPI> codec;
  com_ptr<IMFActivate> activate;
  com_ptr<IMFMediaEventGenerator> events;
  int width = 0, height = 0;
  bool hardware = false, providesSamples = false;
  DWORD outputSize = 0;
  std::vector<uint8_t> description;
  struct Pending { int64_t time; uint32_t sequence; double capturedAt; };
  std::mutex lock;
  std::condition_variable changed;
  std::deque<Pending> pending;
  int needInput = 0;
  bool failed = false, stopping = false, drained = false;
  std::string error;

  bool fail(const std::string &what, HRESULT hr) {
    std::lock_guard<std::mutex> guard(lock);
    if (error.empty()) error = what + " " + hresultText(hr);
    return false;
  }

  /** The rate control, GOP and latency, set before the media types, as the encoders require. */
  void configure() {
    if (!codec) return;
    setBool(codec.get(), CODECAPI_AVLowLatencyMode, true);
    setUint(codec.get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0);
    // Frames between key frames; with none asked for, as long as the encoder allows: a key frame comes when asked.
    setUint(codec.get(), CODECAPI_AVEncMPVGOPSize, ULONG(options.keyint > 0 ? options.keyint : 0xffff));
    if (options.quality > 0) {
      // A recording: constant quality, so a still picture costs little and motion keeps its detail; 0–100 as
      // VideoToolbox's on a Mac.
      setUint(codec.get(), CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_Quality);
      setUint(codec.get(), CODECAPI_AVEncCommonQuality, ULONG(std::clamp(options.quality, 1, 100)));
    } else {
      // Live: a ceiling, as the other helpers keep one: over a reliable link an overshoot queues behind the viewer.
      int bitrate = options.bitrate ? options.bitrate : defaultBitrate(width, height);
      // Low-delay VBR: measured on Windows' own encoder, it keeps the asked rate and follows a new one mid-stream
      // (the R command); peak-constrained VBR ignored a change until the encoder was made again.
      setUint(codec.get(), CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_LowDelayVBR);
      setUint(codec.get(), CODECAPI_AVEncCommonMeanBitRate, ULONG(bitrate));
      setUint(codec.get(), CODECAPI_AVEncCommonMaxBitRate, ULONG(bitrate));
      setUint(codec.get(), CODECAPI_AVEncCommonBufferSize, ULONG(bitrate));
    }
  }

  bool setTypes() {
    int bitrate = options.bitrate ? options.bitrate : defaultBitrate(width, height);
    com_ptr<IMFMediaType> output, input;
    HRESULT hr = MFCreateMediaType(output.put());
    if (FAILED(hr)) return fail("MFCreateMediaType", hr);
    output->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    output->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    output->SetUINT32(MF_MT_AVG_BITRATE, UINT32(bitrate));
    MFSetAttributeSize(output.get(), MF_MT_FRAME_SIZE, UINT32(width), UINT32(height));
    MFSetAttributeRatio(output.get(), MF_MT_FRAME_RATE, UINT32(options.fps), 1);
    MFSetAttributeRatio(output.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    output->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    output->SetUINT32(MF_MT_MPEG2_PROFILE, options.quality > 0 ? eAVEncH264VProfile_High : eAVEncH264VProfile_Main);
    // BT.601, the matrix the pictures were converted with (`bgraToNv12`); an encoder that writes a color description
    // says so.
    output->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT470_2_SysBG);
    output->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
    output->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601);
    output->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
    hr = transform->SetOutputType(0, output.get(), 0);
    if (FAILED(hr)) return fail("SetOutputType", hr);
    hr = MFCreateMediaType(input.put());
    if (FAILED(hr)) return fail("MFCreateMediaType", hr);
    input->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    input->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(input.get(), MF_MT_FRAME_SIZE, UINT32(width), UINT32(height));
    MFSetAttributeRatio(input.get(), MF_MT_FRAME_RATE, UINT32(options.fps), 1);
    MFSetAttributeRatio(input.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    input->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    input->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT470_2_SysBG);
    input->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
    input->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601);
    input->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
    input->SetUINT32(MF_MT_DEFAULT_STRIDE, UINT32(width));
    hr = transform->SetInputType(0, input.get(), 0);
    if (FAILED(hr)) return fail("SetInputType", hr);
    MFT_OUTPUT_STREAM_INFO info{};
    hr = transform->GetOutputStreamInfo(0, &info);
    if (FAILED(hr)) return fail("GetOutputStreamInfo", hr);
    providesSamples = (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
    outputSize = std::max<DWORD>(info.cbSize, DWORD(size_t(width) * height * 3 / 2 + 65536));
    return true;
  }

  bool openSoftware() {
    HRESULT hr = CoCreateInstance(CLSID_MSH264EncoderMFT, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(transform.put()));
    if (FAILED(hr)) return fail("CoCreateInstance(CLSID_MSH264EncoderMFT)", hr);
    codec = transform.try_as<ICodecAPI>();
    configure();
    if (!setTypes()) return false;
    transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
    stats.encoder = "Media Foundation (software)";
    return true;
  }

  bool openHardware() {
    hardware = true;
    MFT_REGISTER_TYPE_INFO in{MFMediaType_Video, MFVideoFormat_NV12}, out{MFMediaType_Video, MFVideoFormat_H264};
    IMFActivate **activates = nullptr;
    UINT32 count = 0;
    HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, &in, &out, &activates, &count);
    if (FAILED(hr) || !count) {
      if (activates) CoTaskMemFree(activates);
      return fail("no hardware H.264 encoder", FAILED(hr) ? hr : MF_E_NOT_FOUND);
    }
    std::wstring name;
    hr = E_FAIL;
    for (UINT32 i = 0; i < count; i++) {
      if (!transform && SUCCEEDED(hr = activates[i]->ActivateObject(IID_PPV_ARGS(transform.put())))) {
        activate.copy_from(activates[i]);
        WCHAR *friendly = nullptr;
        UINT32 length = 0;
        if (SUCCEEDED(activates[i]->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &friendly, &length))) {
          name = friendly;
          CoTaskMemFree(friendly);
        }
      }
      activates[i]->Release();
    }
    CoTaskMemFree(activates);
    if (!transform) return fail("ActivateObject", hr);
    com_ptr<IMFAttributes> attributes;
    if (SUCCEEDED(transform->GetAttributes(attributes.put())) && attributes) {
      attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE);
      attributes->SetUINT32(MF_LOW_LATENCY, TRUE);
    }
    events = transform.try_as<IMFMediaEventGenerator>();
    if (!events) return fail("the hardware encoder sends no events", E_NOINTERFACE);
    codec = transform.try_as<ICodecAPI>();
    configure();
    if (!setTypes()) return false;
    hr = transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    if (FAILED(hr)) return fail("BEGIN_STREAMING", hr);
    hr = transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
    if (FAILED(hr)) return fail("START_OF_STREAM", hr);
    std::thread([self = shared_from_this()] { self->eventLoop(); }).detach();
    std::string utf8(name.size() * 3 + 1, '\0');
    utf8.resize(size_t(WideCharToMultiByte(CP_UTF8, 0, name.c_str(), int(name.size()), utf8.data(), int(utf8.size()), nullptr, nullptr)));
    for (auto &c : utf8)
      if (c == '"' || c == '\\') c = '\'';
    stats.encoder = "Media Foundation (hardware: " + utf8 + ")";
    return true;
  }

  void eventLoop() {
    while (true) {
      com_ptr<IMFMediaEvent> event;
      HRESULT hr = events->GetEvent(0, event.put());
      MediaEventType type = MEUnknown;
      if (SUCCEEDED(hr)) event->GetType(&type);
      if (type == METransformHaveOutput) {
        HRESULT taken = takeOutput();
        if (FAILED(taken) && taken != MF_E_TRANSFORM_NEED_MORE_INPUT) fail("ProcessOutput", taken), hr = taken;
      }
      std::lock_guard<std::mutex> guard(lock);
      if (FAILED(hr)) {
        if (!stopping && error.empty()) error = "GetEvent " + hresultText(hr);
        failed = drained = true;
      } else if (type == METransformNeedInput) {
        needInput++;
      } else if (type == METransformDrainComplete) {
        drained = true;
      } else if (type == MEError) {
        HRESULT status = S_OK;
        event->GetStatus(&status);
        if (error.empty()) error = "MEError " + hresultText(status);
        failed = true;
      }
      changed.notify_all();
      if (failed) return;
    }
  }

  /** Every picture given is written before it closes. */
  void close() {
    if (!transform) return;
    transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    transform->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
    if (hardware) {
      std::unique_lock<std::mutex> guard(lock);
      changed.wait_for(guard, std::chrono::milliseconds(500), [this] { return drained || failed; });
      stopping = true;
    } else {
      drain();
    }
    transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    // Shutting the event generator down ends a hardware session's thread.
    if (auto shutdown = transform.try_as<IMFShutdown>()) shutdown->Shutdown();
    if (activate) activate->ShutdownObject();
  }

  bool submit(const uint8_t *nv12, uint32_t sequence, double capturedAt, int64_t time, bool key) {
    com_ptr<IMFMediaBuffer> buffer;
    size_t size = size_t(width) * height * 3 / 2;
    HRESULT hr = MFCreateMemoryBuffer(DWORD(size), buffer.put());
    if (FAILED(hr)) return fail("MFCreateMemoryBuffer", hr);
    BYTE *bytes = nullptr;
    buffer->Lock(&bytes, nullptr, nullptr);
    memcpy(bytes, nv12, size);
    buffer->Unlock();
    buffer->SetCurrentLength(DWORD(size));
    com_ptr<IMFSample> sample;
    MFCreateSample(sample.put());
    sample->AddBuffer(buffer.get());
    sample->SetSampleTime(time);
    sample->SetSampleDuration(10000000 / options.fps);
    if (key) {
      if (codec) setUint(codec.get(), CODECAPI_AVEncVideoForceKeyFrame, 1);
      sample->SetUINT32(MFSampleExtension_CleanPoint, TRUE);
    }
    {
      std::lock_guard<std::mutex> guard(lock);
      pending.push_back({time, sequence, capturedAt});
      if (pending.size() > 64) pending.pop_front();
    }
    if (hardware) {
      std::unique_lock<std::mutex> guard(lock);
      if (!changed.wait_for(guard, std::chrono::seconds(2), [this] { return needInput > 0 || failed; }) || failed) {
        if (error.empty()) error = "the hardware encoder wanted no input";
        return false;
      }
      needInput--;
      guard.unlock();
      hr = transform->ProcessInput(0, sample.get(), 0);
      return SUCCEEDED(hr) || fail("ProcessInput", hr);
    }
    hr = transform->ProcessInput(0, sample.get(), 0);
    if (hr == MF_E_NOTACCEPTING) {
      if (!drain()) return false;
      hr = transform->ProcessInput(0, sample.get(), 0);
    }
    if (FAILED(hr)) return fail("ProcessInput", hr);
    return drain();
  }

  /** Every unit the (synchronous) encoder has. */
  bool drain() {
    while (true) {
      HRESULT hr = takeOutput();
      if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) return true;
      if (FAILED(hr)) return fail("ProcessOutput", hr);
    }
  }

  HRESULT takeOutput() {
    MFT_OUTPUT_DATA_BUFFER output{};
    com_ptr<IMFSample> given;
    if (!providesSamples) {
      com_ptr<IMFMediaBuffer> buffer;
      MFCreateMemoryBuffer(outputSize, buffer.put());
      MFCreateSample(given.put());
      given->AddBuffer(buffer.get());
      output.pSample = given.get();
    }
    DWORD status = 0;
    HRESULT hr = transform->ProcessOutput(0, 1, &output, &status);
    if (output.pEvents) output.pEvents->Release();
    if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
      // The encoder settled its output type; take it as it is now.
      com_ptr<IMFMediaType> type;
      if (SUCCEEDED(transform->GetOutputAvailableType(0, 0, type.put()))) transform->SetOutputType(0, type.get(), 0);
      MFT_OUTPUT_STREAM_INFO info{};
      if (SUCCEEDED(transform->GetOutputStreamInfo(0, &info))) outputSize = std::max(outputSize, info.cbSize);
      return S_OK;
    }
    if (FAILED(hr)) return hr;
    com_ptr<IMFSample> produced;
    if (providesSamples) produced.attach(output.pSample);
    else produced = given;
    if (produced) deliver(produced.get());
    return S_OK;
  }

  void deliver(IMFSample *produced) {
    com_ptr<IMFMediaBuffer> buffer;
    if (FAILED(produced->ConvertToContiguousBuffer(buffer.put()))) return;
    BYTE *bytes = nullptr;
    DWORD length = 0;
    buffer->Lock(&bytes, nullptr, &length);
    std::vector<uint8_t> units;
    units.reserve(length + 64);
    const uint8_t *sps = nullptr, *pps = nullptr;
    size_t spsLength = 0, ppsLength = 0, nalLength = 0;
    bool key = false;
    const uint8_t *end = bytes + length;
    for (const uint8_t *p = bytes, *nal; (nal = nextNal(p, end, nalLength)); p = nal + nalLength) {
      if (!nalLength) continue;
      int type = nal[0] & 0x1f;
      if (type == 7) sps = nal, spsLength = nalLength;
      else if (type == 8) pps = nal, ppsLength = nalLength;
      else if (type == 9) continue;  // An access unit delimiter says nothing a packet doesn't.
      else {
        if (type == 5) key = true;
        uint8_t prefix[4];
        put32(prefix, uint32_t(nalLength));
        units.insert(units.end(), prefix, prefix + 4);
        units.insert(units.end(), nal, nal + nalLength);
      }
    }
    if (sps && pps && spsLength >= 4 && spsLength < 1024 && ppsLength < 1024) {
      // The decoder configuration (avcC) of the stream from here: one SPS, one PPS.
      description.assign({1, sps[1], sps[2], sps[3], 0xff, 0xe1});
      uint8_t size[2];
      put16(size, unsigned(spsLength));
      description.insert(description.end(), size, size + 2);
      description.insert(description.end(), sps, sps + spsLength);
      description.push_back(1);
      put16(size, unsigned(ppsLength));
      description.insert(description.end(), size, size + 2);
      description.insert(description.end(), pps, pps + ppsLength);
    }
    buffer->Unlock();
    if (units.empty() || (key && description.empty())) return;  // A key unit without its configuration starts no decoder.
    LONGLONG time = 0;
    produced->GetSampleTime(&time);
    uint32_t sequence = 0;
    double capturedAt = 0;
    {
      std::lock_guard<std::mutex> guard(lock);
      while (pending.size() > 1 && pending.front().time < time) pending.pop_front();
      if (!pending.empty()) {
        sequence = pending.front().sequence;
        capturedAt = pending.front().capturedAt;
        pending.pop_front();
      }
    }
    stats.frames++;
    if (key) stats.keys++;
    static const std::vector<uint8_t> none;
    if (!emit(key, width, height, key ? description : none, sequence, capturedAt, units)) finish("");
  }
};

class Encoder {
 public:
  int width = 0, height = 0;
  bool forceKey = true;
  std::string lastError;

  bool encode(const uint8_t *nv12, int w, int h, uint32_t sequence, double capturedAt) {
    if (!session || w != width || h != height) open(w, h);
    size_t size = size_t(w) * h * 3 / 2;
    if (nv12 != last.data()) last.assign(nv12, nv12 + size);
    lastSequence = sequence;
    lastCapturedAt = capturedAt;
    double started = nowMs();
    // Times in 100 ns from the start, a frame apart at least, so rate control sees the real gaps between changes.
    clock = std::max(int64_t((nowMs() - stats.started) * 10000), clock + 10000000 / options.fps);
    bool key = forceKey;
    forceKey = false;
    bool ok = session->submit(last.data(), sequence, capturedAt, clock, key);
    if (!ok && session->hardware && options.encoder == EncoderChoice::Auto) {
      // A GPU encoder that fails: Windows' own takes over, from a key frame.
      fprintf(stderr, "mako-video: the hardware encoder failed (%s); encoding in software\n", session->error.c_str());
      options.encoder = EncoderChoice::Software;
      open(w, h);
      forceKey = false;
      ok = session->submit(last.data(), sequence, capturedAt, clock, true);
    }
    if (!ok) lastError = session->error;
    sample(stats.encode, nowMs() - started);
    return ok;
  }

  /** The kept picture again, as a key frame. */
  bool again() {
    if (last.empty() || !session) return true;
    forceKey = true;
    return encode(last.data(), width, height, lastSequence, lastCapturedAt);
  }

  void setBitrate(int bitrate) {
    options.bitrate = bitrate;
    if (!session || !session->codec || options.quality) return;
    setUint(session->codec.get(), CODECAPI_AVEncCommonMeanBitRate, ULONG(bitrate));
    setUint(session->codec.get(), CODECAPI_AVEncCommonMaxBitRate, ULONG(bitrate));
    setUint(session->codec.get(), CODECAPI_AVEncCommonBufferSize, ULONG(bitrate));
  }

  void close() {
    if (session) session->close();
    session = nullptr;
  }

 private:
  std::shared_ptr<Session> session;
  /** The last picture encoded, kept so a key frame asked for while nothing changes shows it. */
  std::vector<uint8_t> last;
  uint32_t lastSequence = 0;
  double lastCapturedAt = 0;
  int64_t clock = 0;

  void open(int w, int h) {
    close();
    width = w;
    height = h;
    forceKey = true;
    std::string hardwareError;
    if (options.encoder != EncoderChoice::Software) {
      session = std::make_shared<Session>();
      session->width = w;
      session->height = h;
      if (session->openHardware()) return;
      hardwareError = session->error;
      session->close();
      if (options.encoder == EncoderChoice::Hardware) finish("No hardware H.264 encoder could start: " + hardwareError);
    }
    session = std::make_shared<Session>();
    session->width = w;
    session->height = h;
    if (session->openSoftware()) return;
    finish("Media Foundation's H.264 encoder couldn't encode a " + std::to_string(w) + "x" + std::to_string(h) + " picture: " + session->error +
           (hardwareError.empty() ? "" : "; hardware: " + hardwareError));
  }
};

static Encoder encoder;
/** The encoder and every picture buffer below; commands and the capture take turns. */
static std::recursive_mutex work;
static std::vector<uint8_t> scaled, nv12;

/** A BGRA picture scaled to fit the box, converted and encoded. */
static bool encodeBgra(const uint8_t *bgra, int stride, int width, int height, uint32_t sequence, double capturedAt) {
  int outWidth, outHeight;
  fit(width, height, outWidth, outHeight);
  double started = nowMs();
  const uint8_t *source = bgra;
  int sourceStride = stride;
  if (outWidth != (width & ~1) || outHeight != (height & ~1)) {
    scaled.resize(size_t(outWidth) * outHeight * 4);
    scaleBgra(bgra, stride, width, height, scaled.data(), outWidth, outHeight);
    source = scaled.data();
    sourceStride = outWidth * 4;
  }
  nv12.resize(size_t(outWidth) * outHeight * 3 / 2);
  bgraToNv12(source, sourceStride, outWidth, outHeight, nv12.data());
  sample(stats.convert, nowMs() - started);
  return encoder.encode(nv12.data(), outWidth, outHeight, sequence, capturedAt);
}

// ---- pictures on the input ----------------------------------------------------------------------------------

static com_ptr<IWICImagingFactory> wic;
static std::vector<uint8_t> decoded;

static bool picture(const uint8_t *body, uint32_t length) {
  if (length < 13) return false;
  int format = body[0];
  uint32_t sequence = get32(body + 1);
  uint64_t bits = 0;
  for (int i = 0; i < 8; i++) bits = bits << 8 | body[5 + i];
  double capturedAt;
  memcpy(&capturedAt, &bits, 8);
  body += 13;
  length -= 13;
  double started = nowMs();
  int width = 0, height = 0;
  if (format == 0) {
    if (!wic && FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(wic.put())))) finish("WIC isn't available to decode JPEG");
    com_ptr<IWICStream> stream;
    com_ptr<IWICBitmapDecoder> decoder;
    com_ptr<IWICBitmapFrameDecode> frame;
    com_ptr<IWICFormatConverter> converter;
    if (FAILED(wic->CreateStream(stream.put())) || FAILED(stream->InitializeFromMemory(const_cast<BYTE *>(body), length)) ||
        FAILED(wic->CreateDecoderFromStream(stream.get(), nullptr, WICDecodeMetadataCacheOnDemand, decoder.put())) ||
        FAILED(decoder->GetFrame(0, frame.put())) || FAILED(wic->CreateFormatConverter(converter.put())) ||
        FAILED(converter->Initialize(frame.get(), GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom)))
      return true;  // A picture that doesn't decode is skipped, as on Linux.
    UINT w = 0, h = 0;
    converter->GetSize(&w, &h);
    if (w > UINT(LIMIT * 2) || h > UINT(LIMIT * 2) || w < 2 || h < 2) return false;
    width = int(w);
    height = int(h);
    decoded.resize(size_t(width) * height * 4);
    if (FAILED(converter->CopyPixels(nullptr, UINT(width * 4), UINT(decoded.size()), decoded.data()))) return true;
  } else if (format == 1 || format == 2) {
    if (length < 4) return false;
    width = body[0] << 8 | body[1];
    height = body[2] << 8 | body[3];
    body += 4;
    length -= 4;
    int channels = format == 1 ? 3 : 4;
    if (width < 2 || height < 2 || size_t(width) * height * channels != length) return false;
    decoded.resize(size_t(width) * height * 4);
    uint8_t *out = decoded.data();
    for (size_t i = 0, n = size_t(width) * height; i < n; i++, body += channels, out += 4) {
      out[0] = body[2];
      out[1] = body[1];
      out[2] = body[0];
      out[3] = 255;
    }
  } else {
    return false;
  }
  sample(stats.capture, nowMs() - started);
  return encodeBgra(decoded.data(), width * 4, width, height, sequence, capturedAt);
}

// ---- Windows Graphics Capture -------------------------------------------------------------------------------

class Capture {
 public:
  bool start() {
    if (!wgc::GraphicsCaptureSession::IsSupported()) return stop("Windows Graphics Capture isn't available on this system");
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
                                   device.put(), nullptr, context.put());
    // Without a GPU (a VM, a server): Windows' software rasterizer captures the same way.
    if (FAILED(hr))
      hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, device.put(),
                             nullptr, context.put());
    if (FAILED(hr)) return stop("Direct3D 11 couldn't start: " + hresultText(hr));
    // The capture's thread and the encoder's share the immediate context.
    if (auto multithread = device.try_as<ID3D11Multithread>()) multithread->SetMultithreadProtected(TRUE);
    auto dxgi = device.as<IDXGIDevice>();
    winrt::com_ptr<::IInspectable> inspectable;
    hr = CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put());
    if (FAILED(hr)) return stop("Windows Graphics Capture can't use this device: " + hresultText(hr));
    winrtDevice = inspectable.as<wgd::Direct3D11::IDirect3DDevice>();

    auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    try {
      if (options.source == Source::Window) {
        if (!IsWindow(options.window)) return stop("That window is gone");
        winrt::check_hresult(interop->CreateForWindow(options.window, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item)));
      } else {
        HMONITOR monitor = displayMonitor();
        if (!monitor) return stop("That display is gone");
        winrt::check_hresult(interop->CreateForMonitor(monitor, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item)));
      }
    } catch (const winrt::hresult_error &error) {
      return stop(std::string(options.source == Source::Window ? "That window can't be captured: " : "That display can't be captured: ") + winrt::to_string(error.message()));
    }
    size = item.Size();
    item.Closed([this](auto &&, auto &&) { stop(options.source == Source::Window ? "The window closed" : "The display was removed"); });
    pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(winrtDevice, wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
    pool.FrameArrived([this](wgc::Direct3D11CaptureFramePool const &sender, auto &&) { arrived(sender); });
    session = pool.CreateCaptureSession(item);
    // The pointer stays out, as ScreenCaptureKit's and X11's captures leave it; a recording draws its own.
    try { session.IsCursorCaptureEnabled(false); } catch (...) {}
    // No yellow border where Windows allows leaving it off (Windows 11; older systems always draw it).
    try {
      if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired"))
        session.IsBorderRequired(false);
    } catch (...) {}
    session.StartCapture();
    return true;
  }

  /** Waits for changed frames and encodes them, at most `fps` a second; returns when the capture ends. */
  void run() {
    double interval = 1000.0 / options.fps, next = 0;
    while (true) {
      {
        std::unique_lock<std::mutex> lock(state);
        // A window whose process ended may never say it closed: it's looked for twice a second meanwhile.
        while (!changed.wait_for(lock, std::chrono::milliseconds(500), [this] { return dirty || !ended.empty(); })) {
          if (options.source == Source::Window && !IsWindow(options.window)) ended = "The window closed";
        }
        if (!ended.empty()) return;
      }
      double t = nowMs();
      if (t < next) {
        std::this_thread::sleep_for(std::chrono::microseconds(int64_t((next - t) * 1000)));
        continue;
      }
      next = std::max(next + interval, t);
      std::lock_guard<std::recursive_mutex> lock(work);
      if (!encodeLatest(false)) {
        stop(encoder.lastError.empty() ? "Encoding failed" : encoder.lastError);
        return;
      }
    }
  }

  /** The picture held now encoded again at the box's size (the box changed). */
  bool encodeAgain() { return encodeLatest(true); }

  bool stop(const std::string &reason) {
    std::lock_guard<std::mutex> lock(state);
    if (ended.empty()) ended = reason;
    changed.notify_all();
    return false;
  }

  std::string reason() {
    std::lock_guard<std::mutex> lock(state);
    return ended;
  }

  void close() {
    try {
      if (session) session.Close();
      if (pool) pool.Close();
    } catch (...) {}
  }

 private:
  com_ptr<ID3D11Device> device;
  com_ptr<ID3D11DeviceContext> context;
  wgd::Direct3D11::IDirect3DDevice winrtDevice{nullptr};
  wgc::GraphicsCaptureItem item{nullptr};
  wgc::Direct3D11CaptureFramePool pool{nullptr};
  wgc::GraphicsCaptureSession session{nullptr};
  winrt::Windows::Graphics::SizeInt32 size{};
  /** The newest frame, copied out of the pool as it arrives so the pool never holds the picture we still need. */
  com_ptr<ID3D11Texture2D> latest, staging;
  int latestWidth = 0, latestHeight = 0;
  std::mutex state;
  std::condition_variable changed;
  bool dirty = false;
  std::string ended;
  /** The last picture read back, compared with the next: Windows sends a frame for each composition, not each change. */
  std::vector<uint8_t> previous, current;
  int currentWidth = 0, currentHeight = 0;
  uint32_t sequence = 0;

  HMONITOR displayMonitor() {
    if (options.display < 0) return MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
    struct Search { int wanted, index; HMONITOR found; } search{options.display, 0, nullptr};
    EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR monitor, HDC, LPRECT, LPARAM data) -> BOOL {
      auto *s = reinterpret_cast<Search *>(data);
      if (s->index++ == s->wanted) { s->found = monitor; return FALSE; }
      return TRUE;
    }, reinterpret_cast<LPARAM>(&search));
    return search.found;
  }

  void arrived(wgc::Direct3D11CaptureFramePool const &sender) {
    auto frame = sender.TryGetNextFrame();
    if (!frame) return;
    stats.arrived++;
    auto content = frame.ContentSize();
    if (content.Width != size.Width || content.Height != size.Height) {
      // Resized: the pool's buffers follow the content; this frame still holds the old size's picture.
      size = content;
      pool.Recreate(winrtDevice, wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
    }
    auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    com_ptr<ID3D11Texture2D> texture;
    if (FAILED(access->GetInterface(IID_PPV_ARGS(texture.put())))) return;
    D3D11_TEXTURE2D_DESC desc;
    texture->GetDesc(&desc);
    int width = std::min<int>(content.Width, int(desc.Width)), height = std::min<int>(content.Height, int(desc.Height));
    if (width < 2 || height < 2) return;
    std::lock_guard<std::recursive_mutex> lock(work);
    if (!latest || latestWidth != width || latestHeight != height) {
      D3D11_TEXTURE2D_DESC own{};
      own.Width = UINT(width);
      own.Height = UINT(height);
      own.MipLevels = 1;
      own.ArraySize = 1;
      own.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      own.SampleDesc.Count = 1;
      own.Usage = D3D11_USAGE_DEFAULT;
      latest = nullptr;
      if (FAILED(device->CreateTexture2D(&own, nullptr, latest.put()))) return;
      own.Usage = D3D11_USAGE_STAGING;
      own.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      staging = nullptr;
      if (FAILED(device->CreateTexture2D(&own, nullptr, staging.put()))) return;
      latestWidth = width;
      latestHeight = height;
    }
    D3D11_BOX box{0, 0, 0, UINT(width), UINT(height), 1};
    context->CopySubresourceRegion(latest.get(), 0, 0, 0, 0, texture.get(), 0, &box);
    std::lock_guard<std::mutex> stateLock(state);
    dirty = true;
    changed.notify_all();
  }

  /** Reads the newest frame back and encodes it if it differs from the last (or `again`, whatever it shows). */
  bool encodeLatest(bool again) {
    {
      std::lock_guard<std::mutex> lock(state);
      dirty = false;
    }
    if (!latest) return true;
    double started = nowMs();
    double capturedAt = wallMs();
    if (!again) {
      context->CopyResource(staging.get(), latest.get());
      D3D11_MAPPED_SUBRESOURCE mapped;
      if (FAILED(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped))) return true;
      size_t row = size_t(latestWidth) * 4;
      current.resize(row * latestHeight);
      for (int y = 0; y < latestHeight; y++) memcpy(current.data() + row * y, static_cast<uint8_t *>(mapped.pData) + size_t(mapped.RowPitch) * y, row);
      context->Unmap(staging.get(), 0);
      sample(stats.capture, nowMs() - started);
      bool same = currentWidth == latestWidth && currentHeight == latestHeight && previous.size() == current.size() &&
                  memcmp(previous.data(), current.data(), current.size()) == 0;
      currentWidth = latestWidth;
      currentHeight = latestHeight;
      if (same) {
        stats.unchanged++;
        return true;
      }
      previous.swap(current);
    }
    if (previous.empty()) return true;
    return encodeBgra(previous.data(), currentWidth * 4, currentWidth, currentHeight, ++sequence, capturedAt);
  }
};

static Capture capture;

// ---- commands -----------------------------------------------------------------------------------------------

/** Runs every complete command in `input`; false to stop. */
static bool commands(std::vector<uint8_t> &input) {
  size_t at = 0;
  while (input.size() - at >= 5) {
    uint8_t type = input[at];
    uint32_t length = get32(input.data() + at + 1);
    if (length > (64u << 20)) finish("A command was too long");
    if (input.size() - at - 5 < length) break;
    const uint8_t *body = input.data() + at + 5;
    bool ok = true;
    {
      std::lock_guard<std::recursive_mutex> lock(work);
      if (type == 'K') {
        ok = encoder.again();
      } else if (type == 'B' && length == 4) {
        int width = body[0] << 8 | body[1], height = body[2] << 8 | body[3];
        if (width != options.boxWidth || height != options.boxHeight) {
          options.boxWidth = width;
          options.boxHeight = height;
          // The next picture opens an encoder at the new size; a still capture sends its picture again now.
          if (options.source != Source::Frames) ok = capture.encodeAgain();
        }
      } else if (type == 'R' && length == 4) {
        encoder.setBitrate(int(get32(body)));
      } else if (type == 'F' && options.source == Source::Frames) {
        ok = picture(body, length);
      } else {
        finish("Unknown command");
      }
    }
    if (!ok) finish(encoder.lastError.empty() ? "A picture couldn't be encoded" : encoder.lastError);
    at += 5 + length;
  }
  input.erase(input.begin(), input.begin() + ptrdiff_t(at));
  return true;
}

// ---- main ---------------------------------------------------------------------------------------------------

[[noreturn]] static void usage() {
  fprintf(stderr,
          "usage: mako-video display [<n>]|window <hwnd>|frames [--fps N] [--bitrate BPS] [--box WxH] [--keyint N] [--quality Q] "
          "[--encoder auto|hardware|software]\n");
  fflush(stderr);
  ExitProcess(64);
}

int wmain(int argc, wchar_t **argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stderr), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
  if (argc < 2) usage();
  std::vector<std::string> args;
  for (int i = 1; i < argc; i++) args.push_back(winrt::to_string(argv[i]));
  size_t arg = 1;
  if (args[0] == "frames") options.source = Source::Frames;
  else if (args[0] == "display") {
    options.source = Source::Display;
    if (args.size() > 1 && args[1].rfind("--", 0) != 0) options.display = atoi(args[arg++].c_str());
  } else if (args[0] == "window" && args.size() > 1) {
    options.source = Source::Window;
    options.window = reinterpret_cast<HWND>(static_cast<uintptr_t>(_strtoui64(args[1].c_str(), nullptr, 0)));
    arg = 2;
  } else usage();
  for (; arg + 1 < args.size(); arg += 2) {
    const std::string &name = args[arg], &value = args[arg + 1];
    if (name == "--fps") options.fps = atoi(value.c_str());
    else if (name == "--bitrate") options.bitrate = atoi(value.c_str());
    else if (name == "--keyint") options.keyint = atoi(value.c_str());
    else if (name == "--quality") options.quality = atoi(value.c_str());
    else if (name == "--box") {
      if (sscanf_s(value.c_str(), "%dx%d", &options.boxWidth, &options.boxHeight) != 2) usage();
    } else if (name == "--encoder") {
      options.encoder = value == "hardware" ? EncoderChoice::Hardware : value == "software" ? EncoderChoice::Software : EncoderChoice::Auto;
    } else if (name == "--content" || name == "--threads") {
      // The Linux helper's OpenH264 tuning; Media Foundation's encoders choose their own.
    } else usage();
  }
  if (arg != args.size() || options.fps < 1 || options.fps > 120) usage();
  char configured[32];
  size_t configuredLength = 0;
  if (options.encoder == EncoderChoice::Auto && !getenv_s(&configuredLength, configured, sizeof configured, "MAKO_VIDEO_ENCODER") && configuredLength) {
    if (!strcmp(configured, "software")) options.encoder = EncoderChoice::Software;
    else if (!strcmp(configured, "hardware")) options.encoder = EncoderChoice::Hardware;
  }

  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
  if (FAILED(hr)) finish("Media Foundation isn't available here (" + hresultText(hr) + "); on Windows Server, add the Media Foundation feature");
  stats.started = nowMs();

  if (options.source != Source::Frames) {
    if (!capture.start()) finish(capture.reason());
    std::thread capturing([] {
      capture.run();
      // The source went away or couldn't be encoded: that ends the helper, with why. The capture closes outside the
      // lock, since closing waits for a frame handler that may be waiting for it.
      std::string reason = capture.reason();
      if (reason == "input ended") return;
      capture.close();
      std::lock_guard<std::recursive_mutex> lock(work);
      encoder.close();
      finish(reason);
    });
    capturing.detach();
  }

  // Commands until the input ends.
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::vector<uint8_t> input;
  std::vector<uint8_t> chunk(1 << 16);
  while (true) {
    DWORD read = 0;
    if (!ReadFile(in, chunk.data(), DWORD(chunk.size()), &read, nullptr) || !read) break;
    input.insert(input.end(), chunk.begin(), chunk.begin() + read);
    commands(input);
  }
  capture.stop("input ended");
  capture.close();
  std::lock_guard<std::recursive_mutex> lock(work);
  encoder.close();
  finish("");
}
