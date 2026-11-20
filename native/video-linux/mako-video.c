// mako-video: Mako's live video encoder on Linux, without FFmpeg.
//
// It captures an X11 display, or one window through XComposite (so whatever covers the window never shows), only
// when XDamage says its pixels changed, or it takes pictures on its input (JPEG, or raw RGB/RGBA as a recording draws
// them). It scales them to the viewers' box and encodes H.264 with OpenH264 (BSD-2-Clause); libyuv converts and scales,
// libjpeg-turbo decodes. With nothing changing it sleeps in poll(): no frame, no CPU.
//
//   mako-video display [options]        the whole X screen ($DISPLAY)
//   mako-video window <xid> [options]   one window, by its X id
//   mako-video frames [options]         the pictures on its input
//   options: --fps N (30)  --bitrate BPS (from the size)  --box WxH (none)  --keyint N (0: only when asked)
//            --quality QP (constant quantizer, for recordings, instead of a bitrate)  --threads N (from the size)
//            --content screen (OpenH264's screen-content tools: fewer bits, more CPU; default camera)
//
// stdout: each unit as a 4-byte big-endian length, then a ControlVideoPacket (packages/control-runtime/src/contracts/
// control-video.ts): version 1, the kind, the picture's size, the avcC on a key unit, the source frame's sequence
// and capture time, then the H.264 as length-prefixed NAL units.
// stdin: commands, each a type byte and a 4-byte big-endian length, then that many bytes:
//   'K' (0)    the next unit is a key frame, of the picture shown now if nothing changes
//   'B' (4)    the viewers' box: u16 width, u16 height; 0 0 for the source's own size
//   'R' (4)    the bitrate, u32 bits a second
//   'F' (13+)  a picture (frames only): u8 format (0 JPEG, 1 RGB, 2 RGBA), u32 sequence, f64 capture time in ms since
//              1970, then for RGB and RGBA u16 width and u16 height, then the bytes
// The end of stdin ends it. A source that went away ends it with "ended: <why>" on stderr; the last line on stderr is
// always a JSON summary.
#define _GNU_SOURCE
#include <errno.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <time.h>
#include <unistd.h>

#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xcomposite.h>
#include <X11/extensions/Xdamage.h>
#include <libyuv.h>
#include <turbojpeg.h>
#include <wels/codec_api.h>

#define LIMIT 4096
#define DESCRIPTION_LIMIT 4096
#define SAMPLES 65536

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}
static double wall_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}
static int compare(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}

// ---- options and state ----------------------------------------------------------------------------------------

static struct {
  enum { DISPLAY_SOURCE, WINDOW_SOURCE, FRAMES_SOURCE } source;
  Window window;
  int fps, bitrate, keyint, quality, threads, screen;
  int box_width, box_height;
} options = { .fps = 30 };

static struct {
  long frames, bytes, damage, keys;
  double started, capture[SAMPLES], encode[SAMPLES];
} stats;

static const char *ended;

// ---- output -------------------------------------------------------------------------------------------------

static void put16(uint8_t *p, unsigned v) { p[0] = v >> 8; p[1] = v; }
static void put32(uint8_t *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
static uint32_t get32(const uint8_t *p) { return (uint32_t)p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]; }

static int write_all(const uint8_t *data, size_t length) {
  while (length) {
    ssize_t n = write(1, data, length);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    data += n;
    length -= n;
  }
  return 0;
}

static uint8_t *packet;
static size_t packet_capacity;

/** One ControlVideoPacket, with its length before it. */
static int emit(int key, int width, int height, const uint8_t *description, int description_length, uint32_t sequence,
                double captured_at, const uint8_t *data, size_t data_length) {
  size_t length = 24 + description_length + data_length;
  if (packet_capacity < 4 + length) {
    packet_capacity = 4 + length + 65536;
    packet = realloc(packet, packet_capacity);
  }
  uint8_t *p = packet;
  put32(p, length);
  p += 4;
  p[0] = 1;
  p[1] = key ? 1 : 0;
  put16(p + 2, width);
  put16(p + 4, height);
  put16(p + 6, description_length);
  put32(p + 8, sequence);
  uint64_t bits;
  memcpy(&bits, &captured_at, 8);
  for (int i = 0; i < 8; i++) p[12 + i] = bits >> (56 - 8 * i);
  put32(p + 20, data_length);
  memcpy(p + 24, description, description_length);
  memcpy(p + 24 + description_length, data, data_length);
  stats.bytes += length;
  return write_all(packet, 4 + length);
}

