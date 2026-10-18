// Fo Reach native boundary: three enumerated commands. No shell, microphone,
// file inspection, process management, network controls, or security settings.
import Foundation
import CoreAudio

struct HelperError: Error { let message: String }
struct Device: Codable {
    let id: String
    let name: String
    let transport: String
    let alive: Bool
    let muted: Bool?
    enum CodingKeys: String, CodingKey { case id, name, transport, alive, muted }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(name, forKey: .name)
        try values.encode(transport, forKey: .transport)
        try values.encode(alive, forKey: .alive)
        if let muted = muted { try values.encode(muted, forKey: .muted) }
        else { try values.encodeNil(forKey: .muted) }
    }
}
struct Snapshot: Codable { let outputId: String; let devices: [Device] }

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func check(_ status: OSStatus) throws {
    guard status == noErr else { throw HelperError(message: "CoreAudio operation failed (\(status)).") }
}
func uintProperty(_ object: AudioObjectID, _ property: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) throws -> UInt32 {
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var propertyAddress = address(property, scope)
    try check(AudioObjectGetPropertyData(object, &propertyAddress, 0, nil, &size, &value))
    return value
}
func outputIDs() throws -> [AudioDeviceID] {
    var propertyAddress = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    try check(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &propertyAddress, 0, nil, &size))
    if size == 0 { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    try ids.withUnsafeMutableBytes { bytes in
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &propertyAddress, 0, nil, &size, bytes.baseAddress!))
    }
    return ids.filter { id in
        var streams = address(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeOutput)
        var bytes: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &bytes) == noErr && bytes > 0
    }
}
func deviceName(_ id: AudioDeviceID) throws -> String {
    var propertyAddress = address(kAudioObjectPropertyName)
    var name: CFString = "Output" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    try check(AudioObjectGetPropertyData(id, &propertyAddress, 0, nil, &size, &name))
    return String((name as String).prefix(256))
}
func inspect() throws -> Snapshot {
    let ids = try outputIDs()
    let devices: [Device] = try ids.map { id in
        var muteAddress = address(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput)
        var settable: DarwinBoolean = false
        let supportsMute = AudioObjectHasProperty(id, &muteAddress) && AudioObjectIsPropertySettable(id, &muteAddress, &settable) == noErr && settable.boolValue
        let mute: Bool? = supportsMute ? try uintProperty(id, kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput) != 0 : nil
        let transport = try uintProperty(id, kAudioDevicePropertyTransportType)
        let label: String
        switch transport {
        case kAudioDeviceTransportTypeBuiltIn: label = "Built-in"
        case kAudioDeviceTransportTypeUSB: label = "USB"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: label = "Bluetooth"
        case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort: label = "Display audio"
        default: label = "Audio device"
        }
        return Device(id: String(id), name: try deviceName(id), transport: label, alive: try uintProperty(id, kAudioDevicePropertyDeviceIsAlive) != 0, muted: mute)
    }
    return Snapshot(outputId: String(try uintProperty(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice)), devices: devices)
}
func setUInt(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ value: UInt32) throws {
    var propertyAddress = address(selector, scope)
    var settable: DarwinBoolean = false
    try check(AudioObjectIsPropertySettable(object, &propertyAddress, &settable))
    guard settable.boolValue else { throw HelperError(message: "This output does not support that control.") }
    var mutableValue = value
    try check(AudioObjectSetPropertyData(object, &propertyAddress, 0, nil, UInt32(MemoryLayout<UInt32>.size), &mutableValue))
}
do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["inspect"] {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        print(String(data: try encoder.encode(inspect()), encoding: .utf8)!)
    } else {
        guard args.count >= 2, let id = UInt32(args[1]), id > 0,
              try inspect().devices.contains(where: { $0.id == String(id) && $0.alive }) else { throw HelperError(message: "Select an available output device.") }
        if args.count == 2 && args[0] == "set-output" {
            try setUInt(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, id)
        } else if args.count == 3 && args[0] == "set-mute" && ["true", "false"].contains(args[2]) {
            try setUInt(id, kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput, args[2] == "true" ? 1 : 0)
        } else { throw HelperError(message: "Unsupported command. Use inspect, set-output ID, or set-mute ID true|false.") }
        print("{\"applied\":true}")
    }
} catch {
    FileHandle.standardError.write(Data("Fo Reach helper: \(error)\n".utf8))
    exit(1)
}
