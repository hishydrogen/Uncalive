import CryptoKit
import Foundation

public enum PageKind: Sendable {
    case scrapList, post
}

public struct LoadedPage: Sendable {
    public let html: String
    public let status: Int

    public init(html: String, status: Int) {
        self.html = html
        self.status = status
    }
}

/// 로그인된 브라우저에서 페이지를 읽어 오는 역할입니다. 앱에서는 WKWebView가 맡습니다.
public protocol PageSource: Sendable {
    func load(_ url: URL, kind: PageKind) async throws -> LoadedPage
    func userAgent() async -> String?
    /// 마지막으로 불러온 페이지를 `.webarchive`로 돌려줍니다.
    func webArchiveData() async throws -> Data
}

/// 실행 중인 작업을 일시정지합니다. 취소는 작업(Task)을 취소해서 처리합니다.
public actor RunControl {
    private var paused = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init() {}

    public func pause() { paused = true }

    public func resume() {
        paused = false
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }

    func waitIfPaused() async {
        guard paused else { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}

public enum EngineEvent: Sendable {
    case listPageRead(page: Int, entries: [ScrapEntry], total: Int, highestVisiblePage: Int)
    case listFinished(total: Int)
    case accountFound(username: String)
    case postStarted(index: Int, total: Int, entry: ScrapEntry)
    case postSkipped(index: Int, total: Int, entry: ScrapEntry)
    case mediaStarted(postID: String, count: Int)
    case mediaProgress(postID: String, key: String, received: Int64, expected: Int64)
    case mediaSaved(postID: String, key: String, fileName: String, bytes: Int64, usedOriginal: Bool)
    case mediaFailed(postID: String, key: String, reason: String)
    case postFinished(index: Int, total: Int, entry: ScrapEntry, folder: String, complete: Bool)
    case postFailed(index: Int, total: Int, entry: ScrapEntry, reason: String)
    case warning(String)
}

public struct RunSummary: Sendable, Equatable {
    public var postsFound = 0
    public var postsCompleted = 0
    public var postsSkipped = 0
    public var postsIncomplete = 0
    public var postsFailed = 0
    public var mediaSaved = 0
    public var mediaReused = 0
    public var mediaFailed = 0
    public var bytesSaved: Int64 = 0
}

public struct ScrapEngine: Sendable {
    private let source: any PageSource
    private let session: URLSession
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    private let retryDelay: @Sendable (Int) async throws -> Void

    public init(
        source: any PageSource,
        session: URLSession = .shared,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
            if seconds > 0 { try await Task.sleep(for: .seconds(seconds)) }
        },
        retryDelay: @escaping @Sendable (Int) async throws -> Void = { attempt in
            try await Task.sleep(for: .seconds(pow(2, Double(attempt))))
        }
    ) {
        self.source = source
        self.session = session
        self.sleep = sleep
        self.retryDelay = retryDelay
    }

    public func run(
        options: DownloadOptions,
        control: RunControl = RunControl(),
        onEvent: @escaping @Sendable (EngineEvent) -> Void = { _ in }
    ) async throws -> RunSummary {
        let entries = try await fetchEntries(options: options, control: control, onEvent: onEvent)
        return try await download(entries, options: options, control: control, onEvent: onEvent)
    }

    /// 지정한 게시글만 받습니다. 받을 글을 사용자가 고른 뒤에 호출합니다.
    ///
    /// 페이지는 한 번에 하나씩 읽되, 앞선 글의 파일을 받는 동안 다음 글을 미리 읽어
    /// 원본 서버의 제한된 연결이 쉬지 않게 합니다. 서명된 주소가 만료되기 전에 쓰도록 앞서 읽는 글 수는 제한합니다.
    public func download(
        _ entries: [ScrapEntry],
        options: DownloadOptions,
        control: RunControl = RunControl(),
        onEvent: @escaping @Sendable (EngineEvent) -> Void = { _ in }
    ) async throws -> RunSummary {
        let root = options.destination
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            throw UncaliveError.destinationUnavailable(error.localizedDescription)
        }
        let store = try ResumeStore(root: root)
        let downloader = MediaDownloader(
            session: session,
            retryCount: options.retryCount,
            userAgent: await source.userAgent(),
            cdnConnections: options.maxConcurrentDownloads,
            retryDelay: retryDelay
        )

        var summary = RunSummary()
        summary.postsFound = entries.count
        let total = entries.count

        do {
            try await withThrowingTaskGroup(of: PostOutcome.self) { group in
                var inFlight = 0
                func record(_ outcome: PostOutcome) {
                    inFlight -= 1
                    summary.mediaSaved += outcome.saved
                    summary.mediaReused += outcome.reused
                    summary.mediaFailed += outcome.failed
                    summary.bytesSaved += outcome.bytes
                    if let reason = outcome.failureReason {
                        summary.postsFailed += 1
                        onEvent(.postFailed(index: outcome.index, total: total, entry: outcome.entry, reason: reason))
                    } else {
                        if outcome.isComplete { summary.postsCompleted += 1 } else { summary.postsIncomplete += 1 }
                        onEvent(.postFinished(index: outcome.index, total: total, entry: outcome.entry, folder: outcome.folder, complete: outcome.isComplete))
                    }
                }

                for (offset, entry) in entries.enumerated() {
                    let index = offset + 1
                    await control.waitIfPaused()
                    try Task.checkCancellation()

                    if options.skipCompleted, await store.record(for: entry.id)?.completed == true {
                        summary.postsSkipped += 1
                        onEvent(.postSkipped(index: index, total: total, entry: entry))
                        continue
                    }

                    if inFlight >= Self.maxPostsInFlight, let outcome = try await group.next() {
                        record(outcome)
                    }

                    onEvent(.postStarted(index: index, total: total, entry: entry))
                    do {
                        let prepared = try await prepare(entry, options: options, store: store, onEvent: onEvent)
                        inFlight += 1
                        group.addTask {
                            try await transfer(prepared, index: index, options: options, store: store, downloader: downloader, control: control, onEvent: onEvent)
                        }
                    } catch let error as UncaliveError where error == .loginRequired || error == .challengeTimedOut {
                        throw error
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch {
                        summary.postsFailed += 1
                        onEvent(.postFailed(index: index, total: total, entry: entry, reason: error.localizedDescription))
                    }

                    // 결과와 상관없이 항상 쉬어서 서버에 연속 요청을 보내지 않습니다.
                    if index < total { try await sleep(options.pageDelay) }
                }

                while let outcome = try await group.next() { record(outcome) }
            }
        } catch {
            try? await store.save()
            throw error
        }
        return summary
    }

    // MARK: - 목록

    /// 스크랩 목록을 읽습니다. 페이지마다 이벤트를 보내므로 도중에 취소해도 읽은 부분을 쓸 수 있습니다.
    public func fetchEntries(
        options: DownloadOptions,
        control: RunControl = RunControl(),
        onEvent: @escaping @Sendable (EngineEvent) -> Void = { _ in }
    ) async throws -> [ScrapEntry] {
        try await collect(range: options.pages, since: nil, delay: options.pageDelay, requiresLogin: true, control: control, onEvent: onEvent) {
            ArcaParser.scrapListURL(page: $0)
        }
    }

    /// 스크랩 앞쪽부터 읽어 이미 아는 글이 나오면 멈춥니다.
    /// 확인 주기 사이에 한 페이지가 넘게 스크랩해도 새 글을 놓치지 않습니다.
    public func fetchNewScraps(
        known: Set<String>,
        options: DownloadOptions,
        control: RunControl = RunControl(),
        onEvent: @escaping @Sendable (EngineEvent) -> Void = { _ in }
    ) async throws -> [ScrapEntry] {
        let range = DownloadOptions.PageRange(first: 1, last: nil)
        return try await collect(range: range, since: nil, known: known, delay: options.pageDelay, requiresLogin: true, control: control, onEvent: onEvent) {
            ArcaParser.scrapListURL(page: $0)
        }
    }

    /// 채널이나 검색 결과처럼 사용자가 지정한 목록을 읽습니다.
    public func fetchEntries(
        listURL: URL,
        scope: ListScope,
        delay: TimeInterval,
        control: RunControl = RunControl(),
        onEvent: @escaping @Sendable (EngineEvent) -> Void = { _ in }
    ) async throws -> [ScrapEntry] {
        let range = DownloadOptions.PageRange(first: scope.firstPage, last: scope.lastPage)
        let parts = listURL.path().split(separator: "/").map(String.init)
        let channel = parts.count >= 2 && parts[0] == "b" ? parts[1] : nil
        return try await collect(range: range, since: scope.since, listChannel: channel, delay: delay, requiresLogin: false, control: control, onEvent: onEvent) {
            ArcaParser.listURL(listURL, page: $0)
        }
    }

    private func collect(
        range: DownloadOptions.PageRange,
        since: Date?,
        known: Set<String> = [],
        listChannel: String? = nil,
        delay: TimeInterval,
        requiresLogin: Bool,
        control: RunControl,
        onEvent: @escaping @Sendable (EngineEvent) -> Void,
        url: (Int) -> URL
    ) async throws -> [ScrapEntry] {
        var entries: [ScrapEntry] = []
        var seen = Set<String>()
        let firstPage = max(range.first, 1)
        var page = firstPage

        while true {
            await control.waitIfPaused()
            try Task.checkCancellation()

            let loaded = try await source.load(url(page), kind: .scrapList)
            // 이미 글을 읽은 뒤의 404는 로그아웃이 아니라 목록의 끝입니다.
            if loaded.status == 404, page > firstPage, !entries.isEmpty { break }
            // 로그아웃 상태에서 스크랩 목록은 404로 응답합니다.
            if requiresLogin, loaded.status == 404 { throw UncaliveError.loginRequired }
            guard (200..<300).contains(loaded.status) else { throw UncaliveError.httpStatus(loaded.status) }

            let parsed = try ArcaParser.parseScrapList(html: loaded.html)
            if requiresLogin, !parsed.isLoggedIn { throw UncaliveError.loginRequired }

            if page == firstPage, let username = parsed.username {
                onEvent(.accountFound(username: username))
            }

            let unseen = parsed.entries
                .filter { seen.insert($0.id).inserted }
                .map { $0.channel == listChannel ? $0.inSingleChannelList : $0 }
            // 작성일을 모르는 글은 안전하게 남깁니다.
            let fresh = unseen.filter { entry in
                guard !known.contains(entry.id) else { return false }
                guard let since, let date = entry.date else { return true }
                return date >= since
            }
            let reachedKnown = unseen.contains { known.contains($0.id) }
            entries += fresh
            onEvent(.listPageRead(page: page, entries: fresh, total: entries.count, highestVisiblePage: parsed.highestVisiblePage))

            if unseen.isEmpty || fresh.isEmpty || reachedKnown || page >= parsed.highestVisiblePage { break }
            if let last = range.last, page >= last { break }
            page += 1
            try await sleep(delay)
        }
        onEvent(.listFinished(total: entries.count))
        return entries
    }

    // MARK: - 게시글

    /// 파일을 받는 중에 미리 읽어 둘 글의 수입니다.
    private static let maxPostsInFlight = 3

    private struct Job: Sendable {
        let media: MediaRef
        let subfolder: String?
        let baseName: String
        let isAsset: Bool
    }

    private struct PreparedPost: Sendable {
        let entry: ScrapEntry
        let post: ParsedPost
        let folderName: String
        let folder: URL
        let paths: [String: String]
        let pending: [Job]
        let reused: Int
    }

    private struct PostOutcome: Sendable {
        let index: Int
        let entry: ScrapEntry
        var folder = ""
        var saved = 0
        var reused = 0
        var failed = 0
        /// 원본을 원했지만 표시용으로 대체된 파일 수입니다. 다음 실행 때 다시 시도합니다.
        var downgraded = 0
        var bytes: Int64 = 0
        var failureReason: String?

        var isComplete: Bool { failed == 0 && downgraded == 0 }
    }

    private enum JobResult: Sendable {
        case saved(Job, DownloadedFile, downgraded: Bool)
        case failed(Job, String)
    }

    /// 페이지를 읽고 받을 파일을 정합니다. 웹뷰를 쓰는 작업은 모두 여기서 끝냅니다.
    private func prepare(
        _ entry: ScrapEntry,
        options: DownloadOptions,
        store: ResumeStore,
        onEvent: @escaping @Sendable (EngineEvent) -> Void
    ) async throws -> PreparedPost {
        let loaded = try await source.load(entry.url, kind: .post)
        guard (200..<300).contains(loaded.status) else { throw UncaliveError.postUnavailable(status: loaded.status) }
        var post = try ArcaParser.parsePost(html: loaded.html, url: entry.url)

        if !post.embeds.isEmpty {
            onEvent(.warning("외부 임베드 \(post.embeds.count)개는 파일로 받을 수 없어 링크로 남깁니다: \(post.title)"))
        }

        var preferred = FileNaming.folderName(for: post, options: options)
        if options.groupByChannel {
            preferred = FileNaming.sanitize(post.channel, maxCharacters: 50) + "/" + preferred
        }
        if let source = options.source { preferred = source.rawValue + "/" + preferred }
        // 이미 받은 글은 어느 목록에서 다시 받든 처음 폴더를 그대로 씁니다.
        let folderName = await store.reserveFolder(for: post, preferred: preferred, channelName: entry.channelName)
        let folder = options.destination.appending(path: folderName)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        if options.archive.webArchive {
            do {
                try await source.webArchiveData().write(to: folder.appending(path: "page.webarchive"), options: .atomic)
            } catch {
                onEvent(.warning("웹 아카이브 저장 실패: \(error.localizedDescription)"))
            }
        }
        if options.archive.rawHTML {
            try loaded.html.write(to: folder.appending(path: "page.html"), atomically: true, encoding: .utf8)
        }

        // 글을 열면 댓글의 마지막 페이지만 보이므로 앞쪽 페이지를 따로 읽습니다.
        if options.archive.offlineHTML, options.archive.includeComments, post.commentPages > 1 {
            var earlier: [ParsedComment] = []
            for page in 1..<post.commentPages {
                try await sleep(options.pageDelay)
                do {
                    let extra = try await source.load(ArcaParser.commentPageURL(entry.url, page: page), kind: .post)
                    guard (200..<300).contains(extra.status) else { throw UncaliveError.httpStatus(extra.status) }
                    earlier += try ArcaParser.parseCommentPage(html: extra.html)
                } catch let error as UncaliveError where error == .loginRequired || error == .challengeTimedOut {
                    throw error
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    onEvent(.warning("댓글 \(page)페이지를 불러오지 못했습니다: \(post.title)"))
                }
            }
            post.comments = earlier + post.comments
        }

        var paths: [String: String] = await store.record(for: post.id)?.files ?? [:]
        paths = paths.filter { FileManager.default.fileExists(atPath: folder.appending(path: $0.value).path(percentEncoded: false)) }

        let allJobs = Self.jobs(for: post, options: options)
        let pending = allJobs.filter { paths[$0.media.key] == nil }
        onEvent(.mediaStarted(postID: post.id, count: pending.count))

        if pending.contains(where: { $0.subfolder != nil }) {
            try FileManager.default.createDirectory(at: folder.appending(path: "assets"), withIntermediateDirectories: true)
        }
        return PreparedPost(
            entry: entry, post: post, folderName: folderName, folder: folder,
            paths: paths, pending: pending, reused: allJobs.count - pending.count
        )
    }

    /// 한 글의 파일을 받고 보관본을 씁니다. 연결 수는 `MediaDownloader`의 제한기가 지킵니다.
    private func transfer(
        _ prepared: PreparedPost,
        index: Int,
        options: DownloadOptions,
        store: ResumeStore,
        downloader: MediaDownloader,
        control: RunControl,
        onEvent: @escaping @Sendable (EngineEvent) -> Void
    ) async throws -> PostOutcome {
        let post = prepared.post
        var outcome = PostOutcome(index: index, entry: prepared.entry, folder: prepared.folderName, reused: prepared.reused)
        var paths = prepared.paths
        let delay = options.mediaDelay
        let sleep = sleep

        try await withThrowingTaskGroup(of: JobResult.self) { group in
            for job in prepared.pending {
                group.addTask {
                    await control.waitIfPaused()
                    try Task.checkCancellation()
                    let directory = job.subfolder.map { prepared.folder.appending(path: $0) } ?? prepared.folder
                    // 오프라인 페이지 장식용 파일은 원본 서버의 연결을 쓰지 않습니다.
                    let quality = job.isAsset ? DownloadOptions.Quality.display : options.quality
                    let plan = await downloader.plan(job.media, quality: quality)
                    let result: JobResult
                    do {
                        let file = try await downloader.download(
                            plan,
                            directory: directory,
                            baseName: job.baseName,
                            progress: { received, expected in
                                onEvent(.mediaProgress(postID: post.id, key: job.media.key, received: received, expected: expected))
                            }
                        )
                        let wantedOriginal = job.media.prefersOriginal(quality) && job.media.originalURL != nil
                        result = .saved(job, file, downgraded: wantedOriginal && !file.usedOriginal)
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch {
                        result = .failed(job, error.localizedDescription)
                    }
                    try await sleep(delay)
                    return result
                }
            }

            while let result = try await group.next() {
                switch result {
                case .saved(let job, let file, let downgraded):
                    let relative = job.subfolder.map { "\($0)/\(file.fileName)" } ?? file.fileName
                    paths[job.media.key] = relative
                    outcome.saved += 1
                    outcome.bytes += file.bytes
                    onEvent(.mediaSaved(postID: post.id, key: job.media.key, fileName: relative, bytes: file.bytes, usedOriginal: file.usedOriginal))
                    if downgraded {
                        // 기록하지 않아서 다음 실행 때 원본을 다시 시도합니다.
                        outcome.downgraded += 1
                        onEvent(.warning("원본을 받지 못해 웹 표시용으로 저장했습니다: \(post.title) / \(file.fileName) (\(file.fallbackReason ?? "사유 없음"))"))
                    } else {
                        await store.setFile(relative, forKey: job.media.key, postID: post.id)
                    }
                case .failed(let job, let reason):
                    if !job.isAsset { outcome.failed += 1 }
                    onEvent(.mediaFailed(postID: post.id, key: job.media.key, reason: reason))
                }
            }
        }

        do {
            try PostArchiver.write(post: post, paths: paths, options: options.archive, to: prepared.folder)
            try LibraryStore.writeText(PostArchiver.searchableText(of: post), postID: post.id, root: options.destination)
            try await store.finish(postID: post.id, completed: outcome.isComplete)
        } catch {
            outcome.failureReason = error.localizedDescription
        }
        return outcome
    }

    /// 번호를 붙일 파일과, 오프라인 페이지에만 쓰는 `assets/` 파일을 구분합니다.
    private static func jobs(for post: ParsedPost, options: DownloadOptions) -> [Job] {
        let selected = post.media.filter { media in
            switch media.kind {
            case .image: options.includeImages
            case .video: options.includeVideos
            case .audio: options.includeAudio
            case .emoticon: options.includeEmoticons
            case .poster: options.includeVideoPosters
            }
        }
        var jobs = selected.enumerated().map { offset, media in
            Job(
                media: media,
                subfolder: nil,
                baseName: FileNaming.baseName(sequence: offset + 1, total: selected.count, media: media, naming: options.fileNaming),
                isAsset: false
            )
        }

        guard options.archive.offlineHTML else { return jobs }
        var known = Set(selected.map(\.key))
        var extras = post.media.filter { $0.kind == .emoticon || ($0.kind == .poster && options.includeVideos) }
        if options.archive.includeComments { extras += post.comments.flatMap(\.media) }
        for media in extras where known.insert(media.key).inserted {
            jobs.append(Job(media: media, subfolder: "assets", baseName: assetName(for: media), isAsset: true))
        }
        return jobs
    }

    private static func assetName(for media: MediaRef) -> String {
        let digest = SHA256.hash(data: Data(media.key.utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }
}
