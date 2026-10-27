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
from unittest import mock
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


def widget_entitlements():
    bundle_id = "com.clark.dshmobile.dev.AgentLiveActivityWidget"
    return {"application-identifier": "TROLLTROLL." + bundle_id,
            "com.apple.developer.team-identifier": "TROLLTROLL",
            "com.apple.private.security.container-required": bundle_id}


def signature_blob(entries):
    """Build independent code-signature fixtures; no production signing tool."""
    index, blobs = b"", b""
    for slot, magic, payload in entries:
        index += struct.pack(">II", slot, 12 + 8 * len(entries) + len(blobs))
        blobs += struct.pack(">II", magic, 8 + len(payload)) + payload
    return struct.pack(">III", 0xFADE0CC0, 12 + len(index) + len(blobs), len(entries)) + index + blobs


def executable(minimum=(16, 1, 0), platform=2, signed=False, entitlements=None, signature=None):
    encoded = (minimum[0] << 16) | (minimum[1] << 8) | minimum[2]
    command = struct.pack("<IIIIII", 0x32, 24, platform, encoded, 0x1B0100, 0)
    if entitlements is not None:
        signature = signature_blob([(5, 0xFADE7171, plistlib.dumps(entitlements))])
    if signature is not None:
        signed = True
    if signed:
        signature = signature if signature is not None else struct.pack(">III", 0xFADE0CC0, 12, 0)
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
    def make_archive(self, directory, alter=None, minimum=(16, 1, 0), extra=None,
                     capable=False, widget_binary=None):
        manifest = native.read_manifest()
        if capable:
            manifest = {**manifest, "build": "36", "capabilities": [native.ACTIVITY_SUPPORT_CAPABILITY]}
        if widget_binary is None:
            widget_binary = executable(minimum, entitlements=widget_entitlements()) if capable else executable(minimum)
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
                                  (widget + "/" + manifest["widgetExecutable"], widget_binary)]:
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


    def test_capable_ipa_requires_only_the_three_reviewed_widget_identities(self):
        with tempfile.TemporaryDirectory() as directory:
            path, manifest = self.make_archive(directory, capable=True)
            self.assertEqual(native.verify_ipa(path, manifest)["status"], "verified")
            # No platform, no-sandbox or Keychain privileges are required.
            self.assertEqual(set(widget_entitlements()), {
                "application-identifier", "com.apple.developer.team-identifier",
                "com.apple.private.security.container-required"})

    def test_capable_ipa_rejects_missing_or_wrong_widget_identity_fields(self):
        expected = widget_entitlements()
        cases = []
        for key in expected:
            cases.append({k: v for k, v in expected.items() if k != key})
            cases.append({**expected, key: "other.identity"})
            cases.append({**expected, key: True})
        for entitlements in cases:
            with self.subTest(entitlements=entitlements), tempfile.TemporaryDirectory() as directory:
                path, manifest = self.make_archive(directory, capable=True,
                    widget_binary=executable(entitlements=entitlements))
                with self.assertRaisesRegex(ValueError, "entitlements.*identity"):
                    native.verify_ipa(path, manifest)

    def test_capable_ipa_rejects_unsigned_or_xml_less_widget(self):
        for binary in [executable(), executable(signed=True),
                       executable(signature=signature_blob([(7, 0xFADE7172, b"DER-only")]))]:
            with self.subTest(binary=binary), tempfile.TemporaryDirectory() as directory:
                path, manifest = self.make_archive(directory, capable=True, widget_binary=binary)
                with self.assertRaisesRegex(ValueError, "entitlements"):
                    native.verify_ipa(path, manifest)