// ---- the encoder --------------------------------------------------------------------------------------------

static ISVCEncoder *encoder;
static int encoded_width, encoded_height;
static int force_key = 1;
static uint8_t *units;
static size_t units_capacity;

/** The bitrate a size and rate get unless told otherwise: what live video spends (`liveVideoBitrate`). */
static int default_bitrate(int width, int height) {
  double bits = (double)width * height * options.fps * 0.08;
  return (int)fmin(8e6, fmax(4e5, bits));
}

/** Slices, each on its own thread: one per 0.6 megapixels, at most four. */
static int threads_for(int width, int height) {
  if (options.threads) return options.threads;
  int threads = (int)ceil((double)width * height / 600000.0);
  long cores = sysconf(_SC_NPROCESSORS_ONLN);
  if (threads > cores) threads = cores;
  return threads < 1 ? 1 : threads > 4 ? 4 : threads;
}

static void close_encoder(void) {
  if (!encoder) return;
  (*encoder)->Uninitialize(encoder);
  WelsDestroySVCEncoder(encoder);
  encoder = NULL;
}

static int open_encoder(int width, int height) {
  close_encoder();
  if (WelsCreateSVCEncoder(&encoder) || !encoder) return -1;
  SEncParamExt p;
  (*encoder)->GetDefaultParams(encoder, &p);
  int bitrate = options.bitrate ? options.bitrate : default_bitrate(width, height);
  int threads = threads_for(width, height);
  // OpenH264's screen-content mode finds scrolls and spends a third of the bits on a screen, but runs on one thread at
  // two to three times the cost: 21 ms a 2560×1600 frame against 7 ms with four slices (2 CPUs, no GPU). Live video
  // takes the cheaper encode; a recording, written once and kept, asks for the smaller one.
  p.iUsageType = options.screen ? SCREEN_CONTENT_REAL_TIME : CAMERA_VIDEO_REAL_TIME;
  p.iPicWidth = width;
  p.iPicHeight = height;
  p.fMaxFrameRate = options.fps;
  p.iSpatialLayerNum = 1;
  p.iTemporalLayerNum = 1;
  p.uiIntraPeriod = options.keyint;
  p.eSpsPpsIdStrategy = CONSTANT_ID;
  p.bEnableSSEI = false;
  p.bPrefixNalAddingCtrl = false;
  p.bEnableDenoise = false;
  p.bEnableBackgroundDetection = true;
  p.bEnableAdaptiveQuant = true;
  p.bEnableLongTermReference = false;
  p.iMultipleThreadIdc = threads;
  p.iComplexityMode = LOW_COMPLEXITY;
  SSpatialLayerConfig *layer = &p.sSpatialLayers[0];
  layer->iVideoWidth = width;
  layer->iVideoHeight = height;
  layer->fFrameRate = options.fps;
  layer->uiProfileIdc = PRO_BASELINE;
  if (threads > 1) {
    layer->sSliceArgument.uiSliceMode = SM_FIXEDSLCNUM_SLICE;
    layer->sSliceArgument.uiSliceNum = threads;
  } else {
    layer->sSliceArgument.uiSliceMode = SM_SINGLE_SLICE;
  }
  if (options.quality) {
    // A recording: the same quantizer throughout, so a still picture costs nothing and motion keeps its detail.
    p.iRCMode = RC_OFF_MODE;
    p.bEnableFrameSkip = false;
    layer->iDLayerQp = options.quality;
  } else {
    // Live: the bitrate is a ceiling the encoder keeps by skipping a frame rather than overshooting, which over a
    // reliable link would queue behind the viewer instead. The quantizer's range keeps text readable.
    p.iRCMode = RC_BITRATE_MODE;
    p.bEnableFrameSkip = true;
    p.iTargetBitrate = bitrate;
    p.iMaxBitrate = bitrate;
    layer->iSpatialBitrate = bitrate;
    layer->iMaxSpatialBitrate = bitrate;
    p.iMinQp = 18;
    p.iMaxQp = 42;
  }
  if ((*encoder)->InitializeExt(encoder, &p)) return -1;
  int format = videoFormatI420;
  (*encoder)->SetOption(encoder, ENCODER_OPTION_DATAFORMAT, &format);
  encoded_width = width;
  encoded_height = height;
  force_key = 1;
  return 0;
}

