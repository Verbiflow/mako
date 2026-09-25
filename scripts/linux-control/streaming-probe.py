"""Isolated pixelflux media experiment; never enables its input or HTTP APIs.

Run only on a private Xvfb desktop. The pinned wheel and all output live outside
the shipped package. Counts encoded frames here; analyze decoded markers too.
"""
import argparse
import json
import os
from pathlib import Path
import resource
import time

import gi
gi.require_version("Gtk", "3.0")
gi.require_foreign("cairo")
from gi.repository import Gtk, GLib, Gdk
from pixelflux import CaptureSettings, ScreenCapture

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--seconds", type=int, default=60)
parser.add_argument("--fullcolor", action="store_true")
parser.add_argument("--fixture-only", action="store_true")
args = parser.parse_args()
assert 1 <= args.seconds <= 120
assert not os.environ.get("PIXELFLUX_CU")
root = Path(args.output)
root.mkdir(parents=True, exist_ok=True)
window = Gtk.Window(title="Mako private streaming fixture")
window.set_decorated(False)
window.set_default_size(1920, 1080)
area = Gtk.DrawingArea()
window.add(area)
state = {"sequence": 0, "animated": False, "draws": 0}

def draw(_widget, ctx):
    ctx.set_source_rgb(0.09, 0.10, 0.12)
    ctx.paint()
    seq = state["sequence"]
    words = [seq >> 8, seq & 255, 0, 0, 165]
    checksum = 0
    for word in words:
        checksum ^= word
    words.append(checksum)
    for byte, word in enumerate(words):
        for bit in range(8):
            value = 1 if word & (1 << (7-bit)) else 0
            ctx.set_source_rgb(value, value, value)
            ctx.rectangle((byte*8+bit)*40, 400, 40, 100)
            ctx.fill()
    ctx.select_font_face("monospace")
    ctx.set_font_size(14)
    for row in range(20):
        ctx.set_source_rgb(0.85, 0.35 if row % 2 else 0.85, 0.95)
        ctx.move_to(20, 600+row*21)
        ctx.show_text(f"{row:03d} const value = await tab.get({{role: 'button', name: 'Save'}}); // exact text + colour")
    state["draws"] += 1
    return False

def tick(_widget, _clock):
    if state["animated"]:
        state["sequence"] = (state["sequence"] + 1) & 65535
        area.queue_draw()
    return True

area.connect("draw", draw)
area.add_tick_callback(tick)
window.show_all()
capture = None if args.fixture_only else ScreenCapture()
settings = CaptureSettings()
settings.capture_width = 1920
settings.capture_height = 1080
settings.capture_cursor = False
settings.target_fps = 60.0
settings.codec = "h264"
settings.use_cpu = True
settings.video_crf = 18
settings.video_fullframe = True
settings.video_fullcolor = args.fullcolor
settings.video_streaming_mode = False
settings.omit_stripe_headers = True
settings.keyframe_interval_s = 1.0
settings.auto_adjust_screen_capture_size = False
rows = []
phases = []
samples = []
failure = None
output = (root / "stream.h264").open("xb")
started = time.monotonic_ns()

def receive(frame):
    global failure
    if failure or not len(frame):
        return
    if len(rows) >= 9000 or output.tell() + len(frame) > 128*1024*1024:
        failure = "Fixture media budget exceeded"
        return
    output.write(memoryview(frame))
    rows.append({"receivedNs": time.monotonic_ns(), "captureNs": frame.capture_ns,
                 "encodeStartNs": frame.encode_start_ns, "encodeEndNs": frame.encode_end_ns,
                 "bytes": len(frame), "frameId": frame.frame_id, "reference": frame.reference_frame_id})

def sample():
    if output.closed:
        return False
    usage = resource.getrusage(resource.RUSAGE_SELF)
    samples.append({"atNs": time.monotonic_ns(), "cpuSeconds": usage.ru_utime+usage.ru_stime,
                    "peakRssBytes": usage.ru_maxrss*1024, "frames": len(rows), "bytes": output.tell()})
    return True

def phase(name):
    sample()
    phases.append({"name": name, "atNs": time.monotonic_ns(), "stats": capture.stream_stats() if capture else None, "info": capture.stream_info() if capture else None})

def animate():
    Gdk.pixbuf_get_from_window(window.get_window(), 0, 0, 1920, 1080).savev(str(root / "source.png"), "png", [], [])
    phase("active")
    state["animated"] = True
    return False

def idle():
    phase("idle-after")
    state["animated"] = False
    return False

def finish():
    phase("finished")
    if capture:
        capture.stop_capture()
    output.close()
    (root / "result.json").write_text(json.dumps({"scope": "private Xvfb ARM64 CPU capture/encoder; no browser transport/viewer or input parity claim",
        "fullcolor": args.fullcolor, "seconds": args.seconds, "startedNs": started, "state": state,
        "phases": phases, "samples": samples, "frames": rows, "failure": failure}, indent=2))
    Gtk.main_quit()
    return False

def begin():
    if capture:
        capture.start_capture(receive, settings)
    phase("idle-before")
    GLib.timeout_add_seconds(3, animate)
    GLib.timeout_add_seconds(3+args.seconds, idle)
    GLib.timeout_add_seconds(6+args.seconds, finish)
    GLib.timeout_add_seconds(1, sample)
    return False

GLib.timeout_add(500, begin)
try:
    Gtk.main()
finally:
    if capture:
        capture.stop_capture()
    if not output.closed:
        output.close()