class SignatureEntitlementTests(unittest.TestCase):
    def test_xml_and_der_slots_and_superblob_padding_match_ldid_shape(self):
        expected = widget_entitlements()
        signature = signature_blob([(0, 0xFADE0C02, b"code-directory"),
                                    (5, 0xFADE7171, plistlib.dumps(expected)),
                                    (7, 0xFADE7172, b"DER-from-the-same-ldid-input")]) + b"\0" * 5
        self.assertEqual(native.macho_xml_entitlements(executable(signature=signature)), expected)

    def test_malformed_xml_and_non_dictionary_entitlements_are_rejected(self):
        for payload in [b"not a plist", b"<?xml version='1.0'?><plist><dict>",
                        plistlib.dumps(["not-a-dictionary"]),
                        plistlib.dumps(widget_entitlements(), fmt=plistlib.FMT_BINARY)]:
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, "entitlements"):
                native.macho_xml_entitlements(executable(signature=signature_blob([(5, 0xFADE7171, payload)])))

    def test_wrong_magic_duplicate_slots_and_overlapping_blobs_are_rejected(self):
        payload = plistlib.dumps(widget_entitlements())
        duplicate = signature_blob([(5, 0xFADE7171, payload), (5, 0xFADE7171, payload)])
        overlap = bytearray(signature_blob([(5, 0xFADE7171, payload), (7, 0xFADE7172, b"der")]))
        struct.pack_into(">I", overlap, 24, struct.unpack_from(">I", overlap, 16)[0])
        for signature in [signature_blob([(5, 0xFADE7172, payload)]), duplicate, bytes(overlap)]:
            with self.subTest(signature=signature), self.assertRaisesRegex(ValueError, "Widget"):
                native.macho_xml_entitlements(executable(signature=signature))

    def test_signature_bounds_do_not_use_padding_or_escape_the_blob(self):
        good = signature_blob([(5, 0xFADE7171, plistlib.dumps(widget_entitlements()))])
        malformed = []
        for offset, value in [(0, 0), (4, len(good) + 1), (4, 11),
                              (8, 0xFFFFFFFF), (16, 12), (16, len(good) - 4),
                              (24, 7), (24, len(good))]:
            signature = bytearray(good)
            struct.pack_into(">I", signature, offset, value)
            malformed.append(bytes(signature))
        # A blob in LC_CODE_SIGNATURE padding is outside the declared SuperBlob.
        malformed.append(struct.pack(">IIIII", 0xFADE0CC0, 20, 1, 5, 20) + good[20:])
        for signature in malformed:
            with self.subTest(signature=signature), self.assertRaisesRegex(ValueError, "Widget"):
                native.macho_xml_entitlements(executable(signature=signature))

    def test_duplicate_or_invalid_signature_load_commands_are_rejected(self):
        binary = bytearray(executable(entitlements=widget_entitlements()))
        # Duplicate the command without aliasing any entitlement fixture buffers.
        signature = bytes(binary[72:])
        command = bytes(binary[56:72])
        duplicate = bytearray(binary[:72] + command + signature)
        struct.pack_into("<II", duplicate, 16, 3, 56)
        struct.pack_into("<I", duplicate, 64, 88)
        struct.pack_into("<I", duplicate, 80, 88)
        with self.assertRaisesRegex(ValueError, "one code signature"):
            native.macho_xml_entitlements(bytes(duplicate))
        for offset, value in [(64, 32), (68, len(binary))]:
            malformed = bytearray(binary)
            struct.pack_into("<I", malformed, offset, value)
            with self.subTest(offset=offset), self.assertRaisesRegex(ValueError, "bounds"):
                native.macho_xml_entitlements(bytes(malformed))