static void set_bitrate(int bitrate) {
  options.bitrate = bitrate;
  if (!encoder || options.quality) return;
  SBitrateInfo target = { SPATIAL_LAYER_ALL, bitrate };
  (*encoder)->SetOption(encoder, ENCODER_OPTION_MAX_BITRATE, &target);
  (*encoder)->SetOption(encoder, ENCODER_OPTION_BITRATE, &target);
}

/** NAL units in Annex B as OpenH264 writes them: each start code's position and the unit after it. */
static const uint8_t *next_nal(const uint8_t *p, const uint8_t *end, size_t *length) {
  while (p + 3 <= end && !(p[0] == 0 && p[1] == 0 && (p[2] == 1 || (p + 4 <= end && p[2] == 0 && p[3] == 1)))) p++;
  if (p + 3 > end) return NULL;
  p += p[2] == 1 ? 3 : 4;
  const uint8_t *q = p;
  while (q + 3 <= end && !(q[0] == 0 && q[1] == 0 && (q[2] == 1 || (q + 4 <= end && q[2] == 0 && q[3] == 1)))) q++;
  if (q + 3 > end) q = end;
  *length = q - p;
  return p;
}

/** Encodes the I420 picture; a unit goes out unless rate control skipped the frame. */
static int encode(uint8_t *y, uint8_t *u, uint8_t *v, uint32_t sequence, double captured_at) {
  SSourcePicture picture = { 0 };
  picture.iColorFormat = videoFormatI420;
  picture.iPicWidth = encoded_width;
  picture.iPicHeight = encoded_height;
  picture.iStride[0] = encoded_width;
  picture.iStride[1] = picture.iStride[2] = encoded_width / 2;
  picture.pData[0] = y;
  picture.pData[1] = u;
  picture.pData[2] = v;
  picture.uiTimeStamp = (long long)(now_ms() - stats.started);
  if (force_key) {
    (*encoder)->ForceIntraFrame(encoder, true);
    force_key = 0;
  }
  SFrameBSInfo info;
  memset(&info, 0, sizeof info);
  double started = now_ms();
  if ((*encoder)->EncodeFrame(encoder, &picture, &info) != cmResultSuccess) return -1;
  if (stats.frames < SAMPLES) stats.encode[stats.frames] = now_ms() - started;
  if (info.eFrameType == videoFrameTypeSkip || info.eFrameType == videoFrameTypeInvalid) {
    // A key frame asked for and skipped is asked for again.
    return 0;
  }
  uint8_t sps[256], pps[256];
  int sps_length = 0, pps_length = 0, key = info.eFrameType == videoFrameTypeIDR;
  size_t length = 0;
  for (int l = 0; l < info.iLayerNum; l++) {
    SLayerBSInfo *layer = &info.sLayerInfo[l];
    size_t total = 0;
    for (int n = 0; n < layer->iNalCount; n++) total += layer->pNalLengthInByte[n];
    if (units_capacity < length + total + 64) {
      units_capacity = length + total + 65536;
      units = realloc(units, units_capacity);
    }
    const uint8_t *p = layer->pBsBuf, *end = layer->pBsBuf + total;
    size_t nal_length;
    for (const uint8_t *nal; (nal = next_nal(p, end, &nal_length)); p = nal + nal_length) {
      int type = nal[0] & 0x1f;
      if (type == 7 && nal_length <= sizeof sps) memcpy(sps, nal, sps_length = nal_length);
      else if (type == 8 && nal_length <= sizeof pps) memcpy(pps, nal, pps_length = nal_length);
      else {
        put32(units + length, nal_length);
        memcpy(units + length + 4, nal, nal_length);
        length += 4 + nal_length;
      }
    }
  }
  if (!length) return 0;
  uint8_t description[DESCRIPTION_LIMIT];
  int description_length = 0;
  if (key) {
    if (!sps_length || !pps_length) return -1;
    uint8_t *d = description;
    d[0] = 1;
    d[1] = sps[1];
    d[2] = sps[2];
    d[3] = sps[3];
    d[4] = 0xff;
    d[5] = 0xe1;
    put16(d + 6, sps_length);
    memcpy(d + 8, sps, sps_length);
    d += 8 + sps_length;
    d[0] = 1;
    put16(d + 1, pps_length);
    memcpy(d + 3, pps, pps_length);
    description_length = d + 3 + pps_length - description;
    stats.keys++;
  }
  stats.frames++;
  return emit(key, encoded_width, encoded_height, description, description_length, sequence, captured_at, units, length);
}

