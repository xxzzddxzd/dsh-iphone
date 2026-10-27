# Read-only App lifecycle snapshot

`SBSCopyFrontmostApplicationDisplayIdentifier` and the old SpringBoard MIG wrapper returned an empty identifier on this iOS 16.1.1 phone even while an App was visible. Symbol presence is therefore not evidence that the query works.

The replacement reads each live embedded App's `RBSProcessHandle.currentState.endowmentNamespaces`. The `com.apple.frontboard.visibility` namespace is the visibility test used by [Apple WebKit's EndowmentStateTracker](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/EndowmentStateTracker.mm); process lookup uses the [WebKit RunningBoard SPI declarations](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/Platform/spi/Cocoa/RunningBoardServicesSPI.h). A missing state is reported as `visible: null`, never inferred to be background. `stateAvailable` requires an actual returned namespace set, not only a loaded symbol.

Lock state is read independently with `notify_register_check` / `notify_get_state` for `com.apple.springboard.lockstate` (`0` unlocked, nonzero locked). This is a private diagnostic interface, not an App API. The probe keeps the root identity for process enumeration and uses a research-only `com.apple.runningboard.process-state` entitlement; no ActivityKit, SessionKit, App launch, assertion acquisition, or termination privileges are requested.

Output contains only App bundle identifiers, PIDs, visibility, lock state and query-availability flags. It does not read preferences, sessions, URLs, Keychain, activity content or credentials. It does not start/stop Apps, alter lock state, register plug-ins, restart services, or create/update/end Activities.

Capture a snapshot before and after a separate lifecycle operation. A visible App retaining its PID and `visible: true` shows it remained visible; visibility and process survival are separate checks. If more than one process is visible, retain the rows rather than guessing a single frontmost App. Confirm lock/unlock readings against the phone before treating them as acceptance evidence.
