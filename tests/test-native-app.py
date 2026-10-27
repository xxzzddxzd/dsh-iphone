#!/usr/bin/env python3
"""Native release, real profile identity and deep-link boundary regressions."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import stat
import struct
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_client", ROOT / "ios/native/native_client.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

LOCAL = "55AA1D23-4DF8-4E2C-8C5C-42E460611270"
SERVER = "77bb5b20-f46c-4da8-8b73-179d58bf818e"
OTHER = "22222222-2222-4222-8222-222222222222"


def preferences():
    return {"gateway.activeID": LOCAL, "gateway.profiles.v1": json.dumps([
        {"id": LOCAL, "gatewayId": SERVER, "gatewayName": "Phone", "remoteDeviceId": "not-exported",
         "endpoints": ["ws://127.0.0.1:3080/ws/mobile", "wss://private.example/ws/mobile"]}
    ]).encode(), "unrelated-secret": "must-not-export"}


def executable(minimum=(16, 1, 0), platform=2, signed=False):
    encoded = (minimum[0] << 16) | (minimum[1] << 8) | minimum[2]
    command = struct.pack("<IIIIII", 0x32, 24, platform, encoded, 0x1B0100, 0)
    if signed:
        signature = struct.pack(">III", 0xFADE0CC0, 12, 0)
        command += struct.pack("<IIII", 0x1D, 16, 32 + len(command) + 16, len(signature))
    else:
        signature = b""
    return struct.pack("<IiiIIIII", 0xFEEDFACF, 0x0100000C, 0, 2, 2 if signed else 1, len(command), 0, 0) + command + signature


class MappingTests(unittest.TestCase):
    def setUp(self):
        self.mapping = native.mapping_from_preferences(preferences(), "com.clark.dshmobile.dev")

    def test_exports_only_paired_loopback_metadata_and_preserves_swift_uuid_case(self):
        self.assertEqual(self.mapping["activeLocalId"], LOCAL)
        self.assertEqual(self.mapping["gateways"], [{"gatewayId": SERVER, "localId": LOCAL,
                         "endpoints": ["ws://127.0.0.1:3080/ws/mobile"]}])
        self.assertNotIn("must-not-export", json.dumps(self.mapping))
        self.assertNotIn("not-exported", json.dumps(self.mapping))

    def test_server_identity_resolves_to_the_real_case_sensitive_local_identity(self):
        url = native.native_session_url(self.mapping, "session-example", SERVER)
        self.assertEqual(parse_qs(urlsplit(url).query)["gateway"], [LOCAL])
        self.assertEqual(native.validate_native_url(url, self.mapping), url)

    def test_refuses_inactive_profile_instead_of_silently_opening_wrong_host(self):
        self.mapping["activeLocalId"] = OTHER
        with self.assertRaisesRegex(ValueError, "Select this local gateway"):
            native.native_session_url(self.mapping, "session-example", SERVER)

    def test_refuses_missing_pairing_and_unknown_servers(self):
        with self.assertRaises(ValueError):
            native.native_session_url(self.mapping, "session-example", OTHER)
        self.assertEqual(native.mapping_from_preferences({}, "com.clark.dshmobile.dev")["gateways"], [])

    def test_refuses_injected_session_and_url_fields(self):
        for session in ["../data", "x&gateway=evil", "", "x\n", "x/other", "x" * 257]:
            with self.subTest(session=session), self.assertRaises(ValueError):
                native.native_session_url(self.mapping, session)
        valid = native.native_session_url(self.mapping, "session-example")
        bad = [valid.replace("dshmobile://session", "https://session"), valid + "&id=other",
               valid + "&token=secret", valid + "#extra", valid.replace("session?", "session/path?"),
               valid.replace(LOCAL, LOCAL.lower())]
        for url in bad:
            with self.subTest(url=url), self.assertRaises(ValueError):
                native.validate_native_url(url, self.mapping)

    def test_refuses_host_credentials_queries_and_non_loopback_routes(self):
        for endpoint in ["ws://192.168.1.5:3080/ws/mobile", "ws://127.0.0.1:3080/api/remote.mux",
                         "ws://user:pass@127.0.0.1/ws/mobile", "ws://127.0.0.1/ws/mobile?token=x",
                         "ws://0.0.0.0/ws/mobile", "file:///ws/mobile", "ws://127.0.0.1:99999/ws/mobile"]:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                native.loopback_endpoint(endpoint)

    def test_duplicate_profile_or_server_identity_is_not_guessed(self):
        p = preferences()
        profiles = json.loads(p["gateway.profiles.v1"])
        profiles.append({**profiles[0], "id": LOCAL.lower()})
        p["gateway.profiles.v1"] = json.dumps(profiles).encode()
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            native.mapping_from_preferences(p, "com.clark.dshmobile.dev")

    def test_mapping_is_atomic_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "state/map.json"
            native.atomic_mapping(self.mapping, target)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(json.loads(target.read_text()), self.mapping)
            self.assertEqual(list(target.parent.glob(".gateway-map-*")), [])

    def test_local_pairing_link_uses_real_fresh_capability_only_for_own_service(self):
        payload = {"version": 2, "publicUrl": "ws://127.0.0.1:3080/ws/mobile", "pairingCode": "one-time-capability",
                   "expiresAt": 1_300_000, "gatewayId": SERVER}
        def encode(value):
            return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
        raw = encode(payload)
        link = native.native_pairing_url(raw, now=1000)
        self.assertEqual(parse_qs(urlsplit(link).query), {"payload": [raw]})
        for bad in [{**payload, "publicUrl": "ws://192.168.1.10:3080/ws/mobile"},
                    {**payload, "endpoints": ["wss://remote.example/ws/mobile"]},
                    {**payload, "expiresAt": 999_000}, {**payload, "expiresAt": 1_601_000},
                    {**payload, "pairingCode": "bad,token"}, {**payload, "gatewayId": "unknown"},
                    {**payload, "token": "not-a-pairing-payload"}]:
            with self.subTest(payload=bad), self.assertRaises(ValueError):
                native.native_pairing_url(encode(bad), now=1000)


class ArtifactTests(unittest.TestCase):
    def make_archive(self, directory, alter=None, minimum=(16, 1, 0), extra=None):
        manifest = native.read_manifest()
        root = "Payload/" + manifest["appDirectory"]
        widget = root + "/PlugIns/" + manifest["widgetDirectory"]
        app = {"CFBundleIdentifier": manifest["bundleId"], "CFBundleExecutable": manifest["executable"],
               "CFBundleShortVersionString": manifest["version"], "CFBundleVersion": manifest["build"],
               "MinimumOSVersion": manifest["minimumOS"]}
        if alter:
            app.update(alter)
        extension = {**app, "CFBundleIdentifier": manifest["widgetBundleId"],
                     "CFBundleExecutable": manifest["widgetExecutable"],
                     "NSExtension": {"NSExtensionPointIdentifier": "com.apple.widgetkit-extension"}}
        path = Path(directory) / "app.ipa"
        with zipfile.ZipFile(path, "w") as archive:
            for name, content in [(root + "/Info.plist", plistlib.dumps(app)),
                                  (root + "/" + manifest["executable"], executable(minimum)),
                                  (widget + "/Info.plist", plistlib.dumps(extension)),
                                  (widget + "/" + manifest["widgetExecutable"], executable(minimum))]:
                archive.writestr(name, content)
            if extra:
                archive.writestr(extra, b"unexpected")
        manifest["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        return path, manifest

    def test_verified_archive_covers_main_and_widget(self):
        with tempfile.TemporaryDirectory() as directory:
            path, manifest = self.make_archive(directory)
            self.assertEqual(native.verify_ipa(path, manifest)["status"], "verified")

    def test_archive_hash_is_mandatory(self):
        with tempfile.TemporaryDirectory() as directory:
            path, manifest = self.make_archive(directory)
            manifest["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                native.verify_ipa(path, manifest)

    def test_plist_identity_and_real_macho_minimum_must_match(self):
        with tempfile.TemporaryDirectory() as directory:
            path, manifest = self.make_archive(directory, alter={"CFBundleIdentifier": "other.app"})
            with self.assertRaisesRegex(ValueError, "identity"):
                native.verify_ipa(path, manifest)
            path, manifest = self.make_archive(directory, minimum=(17, 0, 0))
            with self.assertRaisesRegex(ValueError, "Mach-O"):
                native.verify_ipa(path, manifest)

    def test_archive_paths_and_platform_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            path, manifest = self.make_archive(directory, extra="Payload/../outside")
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                native.verify_ipa(path, manifest)
        with self.assertRaisesRegex(ValueError, "iPhoneOS"):
            native.macho_ios_version(executable(platform=7))

    def test_installed_app_is_idempotent_and_refuses_downgrades(self):
        with tempfile.TemporaryDirectory() as directory:
            path, manifest = self.make_archive(directory)
            with zipfile.ZipFile(path) as archive:
                archive.extractall(directory)
            root = Path(directory) / "Payload"
            app = root / manifest["appDirectory"]
            with self.assertRaisesRegex(ValueError, "code signature"):
                native.installed_app(manifest, [root])
            (app / manifest["executable"]).write_bytes(executable(signed=True))
            (app / "PlugIns" / manifest["widgetDirectory"] / manifest["widgetExecutable"]).write_bytes(executable(signed=True))
            self.assertEqual(native.installed_app(manifest, [root])["status"], "current")
            info_path = root / manifest["appDirectory"] / "Info.plist"
            info = plistlib.loads(info_path.read_bytes())
            info["CFBundleShortVersionString"] = "99.0.0"
            info_path.write_bytes(plistlib.dumps(info))
            with self.assertRaisesRegex(ValueError, "downgrade"):
                native.installed_app(manifest, [root])


if __name__ == "__main__":
    unittest.main()
