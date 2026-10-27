# iPhone JavaScriptCore token-rule gate

Run after building the iPhone runtime, with the target phone reachable by SSH:

```bash
DEVICE_HOST=10.99.1.139 DEVICE_PORT=22 \
  scripts/check-ios-web-token-rules.sh --runtime build/dsh-runtime
```

The script validates the device parameters and three fixed UTF-8 client files
before a device write. It compiles a temporary arm64/iOS16.1 command, copies
only `skill`, `reference` and `goal` bundles into a unique private research
directory, signs with the adjacent two research entitlements and evaluates them
in the phone's actual JavaScriptCore. It removes its temporary files afterward.
It does not install packages, restart Node or SpringBoard, open a browser,
change website data, or access account/session/Keychain state.

Each bundle gets a fresh context containing only a
`window.__ModuleLoader__.load` recorder. Factories are never executed. Success
requires exactly one registration with the expected module id and a factory
function, with no uncaught parser/evaluation exception. A failure exits nonzero.
Only fixed module names, registration counts and parser error type/line are
printed; source and exception messages are omitted. `JSC_useJIT=false` and a
20-second process alarm bound the diagnostic. The helper's platform/no-sandbox
permissions are research-only and must not enter the App or Widget.

On iOS16.1.1 the original three bundles failed with `SyntaxError` at their
lookbehind literals before registering any factory. The patched bundles each
registered once. This parser gate complements the production-rule differential
tests; it does not replace UI interaction or whole-page boot verification.
