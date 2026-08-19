import Darwin
import Foundation

private let activityKitTracePath = "/var/mobile/Library/DSHNotifier/activitykit-xpc-trace.log"

private func boundedDescription(_ value: Any) -> String {
  let description = String(reflecting: value).replacingOccurrences(of: "\n", with: "\\n")
  return description.count <= 2_048 ? description : String(description.prefix(2_048)) + "…"
}

private func describe(_ value: Any, label: String, depth: Int, lines: inout [String]) {
  let indentation = String(repeating: "  ", count: depth)
  let mirror = Mirror(reflecting: value)
  lines.append(
    "\(indentation)\(label): type=\(String(reflecting: type(of: value))) " +
    "style=\(String(describing: mirror.displayStyle)) value=\(boundedDescription(value))")
  guard depth < 8 else { return }
  for (index, child) in mirror.children.prefix(64).enumerated() {
    describe(
      child.value,
      label: child.label ?? "[\(index)]",
      depth: depth + 1,
      lines: &lines)
  }
}

private func appendTrace(_ text: String) {
  let descriptor = Darwin.open(activityKitTracePath, O_WRONLY | O_CREAT | O_APPEND, 0o600)
  guard descriptor >= 0 else { return }
  defer { Darwin.close(descriptor) }
  let data = Data(text.utf8)
  data.withUnsafeBytes { bytes in
    guard let base = bytes.baseAddress else { return }
    var written = 0
    while written < data.count {
      let count = Darwin.write(descriptor, base.advanced(by: written), data.count - written)
      if count < 0 && errno == EINTR { continue }
      if count <= 0 { return }
      written += count
    }
  }
}

@_cdecl("DSHTraceSwiftObject")
func traceSwiftObject(_ pointer: UnsafeRawPointer?) {
  guard let pointer else { return }
  let object = Unmanaged<AnyObject>.fromOpaque(pointer).takeUnretainedValue()
  var lines = [
    "--- ActivityKit request \(Date()) pid=\(getpid()) bundle=\(Bundle.main.bundleIdentifier ?? "(nil)") ---"
  ]
  describe(object, label: "request", depth: 0, lines: &lines)
  lines.append("--- end request ---")
  appendTrace(lines.joined(separator: "\n") + "\n")
}
