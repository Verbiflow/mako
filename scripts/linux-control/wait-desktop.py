"""Wait for the test desktop's actual X11/WM readiness, with a bounded deadline."""
import re
import subprocess
import sys
import time
import threading
from pathlib import Path

mode = sys.argv[1]
if mode == "manager" and len(sys.argv) != 3:
    raise SystemExit("Manager readiness requires Openbox's startup-complete marker")
deadline = time.monotonic() + 10
last = ""

def verify_managed_window():
    # EWMH owner properties can be published before the WM services map requests.
    # Prove a real window is managed before starting the driver/app acceptance.
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("GdkX11", "3.0")
    from gi.repository import Gtk, GdkX11
    window = Gtk.Window(title="Mako desktop readiness")
    window.set_default_size(80, 40)
    window.show_all()
    window.get_display().sync()
    xid = GdkX11.X11Window.get_xid(window.get_window())
    from gi.repository import GLib
    diagnostic = ""
    managed = False
    # Service GTK's frame clock and deferred map work while waiting for the WM.
    managed_deadline = time.monotonic() + 10
    stop = threading.Event()
    def check_mapping():
        nonlocal diagnostic, managed
        # A translated xprop can take longer than the poll interval. Running it
        # in GTK's timer callback blocks frame-clock and map work until the child
        # finishes. Only the GTK thread touches widgets; this worker queries X11.
        while not stop.is_set():
            try:
                result = subprocess.run(
                    ["xprop", "-root", "_NET_CLIENT_LIST"],
                    capture_output=True, text=True, timeout=2,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                diagnostic = str(error)
                break
            diagnostic = result.stdout + result.stderr
            clients = [int(value, 16) for value in re.findall(r"0x[0-9a-fA-F]+", result.stdout)]
            managed = result.returncode == 0 and xid in clients
            if managed or time.monotonic() >= managed_deadline:
                break
            stop.wait(0.05)
        GLib.idle_add(Gtk.main_quit)
    worker = threading.Thread(target=check_mapping, daemon=True)
    worker.start()
    try:
        Gtk.main()
        if not managed:
            geometry = subprocess.run(["xwininfo", "-id", str(xid)], capture_output=True, text=True, timeout=2)
            tree = subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True, timeout=2)
            raise SystemExit(f"Test window manager did not manage readiness window {xid}: {diagnostic}\n{geometry.stdout}{geometry.stderr}\n{tree.stdout}{tree.stderr}")
    finally:
        stop.set()
        worker.join(timeout=2.1)
        window.destroy()
        window.get_display().sync()

while time.monotonic() < deadline:
    # Openbox publishes its EWMH owner before finishing startup. Creating the
    # GTK probe in that interval reproduced an unmapped window on native EC2.
    # Its --startup callback is the completion signal; still prove an actual
    # mapped, managed window below rather than accepting the marker alone.
    if mode == "manager" and not Path(sys.argv[2]).is_file():
        last = "waiting for Openbox's startup callback"
        time.sleep(0.05)
        continue
    result = subprocess.run(
        ["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"],
        capture_output=True, text=True, timeout=2,
    )
    last = result.stdout + result.stderr
    if result.returncode == 0:
        if mode == "server":
            sys.exit(0)
        match = re.search(r"window id # (0x[0-9a-fA-F]+)", result.stdout)
        if match:
            owner = subprocess.run(
                ["xprop", "-id", match[1], "_NET_SUPPORTING_WM_CHECK", "_NET_WM_NAME"],
                capture_output=True, text=True, timeout=2,
            )
            if owner.returncode == 0 and match[1] in owner.stdout and "Openbox" in owner.stdout:
                verify_managed_window()
                sys.exit(0)
    time.sleep(0.05)
raise SystemExit(f"Test desktop {mode} did not become ready: {last}")
