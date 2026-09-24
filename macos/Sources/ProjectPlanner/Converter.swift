import Foundation
import ToolkitShell

/// Microsoft Project files through MPXJ (tools/mpp2xml.sh), which a web page
/// cannot read on its own. The app bundle carries a copy of the script, the
/// MPXJ jars and a Java runtime under Resources/converter; under `swift run`
/// the repository's own tools/ folder is used instead.
enum Converter {
    /// File name extensions handed to MPXJ rather than to the page directly.
    static let extensions: Set<String> = ["mpp", "mpt", "mpx", "xer", "pmxml", "pod", "gan", "planner", "pp", "prx", "sp", "ppx", "cdpx", "cdpz", "mdb", "p3", "stx", "fts", "pc", "pep", "gnt"]

    static var script: URL? {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("converter/mpp2xml.sh"),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        let repo = WebRoot.directory.appendingPathComponent("tools/mpp2xml.sh")
        return FileManager.default.isExecutableFile(atPath: repo.path) ? repo : nil
    }

    static var isAvailable: Bool { script != nil }

    static func handles(_ url: URL?) -> Bool {
        guard let ext = url?.pathExtension.lowercased(), !ext.isEmpty else { return false }
        return extensions.contains(ext)
    }

    /// An OLE compound document — what every .mpp is — starts with D0 CF 11 E0.
    static func looksLikeOLE(_ data: Data) -> Bool {
        data.count > 8 && data[0] == 0xD0 && data[1] == 0xCF && data[2] == 0x11 && data[3] == 0xE0
    }

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Convert `data` (a file with extension `from`) to a file with extension `to`; returns its bytes.
    static func convert(_ data: Data, from: String, to: String) throws -> Data {
        guard let script else {
            throw Failure(message: "The Microsoft Project converter is not installed with this app. Run tools/setup-converter.sh and rebuild.")
        }
        let work = FileManager.default.temporaryDirectory.appendingPathComponent("pp-convert-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }
        let src = work.appendingPathComponent("input.\(from)")
        let dst = work.appendingPathComponent("output.\(to)")
        try data.write(to: src)
        let proc = Process()
        proc.executableURL = script
        proc.arguments = [src.path, dst.path]
        let err = Pipe()
        proc.standardOutput = Pipe()
        proc.standardError = err
        try proc.run()
        proc.waitUntilExit()
        let log = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard proc.terminationStatus == 0, let out = try? Data(contentsOf: dst) else {
            let tail = log.split(separator: "\n").suffix(8).joined(separator: "\n")
            throw Failure(message: "MPXJ could not convert the file.\n\n\(tail)")
        }
        return out
    }
}