class WidgetSetupTests(unittest.TestCase):
    def fixture(self, root, permissions=None):
        helper, entitlements = root / "DSHWidgetSetup", root / "DSHWidgetSetup.entitlements"
        helper.write_bytes(b"independent-reviewed-helper-fixture")
        if permissions is None:
            permissions = {"platform-application": True, "com.apple.private.security.no-sandbox": True,
                           "com.apple.chronoservices": True, "com.apple.chronod.toolservices": True}
        entitlements.write_bytes(plistlib.dumps(permissions))
        manifest = {**native.read_manifest(), "capabilities": [native.ACTIVITY_SUPPORT_CAPABILITY],
                    "helperSHA256": hashlib.sha256(helper.read_bytes()).hexdigest(),
                    "helperEntitlementsSHA256": hashlib.sha256(entitlements.read_bytes()).hexdigest()}
        return helper, entitlements, manifest

    def test_exact_pinned_setup_artifacts_and_stock_release_without_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helper, entitlements, manifest = self.fixture(root)
            self.assertEqual(native.verify_widget_setup(helper, entitlements, manifest), {
                "status": "verified", "helperSHA256": manifest["helperSHA256"],
                "helperEntitlementsSHA256": manifest["helperEntitlementsSHA256"]})
            self.assertEqual(native.verify_widget_setup(root / "missing", root / "missing-ents", native.read_manifest()),
                             {"status": "not-required"})

    def test_setup_manifest_requires_both_exact_sha256_pins(self):
        with tempfile.TemporaryDirectory() as directory:
            helper, entitlements, manifest = self.fixture(Path(directory))
            for field in ["helperSHA256", "helperEntitlementsSHA256"]:
                for value in [None, "", "0" * 63, "G" * 64, 1]:
                    with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, "manifest requires"):
                        native.verify_widget_setup(helper, entitlements, {**manifest, field: value})
            for path in [helper, entitlements]:
                original = path.read_bytes()
                path.write_bytes(original + b"altered")
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, "SHA-256 differs"):
                    native.verify_widget_setup(helper, entitlements, manifest)
                path.write_bytes(original)

    def test_setup_permissions_reject_missing_extra_non_bool_and_malformed_values(self):
        expected = {"platform-application": True, "com.apple.private.security.no-sandbox": True,
                    "com.apple.chronoservices": True, "com.apple.chronod.toolservices": True}
        invalid = [{k: v for k, v in expected.items() if k != "com.apple.chronod.toolservices"},
                   {**expected, "keychain-access-groups": ["should-not-be-here"]},
                   {**expected, "platform-application": 1}, {**expected, "com.apple.chronoservices": False}, []]
        for permissions in invalid:
            with self.subTest(permissions=permissions), tempfile.TemporaryDirectory() as directory:
                helper, entitlements, manifest = self.fixture(Path(directory), permissions)
                with self.assertRaisesRegex(ValueError, "exactly its four reviewed"):
                    native.verify_widget_setup(helper, entitlements, manifest)
        with tempfile.TemporaryDirectory() as directory:
            helper, entitlements, manifest = self.fixture(Path(directory))
            entitlements.write_bytes(b"<?xml version='1.0'?><plist><dict>")
            manifest["helperEntitlementsSHA256"] = hashlib.sha256(entitlements.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, "Malformed.*entitlements"):
                native.verify_widget_setup(helper, entitlements, manifest)


