"""Read-only dependency audit. Run with Browser Use's installed Python.

Exercises installed methods with fake CDP responses. Never connects to Chrome,
opens a tab, or changes the installed package. Assertions document current bugs;
they are reproduction checks, not acceptance tests for desired behavior.
"""
import asyncio
import hashlib
import json
import tempfile
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch

from browser_harness import daemon, helpers


class FakeCDP:
    def __init__(self):
        self.calls = []

    async def send_raw(self, method, params=None, session_id=None):
        self.calls.append({"method": method, "params": params, "session": session_id})
        if session_id == "closed-session":
            raise RuntimeError("Session with given id not found")
        if method == "Target.getTargets":
            return {"targetInfos": [{"targetId": "unrelated-tab", "type": "page",
                                     "url": "https://fixture.invalid/other", "title": "Other"}]}
        if method == "Target.attachToTarget":
            return {"sessionId": "unrelated-session"}
        return {}


async def stale_session_probe():
    instance = daemon.Daemon()
    instance.cdp = FakeCDP()
    instance.session = "closed-session"
    instance.target_id = "closed-tab"
    # Only redirect dependency logging; use its real retry and attach methods.
    with tempfile.TemporaryDirectory(prefix="mako-browser-audit-") as root:
        with patch.object(daemon, "LOG", str(Path(root) / "daemon.log")):
            result = await instance.handle({"method": "Input.insertText", "params": {"text": "fixture"}})
    mutations = [call for call in instance.cdp.calls if call["method"] == "Input.insertText"]
    assert "result" in result, result
    assert [call["session"] for call in mutations] == ["closed-session", "unrelated-session"]
    assert instance.target_id == "unrelated-tab"
    return {"reproduced": True, "returned_success": True, "mutation_attempts": mutations,
            "selected_target": instance.target_id}


def blank_helper_probe():
    selected = []
    other = {"targetId": "unrelated-tab", "url": "https://fixture.invalid/other"}
    with patch.object(helpers, "list_tabs", return_value=[other]):
        with patch.object(helpers, "current_tab", return_value={"targetId": "owned-blank", "url": "about:blank"}):
            with patch.object(helpers, "switch_tab", side_effect=selected.append):
                result = helpers.ensure_real_tab()
    assert selected == ["unrelated-tab"]
    return {"reproduced": True, "selected_targets": selected, "result": result}


async def main():
    sources = {}
    for module in (daemon, helpers):
        path = Path(module.__file__)
        sources[module.__name__] = {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    print(json.dumps({"versions": {name: version(name) for name in ("browser-use", "browser-harness", "cdp-use")}, "sources": sources,
                      "stale_session_retry": await stale_session_probe(),
                      "blank_helper_selection": blank_helper_probe()}, indent=2))


asyncio.run(main())
