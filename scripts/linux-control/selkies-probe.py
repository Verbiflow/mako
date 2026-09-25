"""Pinned, isolated upstream comparison launcher; not a production service."""
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.request

mode = sys.argv[1]
assert mode in ("websockets", "webrtc")
viewer_password = secrets.token_hex(24)
auth = Path("/tmp/viewer-auth")
auth.write_text("fixture:" + viewer_password)
auth.chmod(0o600)
env = {**os.environ, "SELKIES_BASIC_AUTH_USER": "fixture",
       "SELKIES_BASIC_AUTH_PASSWORD": secrets.token_hex(24),
       "SELKIES_BASIC_AUTH_VIEWONLY_PASSWORD": viewer_password}
server = subprocess.Popen([sys.executable, "-m", "selkies", "--mode", mode,
    "--web-root", "/web", "--audio-enabled=false", "--microphone-enabled=false",
    "--gamepad-enabled=false", "--enable-clipboard=false", "--command-enabled=false",
    "--file-transfers=none", "--printing-enabled=false", "--framerate=60-60",
    "--video-crf=18-18", "--manual-width=1920", "--manual-height=1080"],
    env=env, stdout=Path("/output/server.log").open("wb"), stderr=subprocess.STDOUT)
fixture = None
try:
    for _ in range(100):
        if server.poll() is not None:
            raise RuntimeError("Selkies startup failed; inspect the private server log")
        try:
            urllib.request.urlopen("http://127.0.0.1:8080/", timeout=0.2)
            break
        except urllib.error.HTTPError as error:
            if error.code == 401:
                break
        except OSError:
            pass
        time.sleep(0.1)
    fixture = subprocess.Popen([sys.executable, "/probe/streaming-probe.py", "--fixture-only",
        "--output", "/output/source", "--seconds", "90"])
    subprocess.run(["/usr/local/bin/node", "/opt/mako-control/streaming-viewer.mjs", mode], check=True, timeout=110)
finally:
    for child in (fixture, server):
        if child:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    auth.unlink(missing_ok=True)