class ActivitySupportTests(unittest.TestCase):
    def manifest(self):
        return {**native.read_manifest(), "build": "35",
                "capabilities": [native.ACTIVITY_SUPPORT_CAPABILITY],
                "accessToken": "must-not-export", "unrelated": "must-not-export"}

    def install(self, root, manifest, app_signed=True, widget_signed=True):
        app = root / manifest["appDirectory"]
        widget = app / "PlugIns" / manifest["widgetDirectory"]
        widget.mkdir(parents=True)
        info = {"CFBundleIdentifier": manifest["bundleId"], "CFBundleExecutable": manifest["executable"],
                "CFBundleShortVersionString": manifest["version"], "CFBundleVersion": manifest["build"],
                "MinimumOSVersion": manifest["minimumOS"]}
        (app / "Info.plist").write_bytes(plistlib.dumps(info))
        (app / manifest["executable"]).write_bytes(executable(signed=app_signed))
        info = {**info, "CFBundleIdentifier": manifest["widgetBundleId"],
                "CFBundleExecutable": manifest["widgetExecutable"],
                "NSExtension": {"NSExtensionPointIdentifier": "com.apple.widgetkit-extension"}}
        (widget / "Info.plist").write_bytes(plistlib.dumps(info))
        (widget / manifest["widgetExecutable"]).write_bytes(executable(signed=widget_signed,
            entitlements=widget_entitlements() if widget_signed else None))
        return app

    def owned(self):
        return {"schema": 1, "managedBy": native.ACTIVITY_SUPPORT_OWNER,
                "bundleId": "com.clark.dshmobile.dev"}

    def test_publishes_only_exact_signed_installed_identity_atomically_and_privately(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "apps"
            manifest = self.manifest()
            app = self.install(root, manifest)
            output = Path(directory) / "private/activity-widget.json"
            report = native.publish_activity_support(manifest, output, [root])
            self.assertEqual(report["status"], "published")
            self.assertEqual(json.loads(output.read_text()), {
                "schema": 1, "managedBy": "dsh-iphone/native-client",
                "bundleId": manifest["bundleId"], "version": manifest["version"], "build": "35",
                "bundlePath": str(app), "attributesType": "DSHActivityAttributes", "widgetKind": "DSHRootActivityWidget"})
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(output.parent.stat().st_mode), 0o700)
            self.assertNotIn("must-not-export", output.read_text())
            self.assertEqual(list(output.parent.glob(".activity-widget-*")), [])
            # A repeated install is safe and keeps the same descriptor.
            previous = output.read_text()
            native.publish_activity_support(manifest, output, [root])
            self.assertEqual(output.read_text(), previous)

    def test_unsigned_main_or_widget_cannot_authorize_native_target(self):
        for app_signed, widget_signed in [(False, True), (True, False)]:
            with self.subTest(app_signed=app_signed, widget_signed=widget_signed), tempfile.TemporaryDirectory() as directory:
                root, output = Path(directory) / "apps", Path(directory) / "activity-widget.json"
                manifest = self.manifest()
                self.install(root, manifest, app_signed, widget_signed)
                output.write_text(json.dumps(self.owned()))
                with self.assertRaisesRegex(ValueError, "code signature"):
                    native.publish_activity_support(manifest, output, [root])
                self.assertFalse(output.exists(), "failed signing must leave the broker on its legacy target")

    def test_installed_widget_identity_failure_removes_only_owned_support_records(self):
        expected = widget_entitlements()
        invalid = [None, {}, {**expected, "application-identifier": "TROLLTROLL.other.app"},
                   {**expected, "com.apple.developer.team-identifier": "OTHERTEAM"},
                   {**expected, "com.apple.private.security.container-required": True},
                   {**expected, "com.apple.private.security.container-required": "other.container"}]
        for entitlements in invalid:
            with self.subTest(entitlements=entitlements), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest = self.manifest()
                app = self.install(root / "apps", manifest)
                widget = app / "PlugIns" / manifest["widgetDirectory"] / manifest["widgetExecutable"]
                widget.write_bytes(executable(signed=True, entitlements=entitlements))
                private, mirror = root / "private/activity-widget.json", root / "public/activity-widget.json"
                private.parent.mkdir()
                mirror.parent.mkdir()
                private.write_text(json.dumps(self.owned()))
                mirror.write_text(json.dumps(self.owned()))
                mapping = private.parent / "gateway-map.json"
                mapping.write_text("existing paired profile")
                with self.assertRaisesRegex(ValueError, "entitlements"):
                    native.installed_app(manifest, [root / "apps"])
                with self.assertRaisesRegex(ValueError, "entitlements"):
                    native.publish_activity_support(manifest, private, [root / "apps"], mirror)
                self.assertFalse(private.exists())
                self.assertFalse(mirror.exists())
                self.assertEqual(mapping.read_text(), "existing paired profile")

    def test_missing_or_wrong_build_removes_only_owned_authorization(self):
        with tempfile.TemporaryDirectory() as directory:
            root, output = Path(directory) / "apps", Path(directory) / "activity-widget.json"
            root.mkdir()
            manifest = self.manifest()
            for current in [None, "34"]:
                if current:
                    self.install(root, {**manifest, "build": current})
                output.write_text(json.dumps(self.owned()))
                with self.assertRaisesRegex(ValueError, "exact native App"):
                    native.publish_activity_support(manifest, output, [root])
                self.assertFalse(output.exists())

    def test_stock_release_cleans_owned_marker_but_preserves_mapping_and_preferences(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "activity-widget.json"
            mapping, preferences_file = root / "gateway-map.json", root / "preferences.plist"
            mapping.write_text("mapping remains")
            preferences_file.write_bytes(plistlib.dumps(preferences()))
            original_preferences = preferences_file.read_bytes()
            output.write_text(json.dumps(self.owned()))
            result = native.publish_activity_support(native.read_manifest(), output, [])
            self.assertEqual(result, {"status": "unsupported", "published": False, "removedOwnedMarker": True})
            self.assertFalse(output.exists())
            self.assertEqual(mapping.read_text(), "mapping remains")
            self.assertEqual(preferences_file.read_bytes(), original_preferences)
            self.assertFalse(native.publish_activity_support(native.read_manifest(), output, [])["published"])

    def test_foreign_malformed_or_future_marker_is_never_overwritten_or_removed(self):
        cases = [{"schema": 1, "managedBy": "another-tool", "bundleId": "com.clark.dshmobile.dev"},
                 {**self.owned(), "schema": 2}, {**self.owned(), "bundleId": "other.app"}, "not json"]
        for value in cases:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "activity-widget.json"
                output.write_text(value if isinstance(value, str) else json.dumps(value))
                before = output.read_bytes()
                for manifest in [native.read_manifest(), self.manifest()]:
                    with self.assertRaisesRegex(ValueError, "not owned"):
                        native.publish_activity_support(manifest, output, [])
                    self.assertEqual(output.read_bytes(), before)

    def test_symlink_marker_is_rejected_without_touching_its_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target, output = Path(directory) / "foreign.json", Path(directory) / "activity-widget.json"
            target.write_text(json.dumps(self.owned()))
            output.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "symbolic link"):
                native.publish_activity_support(native.read_manifest(), output, [])
            self.assertTrue(output.is_symlink())
            self.assertEqual(json.loads(target.read_text()), self.owned())

    def test_capability_does_not_turn_old_or_wrong_bundle_into_supported_widget(self):
        for value in [{**self.manifest(), "build": "34"}, {**self.manifest(), "bundleId": "other.app"},
                      {**self.manifest(), "capabilities": native.ACTIVITY_SUPPORT_CAPABILITY}]:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "activity-widget.json"
                with self.assertRaises(ValueError):
                    native.publish_activity_support(value, output, [])
                self.assertFalse(output.exists())


    def test_public_broker_mirror_matches_private_metadata_without_exposing_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.manifest()
            self.install(root / "apps", manifest)
            private, mirror = root / "private/activity-widget.json", root / "public/activity-widget.json"
            # Tests run as the desktop user. Only the privileged ownership
            # syscalls are mocked; paths, modes and atomic writes are real.
            with mock.patch.object(native.os, "chown") as chown, mock.patch.object(native.os, "fchown") as fchown:
                result = native.publish_activity_support(manifest, private, [root / "apps"], mirror)
            self.assertTrue(result["brokerMirrorPublished"])
            self.assertEqual(private.read_bytes(), mirror.read_bytes())
            self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(private.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(mirror.stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE(mirror.parent.stat().st_mode), 0o755)
            chown.assert_called_once_with(mirror.parent, 0, 0)
            self.assertEqual(fchown.call_count, 1)
            self.assertEqual(fchown.call_args.args[1:], (0, 0))
            self.assertNotIn("must-not-export", mirror.read_text())
            self.assertEqual(list(mirror.parent.glob(".activity-widget-*")), [])

    def test_unsupported_or_invalid_installation_clears_both_owned_markers_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private, mirror = root / "private/activity-widget.json", root / "public/activity-widget.json"
            private.parent.mkdir()
            mirror.parent.mkdir()
            mapping = private.parent / "gateway-map.json"
            mapping.write_text("paired metadata stays")
            for manifest in [native.read_manifest(), self.manifest()]:
                private.write_text(json.dumps(self.owned()))
                mirror.write_text(json.dumps(self.owned()))
                if manifest.get("capabilities"):
                    with self.assertRaisesRegex(ValueError, "exact native App"):
                        native.publish_activity_support(manifest, private, [], mirror)
                else:
                    result = native.publish_activity_support(manifest, private, [], mirror)
                    self.assertTrue(result["removedOwnedMarker"])
                    self.assertTrue(result["removedOwnedMirror"])
                self.assertFalse(private.exists())
                self.assertFalse(mirror.exists())
                self.assertEqual(mapping.read_text(), "paired metadata stays")

    def test_foreign_mirror_preflight_does_not_mutate_private_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private, mirror = root / "private/activity-widget.json", root / "public/activity-widget.json"
            private.parent.mkdir()
            mirror.parent.mkdir()
            private.write_text(json.dumps(self.owned()))
            mirror.write_text(json.dumps({**self.owned(), "managedBy": "someone-else"}))
            before = (private.read_bytes(), mirror.read_bytes())
            with self.assertRaisesRegex(ValueError, "not owned"):
                native.publish_activity_support(native.read_manifest(), private, [], mirror)
            self.assertEqual((private.read_bytes(), mirror.read_bytes()), before)

    def test_mirror_and_mirror_parent_symlinks_are_rejected(self):
        for link_parent in [False, True]:
            with self.subTest(parent=link_parent), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                private = root / "private/activity-widget.json"
                foreign = root / "foreign"
                foreign.mkdir()
                target = foreign / "activity-widget.json"
                target.write_text(json.dumps(self.owned()))
                public = root / "public"
                if link_parent:
                    public.symlink_to(foreign, target_is_directory=True)
                else:
                    public.mkdir()
                    (public / target.name).symlink_to(target)
                with self.assertRaisesRegex(ValueError, "symbolic link"):
                    native.publish_activity_support(native.read_manifest(), private, [], public / target.name)
                self.assertEqual(json.loads(target.read_text()), self.owned())

    def test_broker_mirror_atomic_failure_preserves_previous_descriptor(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "public/activity-widget.json"
            output.parent.mkdir()
            output.write_text(json.dumps(self.owned()))
            before = output.read_bytes()
            with mock.patch.object(native.os, "chown"), mock.patch.object(native.os, "fchown"), \
                    mock.patch.object(native.os, "replace", side_effect=OSError("replace failed")):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    native._atomic_broker_activity_json({**self.owned(), "build": "35"}, output)
            self.assertEqual(output.read_bytes(), before)
            self.assertEqual(list(output.parent.glob(".activity-widget-*")), [])

    def test_custom_output_does_not_implicitly_write_phone_mirror(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "private/activity-widget.json"
            self.assertIsNone(native._activity_mirror_path(output, None))
            explicit = Path(directory) / "public/activity-widget.json"
            self.assertEqual(native._activity_mirror_path(output, explicit), explicit)
            with mock.patch.object(native.Path, "is_dir", return_value=True):
                self.assertEqual(native._activity_mirror_path(native.DEFAULT_ACTIVITY_SUPPORT, None),
                                 native.DEFAULT_BROKER_ACTIVITY_SUPPORT)
            with mock.patch.object(native.Path, "is_dir", return_value=False):
                self.assertIsNone(native._activity_mirror_path(native.DEFAULT_ACTIVITY_SUPPORT, None))

    def test_private_marker_and_mirror_cannot_share_file_or_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / "activity-widget.json"
            for mirror in [private, private.with_name("mirror.json")]:
                with self.subTest(mirror=mirror), self.assertRaisesRegex(ValueError, "separate directories"):
                    native.publish_activity_support(self.manifest(), private, [], mirror)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_clear_revokes_only_owned_markers_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private, mirror = root / "private/activity-widget.json", root / "public/activity-widget.json"
            private.parent.mkdir()
            mirror.parent.mkdir()
            for marker in [private, mirror]:
                marker.write_text(json.dumps(self.owned()))
            mapping, paired = private.parent / "gateway-map.json", private.parent / "pairing.json"
            mapping.write_text("original mapping")
            paired.write_text("original pairing")
            self.assertEqual(native.clear_activity_support(private, mirror), {
                "status": "cleared", "removedOwnedMarker": True, "removedOwnedMirror": True})
            self.assertEqual(native.clear_activity_support(private, mirror), {
                "status": "cleared", "removedOwnedMarker": False, "removedOwnedMirror": False})
            self.assertEqual(mapping.read_text(), "original mapping")
            self.assertEqual(paired.read_text(), "original pairing")

    def test_clear_revokes_owned_peer_even_when_one_record_is_foreign_or_damaged(self):
        for foreign_side in ["private", "public"]:
            for foreign in ["not-json", {**self.owned(), "managedBy": "another-tool"}, {**self.owned(), "schema": 2}]:
                with self.subTest(side=foreign_side, value=foreign), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    private, mirror = root / "private/activity-widget.json", root / "public/activity-widget.json"
                    private.parent.mkdir()
                    mirror.parent.mkdir()
                    for marker in [private, mirror]:
                        marker.write_text(json.dumps(self.owned()))
                    target = root / foreign_side / "activity-widget.json"
                    target.write_text(foreign if isinstance(foreign, str) else json.dumps(foreign))
                    before = (private.read_bytes(), mirror.read_bytes())
                    with self.assertRaisesRegex(ValueError, "not owned"):
                        native.clear_activity_support(private, mirror)
                    self.assertEqual(target.read_bytes(), before[0 if foreign_side == "private" else 1])
                    self.assertFalse((mirror if foreign_side == "private" else private).exists())

    def test_clear_retains_symbolic_link_record_but_revokes_owned_peer(self):
        for link_parent in [False, True]:
            with self.subTest(parent=link_parent), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                private = root / "private/activity-widget.json"
                private.parent.mkdir()
                private.write_text(json.dumps(self.owned()))
                foreign = root / "foreign"
                foreign.mkdir()
                target = foreign / "activity-widget.json"
                target.write_text(json.dumps(self.owned()))
                public = root / "public"
                if link_parent:
                    public.symlink_to(foreign, target_is_directory=True)
                else:
                    public.mkdir()
                    (public / target.name).symlink_to(target)
                before = (private.read_bytes(), target.read_bytes())
                with self.assertRaisesRegex(ValueError, "symbolic link"):
                    native.clear_activity_support(private, public / target.name)
                    self.assertFalse(private.exists())
                    self.assertEqual(target.read_bytes(), before[1])
                    self.assertTrue(public.is_symlink() if link_parent else (public / target.name).is_symlink())

    def test_clear_reports_all_refusals_and_attempts_public_after_private_unlink_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private, mirror = root / "private/activity-widget.json", root / "public/activity-widget.json"
            for marker in [private, mirror]:
                marker.parent.mkdir()
                marker.write_text(json.dumps(self.owned()))
            unlink = Path.unlink

            def restricted_unlink(path, *args, **kwargs):
                if path == private:
                    raise PermissionError("synthetic private unlink refusal")
                return unlink(path, *args, **kwargs)

            with mock.patch.object(Path, "unlink", restricted_unlink), \
                    self.assertRaisesRegex(ValueError, "private marker: synthetic private unlink refusal"):
                native.clear_activity_support(private, mirror)
            self.assertTrue(private.exists())
            self.assertFalse(mirror.exists(), "private unlink failure must not preserve public authorization")
            private.write_text("damaged-private")
            mirror.write_text("damaged-public")
            with self.assertRaises(ValueError) as failure:
                native.clear_activity_support(private, mirror)
            self.assertIn("private marker:", str(failure.exception))
            self.assertIn("public mirror:", str(failure.exception))
            self.assertEqual(private.read_text(), "damaged-private")
            self.assertEqual(mirror.read_text(), "damaged-public")

    def test_clear_cli_does_not_require_a_manifest_or_touch_default_phone_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "private/activity-widget.json"
            output.parent.mkdir()
            output.write_text(json.dumps(self.owned()))
            with mock.patch("sys.argv", ["native_client.py", "--manifest", str(root / "missing-manifest.json"),
                                         "clear-activity-support", "--output", str(output)]), \
                    mock.patch("builtins.print") as printed:
                native.main()
            self.assertEqual(json.loads(printed.call_args.args[0]), {"status": "cleared", "removedOwnedMarker": True})
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