// ---- pictures to I420 at the box's size -------------------------------------------------------------------------

static uint8_t *scaled_argb, *yuv;
static size_t scaled_capacity, yuv_capacity;
/** The last picture encoded, kept so a key frame asked for while nothing changes shows it. */
static int have_picture;
static uint32_t last_sequence;
static double last_captured_at;

static void fit(int width, int height, int *out_width, int *out_height) {
  double scale = 1;
  int box_width = options.box_width ? options.box_width : LIMIT, box_height = options.box_height ? options.box_height : LIMIT;
  if (width > box_width) scale = fmin(scale, (double)box_width / width);
  if (height > box_height) scale = fmin(scale, (double)box_height / height);
  *out_width = ((int)floor(width * scale)) & ~1;
  *out_height = ((int)floor(height * scale)) & ~1;
  if (*out_width < 2) *out_width = 2;
  if (*out_height < 2) *out_height = 2;
}

/** A BGRA picture (X11's and libyuv's "ARGB"), scaled to fit the box and encoded. */
static int encode_argb(const uint8_t *argb, int stride, int width, int height, uint32_t sequence, double captured_at) {
  int out_width, out_height;
  fit(width, height, &out_width, &out_height);
  if ((out_width != encoded_width || out_height != encoded_height || !encoder) && open_encoder(out_width, out_height)) return -1;
  size_t plane = (size_t)out_width * out_height;
  if (yuv_capacity < plane * 3 / 2) yuv = realloc(yuv, yuv_capacity = plane * 3 / 2);
  uint8_t *y = yuv, *u = yuv + plane, *v = u + plane / 4;
  if (out_width == (width & ~1) && out_height == (height & ~1)) {
    ARGBToI420(argb, stride, y, out_width, u, out_width / 2, v, out_width / 2, out_width, out_height);
  } else {
    if (scaled_capacity < plane * 4) scaled_argb = realloc(scaled_argb, scaled_capacity = plane * 4);
    ARGBScale(argb, stride, width, height, scaled_argb, out_width * 4, out_width, out_height, kFilterBox);
    ARGBToI420(scaled_argb, out_width * 4, y, out_width, u, out_width / 2, v, out_width / 2, out_width, out_height);
  }
  have_picture = 1;
  last_sequence = sequence;
  last_captured_at = captured_at;
  return encode(y, u, v, sequence, captured_at);
}

/** The kept picture again, as a key frame. */
static int encode_again(void) {
  if (!have_picture || !encoder) return 0;
  size_t plane = (size_t)encoded_width * encoded_height;
  force_key = 1;
  return encode(yuv, yuv + plane, yuv + plane + plane / 4, last_sequence, last_captured_at);
}

// ---- X11 capture --------------------------------------------------------------------------------------------

static Display *display;
static Drawable drawable;
static Pixmap pixmap;
static XImage *image;
static XShmSegmentInfo shm;
static int damage_event, source_width, source_height, depth;
static Visual *visual;

