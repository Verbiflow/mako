#!/usr/bin/env python3
"""Record source revisions and package/registry facts without executing packages.

Usage: python3 collect.py CHECKOUT_ROOT [CHECKOUT_ROOT ...] > sources.json
Roots may be individual checkouts or directories containing checkouts.
"""

import json
import os
from pathlib import Path
import subprocess
import sys


def git(root, *args):
    return subprocess.check_output(
        ["git", "-C", str(root), *args], text=True
    ).strip()


def checkouts(roots):
    found = set()
    for source in roots:
        for directory, children, _ in os.walk(source):
            if ".git" in children:
                found.add(Path(directory).resolve())
                children[:] = []
            else:
                children[:] = [child for child in children if child != "node_modules"]
    return sorted(found)


def inspect(root):
    files = git(root, "ls-files").splitlines()
    packages = []
    for name in files:
        if Path(name).name != "package.json":
            continue
        data = json.loads((root / name).read_text())
        packages.append({
            "path": name,
            **{key: data[key] for key in (
                "name", "version", "license", "dependencies", "peerDependencies",
                "sideEffects", "exports", "scripts"
            ) if key in data},
        })
    registry_path = root / "registry.json"
    registry = json.loads(registry_path.read_text()) if registry_path.exists() else {}
    return {
        "origin": git(root, "remote", "get-url", "origin"),
        "commit": git(root, "rev-parse", "HEAD"),
        "commitDate": git(root, "show", "-s", "--format=%cI", "HEAD"),
        "checkout": str(root),
        "packages": packages,
        "registryItems": [item["name"] for item in registry.get("items", [])],
        "licenseFiles": [name for name in files if Path(name).name.lower().startswith("license")],
        "testFiles": [name for name in files if any(
            part in {"test", "tests", "__tests__"} for part in Path(name).parts
        ) or ".test." in name or ".spec." in name],
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    print(json.dumps([inspect(root) for root in checkouts(sys.argv[1:])], indent=2))
