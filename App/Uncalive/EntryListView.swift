import SwiftUI
import UncaliveCore

/// 스크랩과 주소 수집이 함께 쓰는 글 목록 화면입니다.
struct EntryListView: View {
    @Bindable var model: AppModel
    @Bindable var list: EntryList
    @AppStorage("showDownloadOptions") private var showOptions = true
    @State private var showAddSheet = false

    private var isScraps: Bool { list.kind == .scraps }

    var body: some View {
        content
            .navigationTitle(isScraps ? "스크랩" : "주소 수집")
            .navigationSubtitle(subtitle)
            .searchable(text: $list.searchText, prompt: "제목, 작성자 검색")
            .toolbar { toolbar }
            .sheet(isPresented: $showAddSheet) { AddURLsSheet(model: model) }
            .inspector(isPresented: $showOptions) {
                DownloadOptionsPanel(model: model)
                    .inspectorColumnWidth(min: 260, ideal: 290, max: 340)
            }
    }

    private var subtitle: String {
        if case .loading(let page, let highest) = list.state, page > 0 {
            let total = highest.map { " / \($0)" } ?? ""
            return "\(page)\(total)페이지 읽는 중 · \(list.entries.count)개"
        }
        return list.entries.isEmpty ? "" : "\(list.entries.count)개"
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup {
            if list.isLoading {
                Button("중지", systemImage: "stop.circle") { model.stopLoading() }
            } else if isScraps {
                Button("새로고침", systemImage: "arrow.clockwise") { model.refreshScraps() }
                    .disabled(model.isBusy || model.login == .loggedOut)
            } else {
                Button("주소 추가", systemImage: "plus") { showAddSheet = true }
                    .disabled(model.isBusy)
                Button("목록 비우기", systemImage: "trash") { model.clearCollection() }
                    .disabled(model.isBusy || list.entries.isEmpty)
            }
            Button("CSV로 내보내기", systemImage: "square.and.arrow.up") { model.exportCSV(list) }
                .disabled(list.entries.isEmpty)
            Button { showOptions.toggle() } label: {
                Label("다운로드 옵션", systemImage: "slider.horizontal.3")
            }
            .help(showOptions ? "다운로드 옵션 숨기기" : "다운로드 옵션 보기")
        }
    }

