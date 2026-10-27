#!/usr/bin/env python3
"""Pinned IPA inspection and non-secret Whaleness host/deep-link metadata.

This module never reads or writes Keychain credentials. Profile identities are
read from the app's own persisted UserDefaults after successful real pairing.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import struct
import tempfile
from urllib.parse import parse_qsl, urlencode, urlsplit
import uuid
import zipfile


DEFAULT_MANIFEST = Path(__file__).with_name("app-release.json")
DEFAULT_MAPPING = Path("/var/root/.dsh/native-client/gateway-map.json")
BUNDLE_ROOTS = (Path("/var/containers/Bundle/Application"), Path("/var/jb/Applications"))
DATA_ROOT = Path("/var/mobile/Containers/Data/Application")


def read_manifest(path=DEFAULT_MANIFEST):
    manifest = json.loads(Path(path).read_text())
    if not isinstance(manifest, dict) or manifest.get("schema") != 1 or not re.fullmatch(r"[a-f0-9]{64}", manifest.get("sha256", "")):
        raise ValueError("Unsupported native app release manifest")
    expected = {"appDirectory": "DshMobile.app", "bundleId": "com.clark.dshmobile.dev", "executable": "DshMobile",
                "widgetDirectory": "AgentLiveActivityWidget.appex", "widgetBundleId": "com.clark.dshmobile.dev.AgentLiveActivityWidget",
                "widgetExecutable": "AgentLiveActivityWidget", "minimumOS": "16.1"}
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError("Native app manifest changes the reviewed app identity or iPhone target")
    _version(manifest.get("version"))
    if not isinstance(manifest.get("build"), str) or not re.fullmatch(r"[1-9][0-9]{0,8}", manifest["build"]):
        raise ValueError("Invalid native build number")
    return manifest


def _version(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+(?:\.\d+){1,2}", value):
        raise ValueError("Invalid native app version")
    parts = tuple(int(p) for p in value.split("."))
    return parts + (0,) * (3 - len(parts))


def macho_ios_version(binary):
    """Read LC_BUILD_VERSION; changing only Info.plist is not compatibility."""
    if binary[:4] != b"\xcf\xfa\xed\xfe" or len(binary) < 32:
        raise ValueError("Expected an arm64 little-endian Mach-O executable")
    _, cpu, _, file_type, commands, command_bytes, _, _ = struct.unpack_from("<IiiIIIII", binary)
    if cpu != 0x0100000C or file_type != 2 or 32 + command_bytes > len(binary):
        raise ValueError("Invalid native executable architecture or load commands")
    position, versions = 32, []
    for _ in range(commands):
        if position + 8 > 32 + command_bytes:
            raise ValueError("Truncated Mach-O load command")
        command, size = struct.unpack_from("<II", binary, position)
        if size < 8 or position + size > 32 + command_bytes:
            raise ValueError("Invalid Mach-O load command size")
        if command == 0x32:
            if size < 24:
                raise ValueError("Truncated LC_BUILD_VERSION")
            platform, minimum, _, _ = struct.unpack_from("<IIII", binary, position + 8)
            if platform != 2:
                raise ValueError("The native executable is not built for iPhoneOS")
            versions.append((minimum >> 16, (minimum >> 8) & 255, minimum & 255))
        position += size
    if position != 32 + command_bytes or len(versions) != 1:
        raise ValueError("Expected one unambiguous iPhoneOS build version")
    return versions[0]


def macho_has_signature(binary):
    # Structural presence only. TrollStoreLite owns signing/trust evaluation.
    commands = struct.unpack_from("<I", binary, 16)[0]
    position = 32
    for _ in range(commands):
        command, size = struct.unpack_from("<II", binary, position)
        if command == 0x1D and size >= 16:
            offset, length = struct.unpack_from("<II", binary, position + 8)
            return (length >= 12 and offset + length <= len(binary)
                    and binary[offset:offset + 4] == b"\xfa\xde\x0c\xc0")
        position += size
    return False


def _check_bundle(info, binary, manifest, widget=False, require_signature=False):
    prefix = "widget" if widget else ""
    bundle_id = manifest["widgetBundleId" if widget else "bundleId"]
    executable = manifest["widgetExecutable" if widget else "executable"]
    expected = {"CFBundleIdentifier": bundle_id, "CFBundleExecutable": executable,
                "CFBundleShortVersionString": manifest["version"], "CFBundleVersion": manifest["build"]}
    if any(info.get(key) != value for key, value in expected.items()):
        raise ValueError(f"Unexpected {prefix or 'app'} bundle identity/version")
    minimum = _version(manifest["minimumOS"])
    if _version(info.get("MinimumOSVersion")) != minimum or macho_ios_version(binary) != minimum:
        raise ValueError("Native Info.plist and Mach-O minimum iOS version must match the release pin")
    if require_signature and not macho_has_signature(binary):
        raise ValueError("Installed native executable has no code signature; do not skip a failed installation")
    if widget and info.get("NSExtension", {}).get("NSExtensionPointIdentifier") != "com.apple.widgetkit-extension":
        raise ValueError("Unexpected native Widget extension")


def verify_ipa(path, manifest):
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    if digest != manifest["sha256"]:
        raise ValueError("Native IPA SHA-256 differs from the pinned release")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(set(names)) != len(names):
            raise ValueError("Native IPA has duplicate archive entries")
        for name in names:
            parts = PurePosixPath(name).parts
            if name.startswith("/") or ".." in parts or "\\" in name:
                raise ValueError("Unsafe native IPA archive path")
        root = f"Payload/{manifest['appDirectory']}"
        app_plists = [n for n in names if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", n)]
        if app_plists != [root + "/Info.plist"]:
            raise ValueError("Native IPA must contain exactly the pinned app")
        widget = root + "/PlugIns/" + manifest["widgetDirectory"]
        widget_plists = [n for n in names if re.fullmatch(r"Payload/[^/]+\.app/PlugIns/[^/]+\.appex/Info\.plist", n)]
        if widget_plists != [widget + "/Info.plist"]:
            raise ValueError("Native IPA must contain exactly the pinned Widget")
        for bundle, is_widget in [(root, False), (widget, True)]:
            info = plistlib.loads(archive.read(bundle + "/Info.plist"))
            binary = archive.read(bundle + "/" + manifest["widgetExecutable" if is_widget else "executable"])
            _check_bundle(info, binary, manifest, is_widget)
    return {"status": "verified", "sha256": digest, "bundleId": manifest["bundleId"],
            "version": manifest["version"], "build": manifest["build"], "minimumOS": manifest["minimumOS"]}


def installed_app(manifest, roots=BUNDLE_ROOTS):
    matches = []
    for root in roots:
        for info_path in list(root.glob("*.app/Info.plist")) + list(root.glob("*/*.app/Info.plist")):
            info = plistlib.loads(info_path.read_bytes())
            if info.get("CFBundleIdentifier") == manifest["bundleId"]:
                matches.append((info_path.parent, info))
    if not matches:
        return {"status": "not-installed", "bundleId": manifest["bundleId"]}
    if len(matches) != 1:
        raise ValueError("Native app registration is ambiguous")
    app, info = matches[0]
    current = (_version(info.get("CFBundleShortVersionString")), int(info.get("CFBundleVersion", "0")))
    target = (_version(manifest["version"]), int(manifest["build"]))
    if current > target:
        raise ValueError("Refusing to downgrade a newer native app")
    if current < target:
        return {"status": "upgrade-required", "bundleId": manifest["bundleId"], "bundlePath": str(app)}
    _check_bundle(info, (app / manifest["executable"]).read_bytes(), manifest, require_signature=True)
    widget = app / "PlugIns" / manifest["widgetDirectory"]
    _check_bundle(plistlib.loads((widget / "Info.plist").read_bytes()),
                  (widget / manifest["widgetExecutable"]).read_bytes(), manifest, True, require_signature=True)
    return {"status": "current", "bundleId": manifest["bundleId"], "bundlePath": str(app),
            "version": manifest["version"], "build": manifest["build"]}


def canonical_uuid(value):
    if not isinstance(value, str):
        raise ValueError("Missing native gateway identity")
    parsed = uuid.UUID(value)
    if parsed.version != 4 or str(parsed) != value.lower():
        raise ValueError("Native gateway identities must be canonical UUID v4 values")
    return str(parsed)


def local_identity(value):
    # UUID().uuidString is uppercase in Swift. The app compares local IDs
    # case-sensitively, so validate them without changing their stored spelling.
    canonical_uuid(value)
    return value


def loopback_endpoint(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("Invalid native loopback endpoint")
    url = urlsplit(value)
    if url.scheme not in ("ws", "wss") or url.username is not None or url.password is not None or url.query or url.fragment or url.path != "/ws/mobile":
        raise ValueError("Invalid native loopback endpoint")
    host = (url.hostname or "").lower()
    try:
        local = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = host == "localhost"
    if not local or (url.port is not None and not 1 <= url.port <= 65535):
        raise ValueError("Native session mapping only accepts loopback gateways")
    return value


def mapping_from_preferences(preferences, bundle_id):
    raw = preferences.get("gateway.profiles.v1")
    if raw is None:
        profiles = []
    elif isinstance(raw, (str, bytes)):
        profiles = json.loads(raw)
    else:
        raise ValueError("Unsupported native gateway profile storage")
    if not isinstance(profiles, list) or len(profiles) > 128:
        raise ValueError("Invalid native gateway profile list")
    result, local_ids, server_ids = [], set(), set()
    for profile in profiles:
        if not isinstance(profile, dict):
            raise ValueError("Invalid native gateway profile")
        local_id = local_identity(profile.get("id"))
        if local_id.lower() in local_ids:
            raise ValueError("Duplicate native gateway profile identity")
        local_ids.add(local_id.lower())
        if profile.get("gatewayId") is None:
            continue
        server_id = canonical_uuid(profile["gatewayId"])
        if server_id in server_ids:
            raise ValueError("Duplicate native server gateway identity")
        server_ids.add(server_id)
        endpoints = profile.get("endpoints")
        if not isinstance(endpoints, list) or not endpoints or len(endpoints) > 16:
            raise ValueError("Invalid native gateway endpoints")
        local_endpoints = []
        for endpoint in endpoints:
            try:
                value = loopback_endpoint(endpoint)
            except ValueError:
                continue
            if value not in local_endpoints:
                local_endpoints.append(value)
        if local_endpoints:
            result.append({"gatewayId": server_id, "localId": local_id, "endpoints": local_endpoints})
    active = preferences.get("gateway.activeID")
    active = local_identity(active) if active is not None else None
    return {"schema": 1, "bundleId": bundle_id, "capturedAt": datetime.now(timezone.utc).isoformat(),
            "activeLocalId": active, "gateways": result}


def preferences_path(bundle_id, root=DATA_ROOT):
    matches = []
    for directory in root.iterdir():
        metadata = directory / ".com.apple.mobile_container_manager.metadata.plist"
        if not metadata.is_file():
            continue
        if plistlib.loads(metadata.read_bytes()).get("MCMMetadataIdentifier") == bundle_id:
            matches.append(directory / "Library/Preferences" / f"{bundle_id}.plist")
    if len(matches) != 1 or not matches[0].is_file():
        raise ValueError("Native preferences are unavailable; install, open and pair the app first")
    return matches[0]


def atomic_mapping(mapping, output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".gateway-map-", dir=output.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(mapping, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def export_mapping(manifest, output=DEFAULT_MAPPING, preferences=None):
    path = Path(preferences) if preferences else preferences_path(manifest["bundleId"])
    mapping = mapping_from_preferences(plistlib.loads(path.read_bytes()), manifest["bundleId"])
    atomic_mapping(mapping, output)
    return mapping


def native_session_url(mapping, session_id, gateway_id=None):
    if not isinstance(mapping, dict) or mapping.get("schema") != 1 or mapping.get("bundleId") != "com.clark.dshmobile.dev":
        raise ValueError("Unsupported native gateway mapping")
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}", session_id):
        raise ValueError("Invalid native session identity")
    active = local_identity(mapping.get("activeLocalId"))
    target = canonical_uuid(gateway_id) if gateway_id else None
    entries = mapping.get("gateways")
    if not isinstance(entries, list) or len(entries) > 128:
        raise ValueError("Invalid native gateway mapping entries")
    choices = []
    seen_local, seen_server = set(), set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Invalid native gateway mapping entry")
        local_id, server_id = local_identity(entry.get("localId")), canonical_uuid(entry.get("gatewayId"))
        if local_id.lower() in seen_local or server_id in seen_server:
            raise ValueError("Ambiguous native gateway mapping")
        seen_local.add(local_id.lower())
        seen_server.add(server_id)
        endpoints = entry.get("endpoints", [])
        if not isinstance(endpoints, list) or not endpoints or len(endpoints) > 16:
            raise ValueError("Missing native loopback endpoint")
        for endpoint in endpoints:
            loopback_endpoint(endpoint)
        if (target is None and local_id == active) or server_id == target:
            choices.append((local_id, server_id))
    if len(choices) != 1:
        raise ValueError("Native app is not paired with this local gateway")
    if choices[0][0] != active:
        raise ValueError("Select this local gateway in the native app before opening its session")
    return "dshmobile://session?" + urlencode({"gateway": choices[0][0], "id": session_id})


def validate_native_url(value, mapping):
    url = urlsplit(value)
    if url.scheme != "dshmobile" or url.netloc != "session" or url.path or url.fragment:
        raise ValueError("Invalid native session URL")
    pairs = parse_qsl(url.query, keep_blank_values=True, strict_parsing=True)
    if len(pairs) != 2 or {key for key, _ in pairs} != {"gateway", "id"}:
        raise ValueError("Invalid native session URL fields")
    values = dict(pairs)
    expected = native_session_url(mapping, values["id"])
    if values["gateway"] != local_identity(mapping.get("activeLocalId")) or value != expected:
        raise ValueError("Native session URL does not target the active local gateway")
    return value


def native_pairing_url(raw, now=None):
    """Validate a real short-lived local gateway capability, never fabricate one."""
    if not isinstance(raw, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,16384}", raw) or len(raw) % 4 == 1:
        raise ValueError("Invalid local pairing payload")
    payload = json.loads(base64.b64decode(raw.translate(str.maketrans("-_", "+/")) + "=" * (-len(raw) % 4), validate=True))
    fields = {"version", "publicUrl", "pairingCode", "expiresAt", "gatewayId", "gatewayName", "endpoints"}
    if not isinstance(payload, dict) or set(payload) - fields or payload.get("version") != 2:
        raise ValueError("Unsupported local pairing payload")
    canonical_uuid(payload.get("gatewayId"))
    code = payload.get("pairingCode")
    if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9._~-]{1,512}", code):
        raise ValueError("Invalid one-time local pairing capability")
    expiry = payload.get("expiresAt")
    now = datetime.now(timezone.utc).timestamp() if now is None else now
    if isinstance(expiry, bool) or not isinstance(expiry, (float, int)) or not math.isfinite(expiry) or not now < expiry / 1000 <= now + 600:
        raise ValueError("Local pairing capability is expired or exceeds its ten-minute bound")
    candidates = payload.get("endpoints") or []
    if not isinstance(candidates, list) or len(candidates) > 16:
        raise ValueError("Invalid local pairing endpoints")
    for value in [payload.get("publicUrl")] + candidates:
        endpoint = urlsplit(loopback_endpoint(value))
        if endpoint.scheme != "ws" or endpoint.hostname != "127.0.0.1" or endpoint.port != 3080:
            raise ValueError("Local pairing only accepts ws://127.0.0.1:3080/ws/mobile")
    return "dshmobile://pair?" + urlencode({"payload": raw})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify-ipa")
    verify.add_argument("archive", type=Path)
    commands.add_parser("installed")
    export = commands.add_parser("export-mapping")
    export.add_argument("--preferences", type=Path)
    export.add_argument("--output", type=Path, default=DEFAULT_MAPPING)
    args = parser.parse_args()
    manifest = read_manifest(args.manifest)
    if args.command == "verify-ipa":
        result = verify_ipa(args.archive, manifest)
    elif args.command == "installed":
        result = installed_app(manifest)
    else:
        result = export_mapping(manifest, args.output, args.preferences)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, plistlib.InvalidFileException) as error:
        raise SystemExit(f"Native client validation failed: {error}")
