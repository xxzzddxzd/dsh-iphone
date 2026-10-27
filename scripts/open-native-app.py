#!/usr/bin/env python3
"""Open installed Whaleness; session links use real, non-secret paired profiles."""
import argparse
import json
from pathlib import Path
import subprocess
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ios/native"))
from native_client import (DEFAULT_MAPPING, export_mapping, native_session_url,
                           native_pairing_url, read_manifest, validate_native_url)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session")
    parser.add_argument("--pairing-payload", type=Path, help="Private file containing a fresh real local pairing capability; requires the adapted app")
    parser.add_argument("--gateway-id", help="Stable server gateway UUID, not the app's local profile UUID")
    parser.add_argument("--mapping", type=Path, default=DEFAULT_MAPPING)
    parser.add_argument("--refresh-mapping", action="store_true", help="Read the app's paired UserDefaults; never reads Keychain")
    parser.add_argument("--print-url", action="store_true", help="Validate and print a credential-free URL without opening it")
    args = parser.parse_args()
    manifest = read_manifest()
    if args.pairing_payload:
        if args.session or args.gateway_id or args.print_url or args.refresh_mapping:
            raise ValueError("Pairing cannot be combined with session/mapping output options")
        if "loopback-pairing-v1" not in manifest.get("capabilities", []):
            raise ValueError("This native release does not support local pairing links")
        if stat.S_IMODE(args.pairing_payload.stat().st_mode) & 0o077:
            raise ValueError("The one-time pairing file must be private")
        raw = args.pairing_payload.read_text().strip()
        command = ["/var/jb/usr/bin/uiopen", "--url", native_pairing_url(raw)]
    elif args.refresh_mapping:
        mapping = export_mapping(manifest, args.mapping)
    elif args.session:
        mapping = json.loads(args.mapping.read_text())
    if args.pairing_payload:
        pass
    elif args.session:
        url = validate_native_url(native_session_url(mapping, args.session, args.gateway_id), mapping)
        if args.print_url:
            print(url)
            return
        command = ["/var/jb/usr/bin/uiopen", "--url", url]
    else:
        if args.print_url or args.gateway_id:
            raise ValueError("--print-url and --gateway-id require --session")
        command = ["/var/jb/usr/bin/uiopen", "--bundleid", manifest["bundleId"]]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("Native DSH app opened.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        # Launcher errors may contain their URL arguments. Do not print them.
        print("Native DSH open failed; check installation, real pairing, selected local gateway and mapping.", file=sys.stderr)
        raise SystemExit(1)
