"""Regression: a ready HTTP listener can precede its current launch-token log."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("open_device", Path(__file__).resolve().parents[1] / "scripts/open-device.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def response(status, cookie=None):
    result = MagicMock(status=status)
    result.getheader.return_value = cookie
    return result


class OpenDeviceTests(unittest.TestCase):
    def test_startup_rejects_previous_token_and_opens_current_one(self):
        old = "http://127.0.0.1:3080/?token=" + "a" * 43
        current = "http://127.0.0.1:3080/?token=" + "b" * 43
        connection = MagicMock()
        connection.getresponse.side_effect = [response(401), response(303, "session=fixture; HttpOnly"), response(200)]
        with patch.object(module.Path, "read_text", side_effect=[old, current]), \
                patch.object(module.Path, "glob", return_value=[]), \
                patch.object(module.http.client, "HTTPConnection", return_value=connection), \
                patch.object(module.time, "sleep"), \
                patch.object(module.subprocess, "run") as launch:
            module.main()
        self.assertEqual(connection.request.call_args_list[0].args[1], "/?token=" + "a" * 43)
        self.assertEqual(connection.request.call_args_list[1].args[1], "/?token=" + "b" * 43)
        self.assertEqual(launch.call_args_list[-1].args[0][-1], current)

    def test_failed_auth_never_opens_or_rewrites_webclips(self):
        connection = MagicMock()
        connection.getresponse.return_value = response(401)
        with patch.object(module.Path, "read_text", return_value="http://127.0.0.1:3080/?token=" + "a" * 43), \
                patch.object(module.Path, "glob") as clips, \
                patch.object(module.http.client, "HTTPConnection", return_value=connection), \
                patch.object(module.time, "sleep"), \
                patch.object(module.subprocess, "run") as launch:
            with self.assertRaisesRegex(RuntimeError, "did not become ready"):
                module.main()
        clips.assert_not_called()
        launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