static int on_x_error(Display *d, XErrorEvent *e) {
  (void)d;
  if (e->error_code == BadWindow || e->error_code == BadDrawable || e->error_code == BadMatch) ended = "The window closed";
  return 0;
}

static void release_image(void) {
  if (!image) return;
  XShmDetach(display, &shm);
  XDestroyImage(image);
  shmdt(shm.shmaddr);
  image = NULL;
}

/** (Re)names what to read and makes a shared image of its size. */
static int prepare_capture(void) {
  release_image();
  XWindowAttributes attributes;
  Window target = options.source == WINDOW_SOURCE ? options.window : DefaultRootWindow(display);
  if (!XGetWindowAttributes(display, target, &attributes) || ended) {
    ended = "The window closed";
    return -1;
  }
  source_width = attributes.width;
  source_height = attributes.height;
  depth = attributes.depth;
  visual = attributes.visual;
  if (options.source == WINDOW_SOURCE) {
    if (attributes.map_state != IsViewable) return 1;
    if (pixmap) XFreePixmap(display, pixmap);
    pixmap = XCompositeNameWindowPixmap(display, options.window);
    XSync(display, False);
    if (ended) return -1;
    drawable = pixmap;
  } else {
    drawable = target;
  }
  image = XShmCreateImage(display, visual, depth, ZPixmap, NULL, &shm, source_width, source_height);
  if (!image || image->bits_per_pixel != 32) {
    fprintf(stderr, "mako-video: only 24- and 32-bit visuals are captured\n");
    return -1;
  }
  shm.shmid = shmget(IPC_PRIVATE, (size_t)image->bytes_per_line * image->height, IPC_CREAT | 0600);
  shm.shmaddr = image->data = shmat(shm.shmid, 0, 0);
  shm.readOnly = False;
  XShmAttach(display, &shm);
  shmctl(shm.shmid, IPC_RMID, 0);
  XSync(display, False);
  return 0;
}

static uint32_t sequence;

static int capture_and_encode(void) {
  if (!image) return 0;
  double started = now_ms();
  double captured_at = wall_ms();
  if (!XShmGetImage(display, drawable, image, 0, 0, AllPlanes)) {
    if (options.source == WINDOW_SOURCE) return prepare_capture() < 0 ? -1 : 0;
    return -1;
  }
  if (stats.frames < SAMPLES) stats.capture[stats.frames] = now_ms() - started;
  return encode_argb((uint8_t *)image->data, image->bytes_per_line, source_width, source_height, ++sequence, captured_at);
}

// ---- input commands -----------------------------------------------------------------------------------------

static uint8_t *input;
static size_t input_length, input_capacity;
static tjhandle jpeg;
static uint8_t *decoded;
static size_t decoded_capacity;

static int picture(const uint8_t *body, uint32_t length) {
  if (length < 13) return -1;
  int format = body[0];
  uint32_t frame_sequence = get32(body + 1);
  uint64_t bits = 0;
  for (int i = 0; i < 8; i++) bits = bits << 8 | body[5 + i];
  double captured_at;
  memcpy(&captured_at, &bits, 8);
  body += 13;
  length -= 13;
  double started = now_ms();
  int width, height;
  if (format == 0) {
    int subsampling, colorspace;
    if (!jpeg) jpeg = tjInitDecompress();
    if (tjDecompressHeader3(jpeg, body, length, &width, &height, &subsampling, &colorspace)) return 0;
    if (width > LIMIT * 2 || height > LIMIT * 2) return -1;
    size_t size = (size_t)width * height * 4;
    if (decoded_capacity < size) decoded = realloc(decoded, decoded_capacity = size);
    if (tjDecompress2(jpeg, body, length, decoded, width, width * 4, height, TJPF_BGRA, TJFLAG_FASTDCT)) return 0;
  } else if (format == 1 || format == 2) {
    if (length < 4) return -1;
    width = body[0] << 8 | body[1];
    height = body[2] << 8 | body[3];
    body += 4;
    length -= 4;
    int channels = format == 1 ? 3 : 4;
    if (!width || !height || (size_t)width * height * channels != length) return -1;
    size_t size = (size_t)width * height * 4;
    if (decoded_capacity < size) decoded = realloc(decoded, decoded_capacity = size);
    // libyuv names formats by their order in a little-endian word: "RAW" is R,G,B bytes and "ABGR" is R,G,B,A.
    if (format == 1) RAWToARGB(body, width * 3, decoded, width * 4, width, height);
    else ABGRToARGB(body, width * 4, decoded, width * 4, width, height);
  } else {
    return -1;
  }
  if (stats.frames < SAMPLES) stats.capture[stats.frames] = now_ms() - started;
  return encode_argb(decoded, width * 4, width, height, frame_sequence, captured_at);
}

