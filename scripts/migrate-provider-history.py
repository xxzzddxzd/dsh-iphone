#!/usr/bin/env python3
"""Keep the official per-session flock while publishing a new v3 generation."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("runtime")
parser.add_argument("sessions")
parser.add_argument("--node", default="node")
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
worker = Path(__file__).with_suffix(".mjs")
failed = 0
matched = 0
for source in sorted(Path(args.sessions).rglob("session.jsonl")):
    directory = source.parent
    if any(directory.glob("session.v[1-9]*.jsonl*")):
        continue
    contents = source.read_bytes()
    search = b'"web/openai-codex-search-llm-request"' in contents
    old_descriptor = any(
        json.loads(line).get("data", {}).get("version") == 2
        for line in contents.splitlines() if b'"subagent/descriptor"' in line
    )
    del contents
    if not search and not old_descriptor:
        continue
    matched += 1
    lock_path = directory / "session.lock"
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        held = os.fstat(descriptor)
        named = lock_path.stat()
        if (held.st_ino, held.st_dev) != (named.st_ino, named.st_dev):
            raise RuntimeError("session lock inode changed")
        command = [args.node, str(worker), args.runtime, str(source)]
        if args.apply:
            command.extend(["--apply", str(descriptor)])
        completed = subprocess.run(command, pass_fds=(descriptor,))
        failed += completed.returncode != 0
        if completed.returncode:
            print(f"Migration failed; original preserved: {directory.name}", flush=True)
    except BlockingIOError:
        print(f"Session is in use; skipped: {directory.name}")
        failed += 1
    finally:
        os.close(descriptor)
print(f"Provider history: {matched} candidate(s), {failed} failure(s); original generations preserved.")
raise SystemExit(1 if failed else 0)
