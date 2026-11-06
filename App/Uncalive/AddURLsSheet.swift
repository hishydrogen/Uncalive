import SwiftUI
import UncaliveCore

/// 스크랩하지 않은 글이나 채널, 개념글, 검색 결과를 주소로 모읍니다.
struct AddURLsSheet: View {
    private enum ScopeMode: Hashable {
        case first, range, days, all
    }

    let model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var mode = ScopeMode.first
    @State private var firstPages = 5
    @State private var rangeStart = 1
    @State private var rangeEnd = 10
    @State private var days = 30

    private var targets: [ArcaParser.Target] {
        ArcaParser.parseTargets(text)
    }

    private var hasList: Bool {
        targets.contains { if case .list = $0 { true } else { false } }
    }

    private var scope: ListScope {
        switch mode {
        case .first: ListScope(firstPage: 1, lastPage: firstPages)
        case .range: ListScope(firstPage: rangeStart, lastPage: max(rangeEnd, rangeStart))
        case .days: ListScope(firstPage: 1, lastPage: nil, since: Calendar.current.date(byAdding: .day, value: -days, to: .now))
        case .all: ListScope(firstPage: 1, lastPage: nil)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("주소 추가").font(.title3.weight(.semibold))
            Text("아카라이브 게시글 주소나 목록 주소를 한 줄에 하나씩 붙여 넣으세요. 채널, 개념글, 카테고리, 검색 결과, 작성자 글 목록 주소를 모두 지원합니다.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .frame(height: 140)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))

            Text("인식된 주소 \(targets.count)개").font(.caption).foregroundStyle(.secondary)

            if hasList {
                GroupBox("목록을 불러올 범위") {
                    VStack(alignment: .leading, spacing: 10) {
                        Picker("범위", selection: $mode) {
                            Text("앞쪽 페이지").tag(ScopeMode.first)
                            Text("페이지 구간").tag(ScopeMode.range)
                            Text("최근 기간").tag(ScopeMode.days)
                            Text("끝까지").tag(ScopeMode.all)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        scopeDetail
                    }
                    .padding(6)
                }
            }

            HStack {
                Spacer()
                Button("취소", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("추가") {
                    model.addTargets(from: text, scope: scope)
                    dismiss()
                }
                .prominentGlassButton()
                .keyboardShortcut(.defaultAction)
                .disabled(targets.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 540)
    }

    @ViewBuilder private var scopeDetail: some View {
        switch mode {
        case .first:
            HStack {
                Text("처음")
                NumberField(value: $firstPages, range: 1...100_000)
                Text("페이지")
            }
        case .range:
            HStack {
                NumberField(value: $rangeStart, range: 1...100_000)
                Text("페이지부터")
                NumberField(value: $rangeEnd, range: 1...100_000)
                Text("페이지까지")
            }
        case .days:
            HStack {
                Text("최근")
                NumberField(value: $days, range: 1...36_500)
                Text("일 이내의 글")
            }
        case .all:
            Label("규모가 큰 채널은 페이지 수가 매우 많을 수 있습니다. 불러오는 중에 언제든 중지할 수 있으며, 그때까지 불러온 글은 목록에 남습니다.", systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
