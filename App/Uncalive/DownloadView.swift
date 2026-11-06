import SwiftUI

struct DownloadView: View {
    let model: AppModel

    var body: some View {
        Group {
            if let job = model.job {
                JobView(model: model, job: job)
            } else {
                ContentUnavailableView {
                    Label("진행 중인 다운로드가 없습니다", systemImage: "arrow.down.circle")
                } description: {
                    Text("스크랩이나 주소 수집에서 글을 고른 뒤 다운로드를 시작하세요.")
                } actions: {
                    Button("스크랩") { model.section = .scraps }
                    Button("주소 수집") { model.section = .collection }
                }
            }
        }
        .navigationTitle("다운로드")
    }
}

private struct JobView: View {
    let model: AppModel
    let job: DownloadJob

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            ProgressView(value: job.fractionCompleted)
            VStack(alignment: .leading, spacing: 12) {
                stats
                if !job.activeFiles.isEmpty { activeFiles }
            }
            .floatingGlass()
            Divider()
            logList
        }
        .padding(20)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.title3.weight(.semibold))
                Text(detail).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if job.isActive {
                Button(job.state == .paused ? "계속" : "일시정지") { model.togglePause() }
                    .disabled(job.state == .waitingForChallenge)
                Button("중단", role: .destructive) { model.cancelDownload() }
            } else {
                Button("폴더 열기") { NSWorkspace.shared.open(model.libraryRoot) }
            }
        }
    }

    private var title: String {
        switch job.state {
        case .running: "\(job.finishedPosts) / \(job.totalPosts)개 처리됨"
        case .paused: "일시정지됨"
        case .waitingForChallenge: "Cloudflare 보안 확인 대기 중"
        case .finished: "다운로드 완료"
        case .cancelled: "중단됨"
        case .failed: "다운로드에 실패했습니다"
        }
    }

    private var detail: String {
        switch job.state {
        case .running, .paused: job.currentTitle
        case .waitingForChallenge: "열린 창에서 보안 확인을 완료하면 다운로드가 자동으로 이어집니다."
        case .finished: "저장 위치: \(model.libraryRoot.path(percentEncoded: false))"
        case .cancelled: "다시 시작하면 이미 받은 파일은 건너뛰고 나머지를 이어서 받습니다."
        case .failed(let message): message
        }
    }

    private var stats: some View {
        HStack(spacing: 28) {
            Stat(title: "저장한 파일", value: "\(job.savedFiles)개")
            Stat(title: "받은 용량", value: job.savedBytes.formatted(.byteCount(style: .file)))
            Stat(title: "실패", value: "글 \(job.failedPosts + job.incompletePosts) · 파일 \(job.failedFiles)")
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                HStack(spacing: 28) {
                    Stat(title: "평균 속도", value: job.averageSpeed.formatted(.byteCount(style: .file)) + "/s")
                    Stat(title: "남은 시간", value: remaining)
                }
            }
        }
    }

    private var remaining: String {
        guard job.isActive else { return "-" }
        guard let seconds = job.estimatedRemaining else { return "계산 중" }
        return "약 " + Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow, maximumUnitCount: 2))
    }

    private var activeFiles: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(job.activeFiles.values.sorted { $0.id < $1.id }) { file in
                HStack {
                    if file.expected > 0 {
                        ProgressView(value: Double(file.received), total: Double(file.expected))
                    } else {
                        ProgressView().controlSize(.small)
                    }
                    Text(file.received.formatted(.byteCount(style: .file)))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 80, alignment: .trailing)
                }
            }
        }
    }

    private var logList: some View {
        ScrollViewReader { proxy in
            List(job.log) { line in
                Label {
                    Text(line.text).lineLimit(2).textSelection(.enabled)
                } icon: {
                    switch line.level {
                    case .info: Image(systemName: "arrow.uturn.right").foregroundStyle(.secondary)
                    case .success: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    case .warning: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    case .failure: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                    }
                }
                .id(line.id)
            }
            .listStyle(.plain)
            .onChange(of: job.log.count) {
                if let last = job.log.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }
}

private struct Stat: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.body.monospacedDigit())
        }
    }
}