    @ViewBuilder private var content: some View {
        if isScraps, model.login == .loggedOut, list.entries.isEmpty, !list.isLoading {
            ContentUnavailableView {
                Label("로그인이 필요합니다", systemImage: "person.crop.circle")
            } description: {
                Text("아카라이브 계정으로 로그인하면 스크랩 목록을 불러옵니다.\n비밀번호는 아카라이브 로그인 화면에서 직접 입력하며, 앱에는 저장되지 않습니다.")
            } actions: {
                Button("로그인") { model.signIn() }.prominentGlassButton()
            }
        } else if case .failed(let message) = list.state, list.entries.isEmpty {
            ContentUnavailableView {
                Label("목록을 불러오지 못했습니다", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("다시 시도") { isScraps ? model.refreshScraps() : (showAddSheet = true) }
            }
        } else if list.entries.isEmpty {
            emptyState
        } else {
            VStack(spacing: 0) {
                filterBar
                Divider()
                table
                    .safeAreaInset(edge: .bottom) {
                        actionBar
                            .floatingGlass()
                            .padding(12)
                    }
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if list.isLoading || (isScraps && model.login == .unknown) {
            ProgressView("목록을 불러오는 중입니다")
        } else if isScraps {
            ContentUnavailableView("스크랩한 글이 없습니다", systemImage: "bookmark", description: Text("아카라이브에서 글을 스크랩한 뒤 새로고침하세요."))
        } else {
            ContentUnavailableView {
                Label("수집한 글이 없습니다", systemImage: "link")
            } description: {
                Text("개별 글 주소나 채널, 개념글, 검색 결과 등의 목록 주소를 추가해 글을 모을 수 있습니다.\n스크랩 목록과는 별도로 관리됩니다.")
            } actions: {
                Button("주소 추가") { showAddSheet = true }.prominentGlassButton()
            }
        }
    }

    private var filterBar: some View {
        HStack(spacing: 10) {
            Picker("채널", selection: $list.channelFilter) {
                Text("모든 채널").tag(String?.none)
                ForEach(list.channels, id: \.id) { channel in
                    Text(channel.name).tag(String?.some(channel.id))
                }
            }
            .labelsHidden()
            .fixedSize()
            Picker("상태", selection: $list.statusFilter) {
                ForEach(EntryList.StatusFilter.allCases) { Text($0.rawValue).tag($0) }
            }
            .labelsHidden()
            .fixedSize()
            Picker("기간", selection: $list.period) {
                ForEach(EntryList.Period.allCases) { Text($0.rawValue).tag($0) }
            }
            .labelsHidden()
            .fixedSize()
            if list.period == .custom {
                DatePicker("시작", selection: $list.customFrom, displayedComponents: .date).labelsHidden()
                Text("-").foregroundStyle(.secondary)
                DatePicker("끝", selection: $list.customTo, displayedComponents: .date).labelsHidden()
            }
            Spacer(minLength: 0)
            Text("\(model.visibleEntries(of: list).count)개 표시")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var table: some View {
        Table(model.visibleEntries(of: list)) {
            TableColumn("") { entry in
                Toggle("선택", isOn: Binding(
                    get: { list.checked.contains(entry.id) },
                    set: { value in
                        if value { list.checked.insert(entry.id) } else { list.checked.remove(entry.id) }
                    }
                ))
                .labelsHidden()
            }
            .width(24)
            TableColumn("제목") { entry in
                Text(model.displayTitle(of: entry)).lineLimit(1).help(model.displayTitle(of: entry))
            }
            .width(min: 120, ideal: 300)
            TableColumn("채널") { entry in
                Text(entry.channelName ?? entry.channel).lineLimit(1)
            }
            .width(min: 56, ideal: 76, max: 160)
            TableColumn("카테고리") { entry in
                Text(model.category(of: entry) ?? "").lineLimit(1)
            }
            .width(min: 50, ideal: 66, max: 130)
            TableColumn("작성자") { entry in
                Text(entry.author ?? "").lineLimit(1)
            }
            .width(min: 50, ideal: 70, max: 140)
            TableColumn("작성일") { entry in
                Text(entry.date?.formatted(.dateTime.year(.twoDigits).month(.twoDigits).day(.twoDigits)) ?? "")
                    .monospacedDigit()
                    .lineLimit(1)
            }
            .width(min: 58, ideal: 66, max: 90)
            TableColumn("상태") { entry in
                StatusBadge(status: model.status(of: entry))
            }
            .width(34)
        }
    }

    private var actionBar: some View {
        HStack(spacing: 12) {
            Menu("선택") {
                Button("보이는 글 모두 선택") { model.checkVisible(true, in: list) }
                Button("보이는 글 모두 해제") { model.checkVisible(false, in: list) }
                Button("안 받은 글만 선택") { model.checkUnsaved(in: list) }
            }
            .fixedSize()
            Button {
                showOptions = true
            } label: {
                Text(model.optionsSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .buttonStyle(.plain)
            .help("다운로드 옵션 보기")
            Spacer(minLength: 4)
            Text("\(list.checkedCount)개 선택됨")
                .foregroundStyle(.secondary)
                .fixedSize()
            Button("다운로드 시작") { model.startDownload(from: list) }
                .prominentGlassButton()
                .keyboardShortcut(.defaultAction)
                .disabled(list.checkedCount == 0 || model.isBusy)
        }
    }
}

private struct StatusBadge: View {
    let status: AppModel.PostStatus

    var body: some View {
        switch status {
        case .new:
            Image(systemName: "circle").foregroundStyle(.secondary).help("안 받음")
        case .incomplete:
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange).help("일부만 받음")
        case .saved:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).help("받음")
        }
    }
}