/** Runs every complete command read so far; returns -1 to stop. */
static int commands(void) {
  size_t at = 0;
  while (input_length - at >= 5) {
    uint8_t type = input[at];
    uint32_t length = get32(input + at + 1);
    if (length > 64u << 20) return -1;
    if (input_length - at - 5 < length) break;
    const uint8_t *body = input + at + 5;
    int result = 0;
    if (type == 'K') {
      result = encode_again();
    } else if (type == 'B' && length == 4) {
      int width = body[0] << 8 | body[1], height = body[2] << 8 | body[3];
      if (width != options.box_width || height != options.box_height) {
        options.box_width = width;
        options.box_height = height;
        // The next picture opens an encoder at the new size; a still source sends its picture again now.
        if (options.source != FRAMES_SOURCE) result = capture_and_encode();
      }
    } else if (type == 'R' && length == 4) {
      set_bitrate(get32(body));
    } else if (type == 'F' && options.source == FRAMES_SOURCE) {
      result = picture(body, length);
    } else {
      return -1;
    }
    if (result < 0) return -1;
    at += 5 + length;
  }
  memmove(input, input + at, input_length - at);
  input_length -= at;
  return 0;
}

/** Reads what stdin has; returns -1 at its end. */
static int read_input(void) {
  if (input_capacity - input_length < 65536) input = realloc(input, input_capacity = input_capacity * 2 + 65536);
  ssize_t n = read(0, input + input_length, input_capacity - input_length);
  if (n < 0 && (errno == EINTR || errno == EAGAIN)) return 0;
  if (n <= 0) return -1;
  input_length += n;
  return commands();
}

// ---- main ---------------------------------------------------------------------------------------------------

static volatile sig_atomic_t stopping;
static void on_signal(int signal) {
  (void)signal;
  stopping = 1;
}

static void summary(void) {
  double seconds = (now_ms() - stats.started) / 1000;
  long n = stats.frames < SAMPLES ? stats.frames : SAMPLES;
  qsort(stats.capture, n, sizeof(double), compare);
  qsort(stats.encode, n, sizeof(double), compare);
  if (ended) fprintf(stderr, "ended: %s\n", ended);
  fprintf(stderr,
          "{\"frames\":%ld,\"keys\":%ld,\"seconds\":%.1f,\"fps\":%.1f,\"kbps\":%.0f,\"damage\":%ld,\"captureMs\":[%.2f,%.2f],"
          "\"encodeMs\":[%.2f,%.2f],\"size\":[%d,%d]}\n",
          stats.frames, stats.keys, seconds, seconds > 0 ? stats.frames / seconds : 0, seconds > 0 ? stats.bytes * 8 / seconds / 1000 : 0,
          stats.damage, n ? stats.capture[n / 2] : 0, n ? stats.capture[n * 95 / 100] : 0, n ? stats.encode[n / 2] : 0,
          n ? stats.encode[n * 95 / 100] : 0, encoded_width, encoded_height);
}

static int usage(void) {
  fprintf(stderr, "usage: mako-video display|window <xid>|frames [--fps N] [--bitrate BPS] [--box WxH] [--keyint N] [--quality QP] [--threads N] [--content screen|camera]\n");
  return 64;
}

