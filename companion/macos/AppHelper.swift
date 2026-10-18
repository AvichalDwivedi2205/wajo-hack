import AppKit
import Foundation
import Security

// No scripts, file/URL opening, arbitrary bundle IDs, playback or process termination.
let catalog = ["spotify": ("Spotify", "com.spotify.client"), "music": ("Music", "com.apple.Music"), "calculator": ("Calculator", "com.apple.calculator")]
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
guard CommandLine.arguments.count >= 3,
      ["inspect", "open"].contains(CommandLine.arguments[1]),
      let app = catalog[CommandLine.arguments[2]] else { fail("Unsupported app helper request.") }
guard CommandLine.arguments.count == (CommandLine.arguments[1] == "open" ? 4 : 3) else { fail("Invalid fixed helper arguments.") }
let id = CommandLine.arguments[2]
let workspace = NSWorkspace.shared
func location() -> URL? {
    guard let url = workspace.urlForApplication(withBundleIdentifier: app.1)?.resolvingSymlinksInPath(),
          let bundle = Bundle(url: url), bundle.bundleIdentifier == app.1,
          FileManager.default.fileExists(atPath: url.path) else { return nil }
    return url
}
func identity(_ url: URL) -> String {
    var code: SecStaticCode?
    var requirement: SecRequirement?
    let rule = id == "spotify"
        ? "anchor apple generic and identifier \"com.spotify.client\" and certificate leaf[subject.OU] = \"2FNC3A47ZF\""
        : "anchor apple and identifier \"\(app.1)\""
    guard SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess else { fail("App signature rule unavailable.") }
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
          SecStaticCodeCheckValidity(code, [], requirement) == errSecSuccess else { fail("The installed app signature is invalid.") }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let dictionary = info as? [String: Any],
          let digest = dictionary[kSecCodeInfoUnique as String] as? Data else { fail("App signing identity unavailable.") }
    return url.path + "#" + digest.map { String(format: "%02x", $0) }.joined()
}
func fact() -> [String: Any] {
    let url = location()
    let installedIdentity = url.map(identity) ?? ""
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: app.1)
        .first { candidate in
            guard !candidate.isTerminated, candidate.bundleURL?.resolvingSymlinksInPath() == url else { return false }
            var guest: SecCode?
            let attributes = [kSecGuestAttributePid as String: NSNumber(value: candidate.processIdentifier)] as CFDictionary
            guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess, let guest else { return false }
            guard let expectedHash = installedIdentity.split(separator: "#").last else { return false }
            var runningRequirement: SecRequirement?
            guard SecRequirementCreateWithString("cdhash H\"\(expectedHash)\"" as CFString, [], &runningRequirement) == errSecSuccess,
                  let runningRequirement else { return false }
            return SecCodeCheckValidity(guest, [], runningRequirement) == errSecSuccess
        }
    return ["id": id, "name": app.0, "bundleId": app.1, "installed": url != nil,
            "identity": installedIdentity, "running": running != nil,
            "active": running?.isActive ?? false]
}
if CommandLine.arguments[1] == "open" {
    guard let url = location() else { fail("The supported app is not installed.") }
    guard identity(url) == CommandLine.arguments[3] else { fail("Installed app changed after approval.") }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.createsNewApplicationInstance = false
    configuration.promptsUserIfNeeded = false
    var finished = false
    var failed = false
    workspace.openApplication(at: url, configuration: configuration) { running, error in
        DispatchQueue.main.async { failed = error != nil || running == nil; finished = true }
    }
    let deadline = Date().addingTimeInterval(10)
    while !finished && Date() < deadline { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
    if !finished || failed { fail("macOS did not complete opening the supported app.") }
    while Date() < deadline && !(fact()["active"] as? Bool ?? false) {
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
}
let data = try JSONSerialization.data(withJSONObject: fact(), options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
