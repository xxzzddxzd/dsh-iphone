#!/usr/bin/env python3
"""Run over SSH: bootstrap Safari and prepare the installed DSH WebClip."""
import http.client
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import time
from urllib.parse import urlsplit


def write_plist(path, data):
    info = path.stat()
    temporary = path.with_name(path.name + ".dsh-auth-tmp")
    with temporary.open("wb") as stream:
        plistlib.dump(data, stream, fmt=plistlib.FMT_BINARY)
    os.chmod(temporary, info.st_mode & 0o777)
    os.chown(temporary, info.st_uid, info.st_gid)
    temporary.replace(path)


def main():
    log = Path("/var/root/dsh.log").read_text(errors="replace")
    urls = re.findall(r"http://127\.0\.0\.1:3080/\?token=[A-Za-z0-9_-]{43}", log)
    if not urls:
        raise RuntimeError("no current DSH launch URL in service log")
    launch_url = urls[-1]
    connection = http.client.HTTPConnection("127.0.0.1", 3080, timeout=10)
    connection.request("GET", "/?" + urlsplit(launch_url).query)
    response = connection.getresponse()
    cookie = response.getheader("Set-Cookie")
    response.read()
    if response.status != 303 or not cookie:
        raise RuntimeError("DSH launch exchange failed; check the running service")
    connection.request("GET", "/", headers={"Cookie": cookie.split(";", 1)[0]})
    response = connection.getresponse()
    response.read()
    if response.status != 200:
        raise RuntimeError("DSH rejected its new browser session")
    connection.close()

    count = 0
    for path in Path("/var/mobile/Library/WebClips").glob("*.webclip/Info.plist"):
        data = plistlib.loads(path.read_bytes())
        url = urlsplit(data.get("URL", ""))
        if data.get("Title") != "DSH" or url.scheme != "http" or url.netloc != "127.0.0.1:3080":
            continue
        # Preserve the original plist and manifest once, outside the public web root.
        backup = Path("/var/root/.dsh-webclip-backup") / path.parent.name
        backup.mkdir(mode=0o700, parents=True, exist_ok=True)
        for original in [path, path.parent / "ApplicationManifest"]:
            if original.exists() and not (backup / original.name).exists():
                shutil.copy2(original, backup / original.name)
        data["URL"] = launch_url
        write_plist(path, data)
        manifest_path = path.parent / "ApplicationManifest"
        if manifest_path.exists():
            manifest = plistlib.loads(manifest_path.read_bytes())
            objects = manifest["$objects"]
            root = objects[manifest["$top"]["root"].data]
            start_url = objects[root["start_url"].data]
            objects[start_url["NS.relative"].data] = launch_url
            write_plist(manifest_path, manifest)
        count += 1

    def open_url(*args):
        subprocess.run(["/var/jb/usr/bin/uiopen", *args], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # Activating Safari first prevents iOS from routing the URL to an existing
    # SafariViewService belonging to the standalone WebClip.
    open_url("--bundleid", "com.apple.mobilesafari")
    time.sleep(1)
    open_url("--url", launch_url)
    time.sleep(2)
    if count:
        open_url("--url", launch_url.replace("http://", "webapp://", 1))
    print(f"Safari authentication requested; {count} DSH WebClip launch URL(s) refreshed. Reopen the DSH icon if its old page remains.")


try:
    main()
except Exception:
    # Errors from system launchers can contain their URL argument.
    print("Device authentication setup failed; check SSH, DSH service and WebClip files.")
    raise SystemExit(1)
