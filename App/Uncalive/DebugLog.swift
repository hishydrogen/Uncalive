import Foundation

/// 개발 빌드에서만 `~/Library/Logs/Uncalive Dev/debug.log`에 남습니다. 설치본에서는 아무 일도 하지 않습니다.
enum DebugLog {
    #if DEBUG
    nonisolated(unsafe) private static var last = ""
    private static let url: URL = {
        let folder = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/Uncalive Dev")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appending(path: "debug.log")
    }()
    #endif

    @MainActor static func write(_ message: String) {
        #if DEBUG
        let line = Date().formatted(.iso8601.time(includingFractionalSeconds: false)) + " " + message + "\n"
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(line.utf8))
        } else {
            try? Data(line.utf8).write(to: url)
        }
        #endif
    }

    /// 같은 내용이 이어지면 건너뜁니다.
    @MainActor static func writeChange(_ message: String) {
        #if DEBUG
        guard message != last else { return }
        last = message
        write(message)
        #endif
    }
}
