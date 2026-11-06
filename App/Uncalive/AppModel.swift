import AppKit
import Foundation
import Observation
import UncaliveCore
import UserNotifications

@MainActor
@Observable
final class AppModel {
    enum Section: Hashable {
        case scraps, collection, downloads, library, gallery, settings
    }

    enum LoginState {
        case unknown, loggedOut, loggedIn
    }

    enum PostStatus {
        case new, incomplete, saved
    }

    private static let optionsKey = "downloadOptions.v3"
    private static let previousOptionsKey = "downloadOptions.v2"
    private static let accountFolderKey = "useAccountFolder"
    private static let noAccountFolder = "로그인 안 함"
    private static let usernameKey = "username"
    private static let autoCheckKey = "autoCheckHours"
    private static let autoDownloadKey = "autoDownloadNewScraps"

    var section = Section.scraps {
        didSet {
            if section == .scraps { clearNewScrapBadge() }
            refreshFromDisk()
        }
    }
    var login = LoginState.unknown {
        didSet { DebugLog.write("login: \(oldValue) -> \(login)") }
    }
    var username = UserDefaults.standard.string(forKey: AppModel.usernameKey) {
        didSet {
            UserDefaults.standard.set(username, forKey: Self.usernameKey)
            if username != oldValue { libraryDidChange() }
        }
    }
    /// 켜면 저장 위치 아래에 계정 이름 폴더를 만들어 계정마다 보관함을 나눕니다.
    var useAccountFolder = UserDefaults.standard.object(forKey: AppModel.accountFolderKey) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(useAccountFolder, forKey: Self.accountFolderKey)
            libraryDidChange()
        }
    }

    let scraps = EntryList(kind: .scraps)
    let collection = EntryList(kind: .collection)

    var records: [String: ResumeStore.PostRecord] = [:]
    var library: [ArchivedPost] = []
    var isLoadingLibrary = false
    var job: DownloadJob?

    var newScrapCount = 0
    var lastCheck: Date?
    var autoCheckHours = UserDefaults.standard.integer(forKey: AppModel.autoCheckKey) {
        didSet {
            UserDefaults.standard.set(autoCheckHours, forKey: Self.autoCheckKey)
            scheduleAutoCheck()
            if autoCheckHours > 0 {
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge]) { _, _ in }
            }
        }
    }
    var autoDownloadNew = UserDefaults.standard.bool(forKey: AppModel.autoDownloadKey) {
        didSet { UserDefaults.standard.set(autoDownloadNew, forKey: Self.autoDownloadKey) }
    }

    var options: DownloadOptions {
        didSet {
            if let data = try? JSONEncoder().encode(options) {
                UserDefaults.standard.set(data, forKey: Self.optionsKey)
            }
            if options.destination != oldValue.destination { libraryDidChange() }
        }
    }

    let browser = BrowserController()

    @ObservationIgnored private let source: WebViewPageSource
    @ObservationIgnored private let engine: ScrapEngine
    @ObservationIgnored private var listTask: Task<Void, Never>?
    @ObservationIgnored private var jobTask: Task<Void, Never>?
    @ObservationIgnored private var autoCheckTask: Task<Void, Never>?
    @ObservationIgnored private var sleepActivity: NSObjectProtocol?
    @ObservationIgnored private var activationObserver: NSObjectProtocol?

    init() {
        let defaultRoot = FileManager.default.homeDirectoryForCurrentUser.appending(path: AppInfo.defaultFolder)
        let defaults = UserDefaults.standard
        func decode(_ key: String) -> DownloadOptions? {
            defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(DownloadOptions.self, from: $0) }
        }
        if let saved = decode(Self.optionsKey) {
            options = saved
        } else if var previous = decode(Self.previousOptionsKey) {
            // 저장 위치의 뜻이 바뀌었으므로 다른 옵션만 이어받습니다.
            previous.destination = defaultRoot
            options = previous
        } else {
            options = DownloadOptions(destination: defaultRoot)
        }

        source = WebViewPageSource(webView: browser.webView)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        engine = ScrapEngine(source: source, session: URLSession(configuration: configuration))

        source.onChallengeChanged = { [weak self] active in self?.challengeChanged(active) }
        browser.onLoginDetected = { [weak self] in self?.loginCompleted() }
        loadCollection()
    }

    func start() async {
        await browser.prepare()
        reloadRecords()
        scheduleAutoCheck()
        // Finder에서 지운 내용은 앱으로 돌아올 때 다시 확인합니다.
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshFromDisk() }
        }
        if await browser.hasSession() {
            refreshScraps()
        } else {
            login = .loggedOut
        }
    }

    // MARK: - 로그인

    func signIn() {
        browser.showLogin()
    }

    /// 읽고 있던 목록이 있어도 새 계정의 목록을 바로 읽습니다.
    private func loginCompleted() {
        login = .loggedIn
        Task {
            listTask?.cancel()
            await listTask?.value
            refreshScraps()
        }
    }

    func signOut() {
        Task {
            listTask?.cancel()
            await browser.signOut()
            login = .loggedOut
            username = nil
            scraps.entries = []
            scraps.checked = []
        }
    }

    // MARK: - 목록 공통

    /// 웹뷰는 하나이므로 페이지는 한 번에 한 작업만 읽습니다.
    var isBusy: Bool {
        scraps.isLoading || collection.isLoading || job?.isActive == true
    }

    func visibleEntries(of list: EntryList) -> [ScrapEntry] {
        list.entries.filter { entry in
            if let filter = list.channelFilter, entry.channel != filter { return false }
            switch list.statusFilter {
            case .all: break
            case .new: if status(of: entry) != .new { return false }
            case .incomplete: if status(of: entry) != .incomplete { return false }
            case .saved: if status(of: entry) != .saved { return false }
            }
            guard list.matchesPeriod(entry) else { return false }
            guard !list.searchText.isEmpty else { return true }
            return displayTitle(of: entry).localizedCaseInsensitiveContains(list.searchText)
                || entry.author?.localizedCaseInsensitiveContains(list.searchText) == true
        }
    }

    /// 주소로 추가한 글은 받은 뒤에야 실제 제목을 알 수 있습니다.
    func displayTitle(of entry: ScrapEntry) -> String {
        records[entry.id]?.title ?? entry.title
    }

    /// 목록에 없으면 받은 글의 기록에서 찾습니다.
    func category(of entry: ScrapEntry) -> String? {
        entry.category ?? records[entry.id]?.category
    }

    func status(of entry: ScrapEntry) -> PostStatus {
        guard let record = records[entry.id] else { return .new }
        return record.completed ? .saved : .incomplete
    }

    func checkVisible(_ value: Bool, in list: EntryList) {
        let ids = visibleEntries(of: list).map(\.id)
        if value { list.checked.formUnion(ids) } else { list.checked.subtract(ids) }
    }

    func checkUnsaved(in list: EntryList) {
        list.checked = Set(list.entries.filter { status(of: $0) != .saved }.map(\.id))
    }

    /// 새 글만 더합니다. 새로 더한 글의 수를 돌려줍니다.
    @discardableResult
    private func merge(_ fresh: [ScrapEntry], into list: EntryList, atFront: Bool = false) -> [ScrapEntry] {
        let known = Set(list.entries.map(\.id))
        let new = fresh.filter { !known.contains($0.id) }
        list.entries = atFront ? new + list.entries : list.entries + new
        list.checked.formUnion(new.filter { status(of: $0) != .saved }.map(\.id))
        return new
    }

    func stopLoading() {
        listTask?.cancel()
    }

    func exportCSV(_ list: EntryList) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = list.kind == .scraps ? "스크랩 목록.csv" : "주소 수집 목록.csv"
        panel.allowedContentTypes = [.commaSeparatedText]
        guard panel.runModal() == .OK, let url = panel.url else { return }

        var rows = [["제목", "채널", "카테고리", "작성자", "작성일", "주소", "상태", "저장 폴더"]]
        for entry in visibleEntries(of: list) {
            let status = switch status(of: entry) {
            case .new: "안 받음"
            case .incomplete: "일부만 받음"
            case .saved: "받음"
            }
            rows.append([
                displayTitle(of: entry), entry.channelName ?? entry.channel, category(of: entry) ?? "", entry.author ?? "",
                entry.createdAt ?? "", entry.url.absoluteString, status, records[entry.id]?.folder ?? ""
            ])
        }
        try? CSVWriter.data(rows: rows).write(to: url, options: .atomic)
    }

    // MARK: - 스크랩

    func refreshScraps() {
        guard !isBusy else { return }
        browser.enablePrivacyRules()
        scraps.state = .loading(page: 0, highestPage: nil)
        scraps.entries = []
        scraps.checked = []

        let (stream, continuation) = AsyncStream.makeStream(of: EngineEvent.self)
        let engine = engine
        let options = options
        listTask = Task {
            let consumer = Task {
                for await event in stream {
                    switch event {
                    case .accountFound(let name):
                        login = .loggedIn
                        username = name
                    case .listPageRead(let page, let fresh, _, let highest):
                        // 스크랩 페이지를 읽었다면 로그인된 것이므로 끝까지 기다리지 않습니다.
                        login = .loggedIn
                        merge(fresh, into: scraps)
                        scraps.state = .loading(page: page, highestPage: highest)
                    default:
                        break
                    }
                }
            }
            do {
                let read = try await engine.fetchEntries(options: options) { continuation.yield($0) }
                DebugLog.write("스크랩 읽기 완료: \(read.count)개")
                continuation.finish()
                await consumer.value
                login = .loggedIn
                lastCheck = .now
                scraps.state = .idle
            } catch {
                DebugLog.write("스크랩 읽기 실패: \(error)")
                continuation.finish()
                await consumer.value
                switch error {
                case is CancellationError:
                    scraps.state = .idle
                case UncaliveError.loginRequired:
                    login = .loggedOut
                    scraps.state = .idle
                default:
                    scraps.state = .failed(error.localizedDescription)
                }
            }
            listTask = nil
        }
    }

    // MARK: - 새 스크랩 자동 확인

    private func scheduleAutoCheck() {
        autoCheckTask?.cancel()
        guard autoCheckHours > 0 else { return }
        let seconds = autoCheckHours * 3600
        autoCheckTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(seconds))
                guard !Task.isCancelled else { return }
                await checkForNewScraps()
            }
        }
    }

    /// 앞쪽부터 읽어 이미 아는 글이 나올 때까지 새 스크랩을 찾습니다.
    func checkForNewScraps() async {
        guard login == .loggedIn, !isBusy else { return }
        // 아는 글이 없으면 어디서 멈출지 알 수 없으므로 전체를 읽습니다.
        guard !scraps.entries.isEmpty else {
            refreshScraps()
            return
        }
        browser.enablePrivacyRules()
        let known = Set(scraps.entries.map(\.id))
        guard let fresh = try? await engine.fetchNewScraps(known: known, options: options) else { return }
        lastCheck = .now

        let new = merge(fresh, into: scraps, atFront: true).filter { status(of: $0) == .new }
        guard !new.isEmpty else { return }

        if section != .scraps {
            newScrapCount += new.count
            NSApp.dockTile.badgeLabel = String(newScrapCount)
        }
        notify(newScraps: new.count)
        if autoDownloadNew { startDownload(new, source: .scrap) }
    }

    /// 알림에는 개수만 넣고 글 제목은 넣지 않습니다.
    private func notify(newScraps count: Int) {
        let content = UNMutableNotificationContent()
        content.title = AppInfo.name
        content.body = "새 스크랩 \(count)개를 찾았습니다."
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    private func clearNewScrapBadge() {
        newScrapCount = 0
        NSApp.dockTile.badgeLabel = nil
    }

    // MARK: - 주소 수집

    /// 주소 수집 목록은 보관함마다 따로 있습니다.
    private var collectionURL: URL {
        libraryRoot.appending(path: ".uncalive/collection.json")
    }

    private func loadCollection() {
        let data = try? Data(contentsOf: collectionURL)
        collection.entries = data.flatMap { try? JSONDecoder().decode([ScrapEntry].self, from: $0) } ?? []
        collection.checked = []
    }

    private func saveCollection() {
        try? FileManager.default.createDirectory(at: collectionURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(collection.entries).write(to: collectionURL, options: .atomic)
    }

    func clearCollection() {
        collection.entries = []
        collection.checked = []
        saveCollection()
    }

    /// 글 주소는 바로 더하고, 목록 주소는 지정한 범위만큼 읽습니다.
    func addTargets(from text: String, scope: ListScope) {
        var lists: [URL] = []
        var posts: [ScrapEntry] = []
        for target in ArcaParser.parseTargets(text) {
            switch target {
            case .post(let entry): posts.append(entry)
            case .list(let url): lists.append(url)
            }
        }
        merge(posts, into: collection)
        saveCollection()
        guard !lists.isEmpty, !isBusy else { return }

        browser.enablePrivacyRules()
        collection.state = .loading(page: 0, highestPage: scope.lastPage)
        let (stream, continuation) = AsyncStream.makeStream(of: EngineEvent.self)
        let engine = engine
        let delay = options.pageDelay
        listTask = Task {
            let consumer = Task {
                for await event in stream {
                    guard case .listPageRead(let page, let fresh, _, _) = event else { continue }
                    merge(fresh, into: collection)
                    collection.state = .loading(page: page, highestPage: scope.lastPage)
                }
            }
            var failure: String?
            for url in lists {
                do {
                    _ = try await engine.fetchEntries(listURL: url, scope: scope, delay: delay) { continuation.yield($0) }
                } catch is CancellationError {
                    break
                } catch {
                    failure = error.localizedDescription
                }
            }
            continuation.finish()
            await consumer.value
            saveCollection()
            collection.state = failure.map(EntryList.State.failed) ?? .idle
            listTask = nil
        }
    }

    // MARK: - 다운로드

    func startDownload(from list: EntryList) {
        startDownload(list.entries.filter { list.checked.contains($0.id) }, source: list.kind == .scraps ? .scrap : .collection)
    }

    private func startDownload(_ selected: [ScrapEntry], source: ArchiveSource) {
        guard !isBusy, !selected.isEmpty else { return }

        let job = DownloadJob(totalPosts: selected.count)
        self.job = job
        section = .downloads
        preventSleep(true)

        // 사용자가 직접 고른 글이므로 받은 기록이 있어도 다시 확인합니다. 있는 파일은 재사용합니다.
        var options = options
        options.destination = libraryRoot
        options.source = source
        options.skipCompleted = false
        let engine = engine
        let (stream, continuation) = AsyncStream.makeStream(of: EngineEvent.self)
        jobTask = Task {
            let consumer = Task {
                for await event in stream {
                    job.handle(event)
                    if case .postFinished = event { reloadRecords() }
                }
            }
            do {
                _ = try await engine.download(selected, options: options, control: job.control) { continuation.yield($0) }
                continuation.finish()
                await consumer.value
                job.state = .finished
            } catch {
                continuation.finish()
                await consumer.value
                if error is CancellationError {
                    job.state = .cancelled
                } else {
                    job.state = .failed(error.localizedDescription)
                    if case UncaliveError.loginRequired = error { login = .loggedOut }
                }
            }
            job.finishedAt = Date()
            job.activeFiles = [:]
            reloadRecords()
            preventSleep(false)
            NSApp.requestUserAttention(.informationalRequest)
        }
    }

    func togglePause() {
        guard let job else { return }
        Task {
            if job.state == .paused {
                await job.control.resume()
                job.state = .running
            } else if job.state == .running {
                await job.control.pause()
                job.state = .paused
            }
        }
    }

    func cancelDownload() {
        guard let job else { return }
        jobTask?.cancel()
        Task { await job.control.resume() }
    }

    /// 종료 전에 기록이 저장되도록 작업이 멈추기를 잠시 기다립니다.
    func cancelDownloadAndWait() async {
        cancelDownload()
        for _ in 0..<30 where job?.isActive == true {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    private func challengeChanged(_ active: Bool) {
        if active {
            browser.showChallenge()
            if job?.state == .running { job?.state = .waitingForChallenge }
        } else {
            browser.hide()
            if job?.state == .waitingForChallenge { job?.state = .running }
        }
    }

    private func preventSleep(_ prevent: Bool) {
        if prevent {
            sleepActivity = ProcessInfo.processInfo.beginActivity(
                options: [.idleSystemSleepDisabled, .userInitiated],
                reason: "스크랩 다운로드 중"
            )
        } else if let sleepActivity {
            ProcessInfo.processInfo.endActivity(sleepActivity)
            self.sleepActivity = nil
        }
    }

    // MARK: - 보관함

    /// 실제로 쓰는 보관함 폴더입니다.
    var libraryRoot: URL {
        guard useAccountFolder else { return options.destination }
        let name = FileNaming.sanitize(username ?? Self.noAccountFolder, maxCharacters: 60)
        return options.destination.appending(path: name.isEmpty ? Self.noAccountFolder : name)
    }

    /// 저장 위치나 계정이 바뀌면 화면의 목록도 그 보관함의 내용으로 바꿉니다.
    private func libraryDidChange() {
        records = [:]
        library = []
        loadCollection()
        reloadRecords { [weak self] in
            guard let self else { return }
            self.scraps.checked = Set(self.scraps.entries.filter { self.status(of: $0) != .saved }.map(\.id))
            self.collection.checked = Set(self.collection.entries.filter { self.status(of: $0) != .saved }.map(\.id))
        }
        reloadLibrary()
    }

    /// 디스크의 현재 상태를 다시 읽습니다.
    private func refreshFromDisk() {
        reloadRecords()
        if section == .library || section == .gallery { reloadLibrary() }
    }

    func reloadRecords(then finish: (@MainActor () -> Void)? = nil) {
        let root = libraryRoot
        guard FileManager.default.fileExists(atPath: root.appending(path: ".uncalive/state.json").path(percentEncoded: false)) else {
            records = [:]
            finish?()
            return
        }
        Task {
            guard let store = try? ResumeStore(root: root) else { return }
            let live = await store.liveRecords()
            guard root == libraryRoot else { return }
            records = Dictionary(uniqueKeysWithValues: live.map { ($0.id, $0) })
            finish?()
        }
    }

    func reloadLibrary() {
        let root = libraryRoot
        isLoadingLibrary = true
        Task {
            var names: [String: String] = [:]
            for entry in scraps.entries + collection.entries {
                if let name = entry.channelName { names[entry.channel] = name }
            }
            let posts = await LibraryStore.load(root: root).map { post in
                var named = post
                if post.channelName == post.channel, let name = names[post.channel] { named.channelName = name }
                return named
            }
            guard root == libraryRoot else { return }
            library = posts
            isLoadingLibrary = false
        }
    }

    func folderURL(for record: ResumeStore.PostRecord) -> URL {
        libraryRoot.appending(path: record.folder)
    }

    func open(_ record: ResumeStore.PostRecord) {
        let folder = folderURL(for: record)
        let page = folder.appending(path: "index.html")
        NSWorkspace.shared.open(FileManager.default.fileExists(atPath: page.path(percentEncoded: false)) ? page : folder)
    }

    func reveal(_ record: ResumeStore.PostRecord) {
        NSWorkspace.shared.activateFileViewerSelecting([folderURL(for: record)])
    }

    func chooseDestination() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "선택"
        panel.directoryURL = options.destination
        if panel.runModal() == .OK, let url = panel.url {
            options.destination = url
        }
    }

    /// 다운로드 버튼 옆에 보여 줄 현재 옵션 요약입니다.
    var optionsSummary: String {
        var kinds: [String] = []
        if options.includeImages { kinds.append("이미지") }
        if options.includeVideos { kinds.append("동영상") }
        if options.includeAudio { kinds.append("오디오") }
        if options.includeEmoticons { kinds.append("아카콘") }
        var parts = [options.quality.title, kinds.isEmpty ? "받을 파일 없음" : kinds.joined(separator: ", ")]
        if options.archive.offlineHTML { parts.append("오프라인 페이지") }
        return parts.joined(separator: " · ")
    }
}
