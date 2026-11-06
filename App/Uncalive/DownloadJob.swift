import Foundation
import Observation
import UncaliveCore

/// 다운로드 한 회차의 진행 상태입니다.
@MainActor
@Observable
final class DownloadJob {
    enum State: Equatable {
        case running, paused, waitingForChallenge, finished, cancelled
        case failed(String)
    }

    struct ActiveFile: Identifiable {
        let id: String
        var received: Int64
        var expected: Int64
    }

    struct LogLine: Identifiable {
        enum Level { case info, success, warning, failure }
        let id = UUID()
        let level: Level
        let text: String
    }

    let totalPosts: Int
    let startedAt = Date()
    let control = RunControl()

    var state = State.running
    var finishedPosts = 0
    var currentTitle = ""
    var currentMediaCount = 0
    var savedFiles = 0
    var failedFiles = 0
    var failedPosts = 0
    var incompletePosts = 0
    var savedBytes: Int64 = 0
    var activeFiles: [String: ActiveFile] = [:]
    var log: [LogLine] = []
    var finishedAt: Date?

    init(totalPosts: Int) {
        self.totalPosts = totalPosts
    }

    var isActive: Bool {
        switch state {
        case .running, .paused, .waitingForChallenge: true
        default: false
        }
    }

    var fractionCompleted: Double {
        guard totalPosts > 0 else { return 0 }
        return Double(finishedPosts) / Double(totalPosts)
    }

    /// 지금까지 처리한 글의 평균으로 남은 시간을 어림합니다.
    var estimatedRemaining: TimeInterval? {
        guard finishedPosts > 0, finishedPosts < totalPosts else { return nil }
        let perPost = Date().timeIntervalSince(startedAt) / Double(finishedPosts)
        return perPost * Double(totalPosts - finishedPosts)
    }

    var averageSpeed: Int64 {
        let elapsed = (finishedAt ?? Date()).timeIntervalSince(startedAt)
        return elapsed > 0 ? Int64(Double(savedBytes) / elapsed) : 0
    }

    func handle(_ event: EngineEvent) {
        switch event {
        case .postStarted(_, _, let entry):
            currentTitle = entry.title
        case .mediaStarted(_, let count):
            currentMediaCount = count
        case .mediaProgress(_, let key, let received, let expected):
            activeFiles[key] = ActiveFile(id: key, received: received, expected: expected)
        case .mediaSaved(_, let key, _, let bytes, _):
            activeFiles[key] = nil
            savedFiles += 1
            savedBytes += bytes
        case .mediaFailed(_, let key, let reason):
            activeFiles[key] = nil
            failedFiles += 1
            append(.warning, "파일 다운로드 실패: \(reason)")
        case .postFinished(_, _, let entry, _, let complete):
            finishedPosts += 1
            if !complete { incompletePosts += 1 }
            append(complete ? .success : .warning, complete ? entry.title : "일부 실패: \(entry.title)")
        case .postFailed(_, _, let entry, let reason):
            finishedPosts += 1
            failedPosts += 1
            append(.failure, "\(entry.title): \(reason)")
        case .postSkipped(_, _, let entry):
            finishedPosts += 1
            append(.info, "건너뜀: \(entry.title)")
        case .warning(let text):
            append(.warning, text)
        case .listPageRead, .listFinished, .accountFound:
            break
        }
    }

    func append(_ level: LogLine.Level, _ text: String) {
        log.append(LogLine(level: level, text: text))
    }
}