int main(int argc, char **argv) {
  if (argc < 2) return usage();
  int arg = 2;
  if (!strcmp(argv[1], "display")) options.source = DISPLAY_SOURCE;
  else if (!strcmp(argv[1], "frames")) options.source = FRAMES_SOURCE;
  else if (!strcmp(argv[1], "window") && argc > 2) {
    options.source = WINDOW_SOURCE;
    options.window = strtoul(argv[2], NULL, 0);
    arg = 3;
  } else return usage();
  for (; arg + 1 < argc; arg += 2) {
    const char *name = argv[arg], *value = argv[arg + 1];
    if (!strcmp(name, "--fps")) options.fps = atoi(value);
    else if (!strcmp(name, "--bitrate")) options.bitrate = atoi(value);
    else if (!strcmp(name, "--keyint")) options.keyint = atoi(value);
    else if (!strcmp(name, "--quality")) options.quality = atoi(value);
    else if (!strcmp(name, "--threads")) options.threads = atoi(value);
    else if (!strcmp(name, "--content")) options.screen = !strcmp(value, "screen");
    else if (!strcmp(name, "--box")) sscanf(value, "%dx%d", &options.box_width, &options.box_height);
    else return usage();
  }
  if (arg != argc || options.fps < 1 || options.fps > 120) return usage();
  signal(SIGTERM, on_signal);
  signal(SIGINT, on_signal);
  signal(SIGPIPE, SIG_IGN);
  stats.started = now_ms();

  int x = -1;
  Damage damage = 0;
  if (options.source != FRAMES_SOURCE) {
    display = XOpenDisplay(NULL);
    if (!display) {
      fprintf(stderr, "mako-video: no X display to capture ($DISPLAY)\n");
      return 69;
    }
    XSetErrorHandler(on_x_error);
    int error, major = 0, minor = 0;
    if (!XShmQueryExtension(display) || !XDamageQueryExtension(display, &damage_event, &error)) {
      fprintf(stderr, "mako-video: this X server has no MIT-SHM or DAMAGE\n");
      return 69;
    }
    Window watched = DefaultRootWindow(display);
    if (options.source == WINDOW_SOURCE) {
      if (!XCompositeQueryExtension(display, &error, &error) || !XCompositeQueryVersion(display, &major, &minor) || (major == 0 && minor < 2)) {
        fprintf(stderr, "mako-video: this X server has no Composite 0.2\n");
        return 69;
      }
      watched = options.window;
      XCompositeRedirectWindow(display, watched, CompositeRedirectAutomatic);
    }
    XSelectInput(display, watched, StructureNotifyMask);
    damage = XDamageCreate(display, watched, XDamageReportNonEmpty);
    if (prepare_capture() < 0) {
      summary();
      return 0;
    }
    x = ConnectionNumber(display);
  }

  double interval = 1000.0 / options.fps, next = 0;
  int dirty = options.source != FRAMES_SOURCE, open = 1;
  while (!stopping && !ended && open) {
    if (display) {
      while (XPending(display)) {
        XEvent event;
        XNextEvent(display, &event);
        if (event.type == damage_event + XDamageNotify) {
          stats.damage++;
          dirty = 1;
        } else if (event.type == ConfigureNotify || event.type == MapNotify) {
          if (prepare_capture() < 0) break;
          dirty = 1;
        } else if (event.type == DestroyNotify) {
          ended = "The window closed";
        } else if (event.type == UnmapNotify && options.source == WINDOW_SOURCE) {
          // Minimized or hidden: nothing to show until it maps again.
          release_image();
        }
      }
      if (ended) break;
      double t = now_ms();
      if (dirty && t >= next) {
        XDamageSubtract(display, damage, None, None);
        dirty = 0;
        next = next + interval > t ? next + interval : t;
        if (capture_and_encode() < 0) break;
        continue;
      }
    }
    struct pollfd fds[2] = { { 0, POLLIN, 0 }, { x, POLLIN, 0 } };
    int wait = dirty ? (int)ceil(next - now_ms()) : -1;
    if (poll(fds, x < 0 ? 1 : 2, wait < 0 && dirty ? 0 : wait) < 0 && errno != EINTR) break;
    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) open = read_input() == 0;
  }
  summary();
  close_encoder();
  return 0;
}
