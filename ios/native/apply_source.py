#!/usr/bin/env python3
"""Apply only the reviewed Whaleness iPhone patch to its exact source commit."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def apply(source, root=Path(__file__).resolve().parent):
    manifest = json.loads((root / "source-patch.json").read_text())
    patch = root / "whaleness-iphone.patch"
    if hashlib.sha256(patch.read_bytes()).hexdigest() != manifest["sha256"]:
        raise ValueError("Native source patch checksum changed")
    def git(*args, check=True):
        return subprocess.run(["git", "-C", str(source), *args], check=check, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if git("rev-parse", "HEAD").stdout.strip() != manifest["commit"]:
        raise ValueError("Native source must match the reviewed upstream commit")
    if git("apply", "--reverse", "--check", str(patch), check=False).returncode == 0:
        return {"status": "already-applied", "commit": manifest["commit"], "build": manifest["build"]}
    if git("diff", "--exit-code", "--", *manifest["files"], check=False).returncode:
        raise ValueError("Native patch targets have unrelated local edits; preserve them before applying")
    git("apply", "--check", str(patch))
    git("apply", str(patch))
    return {"status": "applied", "commit": manifest["commit"], "build": manifest["build"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(apply(args.source)))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f"Native source patch refused: {error}")
