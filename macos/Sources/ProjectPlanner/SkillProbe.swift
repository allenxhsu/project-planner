import Foundation

/// Software skill, counted from what is already on this Mac: commits in the
/// git repositories under ~/Documents/ClaudWorkSpace (by this git user), and
/// prompts written to Claude Code (its session logs under ~/.claude/projects).
/// A day at a time, for the last 400 days — counts only, never a message or a
/// prompt's text. Runs off the main thread; the page gets
/// `{ "YYYY-MM-DD": { commits, features, prompts } }`.
enum SkillProbe {
    static func count(_ done: @escaping ([String: [String: Int]]) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            var days: [String: [String: Int]] = [:]
            func bump(_ day: String, _ key: String) { days[day, default: [:]][key, default: 0] += 1 }
            let home = FileManager.default.homeDirectoryForCurrentUser

            // Commits: every repository one level down, by the global git user.
            let email = run(["config", "--global", "user.email"])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let workspace = home.appendingPathComponent("Documents/ClaudWorkSpace")
            let repos = (try? FileManager.default.contentsOfDirectory(at: workspace, includingPropertiesForKeys: nil)) ?? []
            for repo in repos where FileManager.default.fileExists(atPath: repo.appendingPathComponent(".git").path) {
                var args = ["-C", repo.path, "log", "--all", "--no-merges", "--since=400.days", "--date=short", "--format=%ad\t%s"]
                if !email.isEmpty { args.append("--author=\(email)") }
                guard let out = run(args) else { continue }
                for line in out.split(separator: "\n") {
                    let parts = line.split(separator: "\t", maxSplits: 1)
                    guard let day = parts.first.map(String.init), day.count == 10 else { continue }
                    bump(day, "commits")
                    // A feature: a commit that is not a fix, a revert or bookkeeping.
                    let subject = parts.count > 1 ? parts[1].lowercased() : ""
                    if !["fix", "revert", "record", "bump", "merge", "chore"].contains(where: { subject.hasPrefix($0) }) { bump(day, "features") }
                }
            }

            // Prompts: the lines a person typed into Claude Code, from its session logs.
            let projects = home.appendingPathComponent(".claude/projects")
            let cutoff = Date().addingTimeInterval(-400 * 86_400)
            let local = DateFormatter()
            local.dateFormat = "yyyy-MM-dd"
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let walker = FileManager.default.enumerator(at: projects, includingPropertiesForKeys: [.contentModificationDateKey]) {
                for case let file as URL in walker where file.pathExtension == "jsonl" {
                    let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                    guard modified > cutoff, let data = try? Data(contentsOf: file), let text = String(data: data, encoding: .utf8) else { continue }
                    for line in text.split(separator: "\n") where line.contains("\"type\":\"user\"") {
                        // Tool results and the harness's own notes come in as "user" lines too; a prompt is typed text.
                        if line.contains("\"tool_use_id\"") || line.contains("\"isMeta\":true") || line.contains("\"isSidechain\":true") { continue }
                        guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                              let stamp = obj["timestamp"] as? String, let when = iso.date(from: stamp),
                              let message = obj["message"] as? [String: Any] else { continue }
                        let typed: Bool
                        if let s = message["content"] as? String { typed = !s.hasPrefix("<") }
                        else if let parts = message["content"] as? [[String: Any]] { typed = parts.contains { ($0["type"] as? String) == "text" } }
                        else { typed = false }
                        if typed { bump(local.string(from: when), "prompts") }
                    }
                }
            }
            DispatchQueue.main.async { done(days) }
        }
    }

    private static func run(_ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do { try process.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? String(data: data, encoding: .utf8) : nil
    }
}
