import Foundation
import ImageIO
import Testing
@testable import UncaliveCore

/// URLProtocol 처리기를 공유하므로 두 묶음 전체를 차례대로 실행합니다.
@Suite(.serialized) enum NetworkTests {}

extension NetworkTests {
@Suite struct DownloadTests {
    private func downloader(retryCount: Int = 2) -> MediaDownloader {
        MediaDownloader(session: StubProtocol.session(), retryCount: retryCount, retryDelay: { _ in })
    }

    private let original = URL(string: "https://ac-o.arca.live/a.jpg")!
    private let display = URL(string: "https://ac.arca.live/a.jpg")!

    private func listing(_ folder: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false)).sorted()
    }

    @Test func 형식에_맞는_확장자로_저장한다() async throws {
        let folder = try temporaryDirectory()
        StubProtocol.install { _ in .init(type: "image/webp; charset=binary") }
        let file = try await downloader().download(candidates: [original, display], directory: folder, baseName: "01")
        #expect(file.fileName == "01.webp")
        #expect(file.bytes == 5)
        #expect(file.usedOriginal)
        #expect(try listing(folder) == ["01.webp"])
    }

    @Test func 원본이_없으면_표시용으로_대체한다() async throws {
        let folder = try temporaryDirectory()
        StubProtocol.install { $0.host() == "ac-o.arca.live" ? .init(status: 404) : .init() }
        let file = try await downloader().download(candidates: [original, display], directory: folder, baseName: "01")
        #expect(file.usedOriginal == false)
        #expect(StubProtocol.requests.count == 2)
    }

    private let media = MediaRef(
        kind: .video,
        displayURL: URL(string: "https://ac.arca.live/a.mp4")!,
        originalURL: URL(string: "https://ac-o.arca.live/a.mp4")!
    )

    @Test func ETag가_같으면_CDN을_먼저_쓴다() async throws {
        StubProtocol.install { _ in .init(type: "video/mp4", etag: "\"same\"") }
        let plan = await downloader().plan(media, quality: .original)
        #expect(plan.identicalToOriginal)
        #expect(plan.candidates.first?.host() == "ac.arca.live")
    }

    @Test func ETag가_다르면_원본_서버를_쓴다() async throws {
        StubProtocol.install { .init(etag: $0.host() == "ac.arca.live" ? "\"small\"" : "\"big\"") }
        let plan = await downloader().plan(media, quality: .original)
        #expect(plan.identicalToOriginal == false)
        #expect(plan.candidates.first?.host() == "ac-o.arca.live")
    }

    @Test func 원본_서버가_거부하면_원본_우선을_유지한다() async throws {
        StubProtocol.install { $0.host() == "ac-o.arca.live" ? .init(status: 429) : .init(etag: "\"same\"") }
        let plan = await downloader().plan(media, quality: .original)
        #expect(plan.identicalToOriginal == false)
        #expect(plan.candidates.first?.host() == "ac-o.arca.live")
    }

    @Test func 표시용_화질은_확인_요청을_보내지_않는다() async throws {
        StubProtocol.install { _ in .init() }
        _ = await downloader().plan(media, quality: .display)
        #expect(StubProtocol.headRequests.isEmpty)
    }

    @Test func 큰_원본은_조각으로_받아_그대로_합친다() async throws {
        let folder = try temporaryDirectory()
        let body = Data((0..<2_500_000).map { UInt8($0 % 251) })
        StubProtocol.install { .init(type: "video/mp4", body: body, etag: $0.host() == "ac.arca.live" ? "\"a\"" : "\"b\"", supportsRanges: true) }
        let subject = downloader()
        let plan = await subject.plan(media, quality: .original)
        #expect(plan.originalBytes == 2_500_000)

        let file = try await subject.download(plan, directory: folder, baseName: "01")
        #expect(try Data(contentsOf: folder.appending(path: file.fileName)) == body)
        #expect(StubProtocol.requests.count == 3)
        #expect(file.usedOriginal)
        #expect(try listing(folder) == ["01.mp4"])
    }

    @Test func 나눠_받기를_거부하면_한_번에_받는다() async throws {
        let folder = try temporaryDirectory()
        let body = Data(repeating: 7, count: 2_500_000)
        StubProtocol.install { .init(type: "video/mp4", body: body, etag: $0.host() == "ac.arca.live" ? "\"a\"" : "\"b\"") }
        let subject = downloader()
        let file = try await subject.download(await subject.plan(media, quality: .original), directory: folder, baseName: "01")
        #expect(file.bytes == 2_500_000)
        #expect(try listing(folder) == ["01.mp4"])
    }

    @Test func 축소된_원본을_받으면_다음_후보로_넘어간다() async throws {
        let folder = try temporaryDirectory()
        let tinyPNG = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")!
        StubProtocol.install { _ in .init(type: "image/png", body: tinyPNG) }
        var plan = DownloadPlan(candidates: [original, display])
        plan.expectedLongSide = 100
        let file = try await downloader().download(plan, directory: folder, baseName: "01")
        #expect(file.usedOriginal == false)
        #expect(StubProtocol.requests.map { $0.host() } == ["ac-o.arca.live", "ac.arca.live"])
    }

    /// 가로 1, 세로 2인 이미지입니다.
    private func portraitPNG() throws -> Data {
        let context = CGContext(data: nil, width: 1, height: 2, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }

    @Test func 본문_크기와_가로세로가_뒤집힌_원본을_축소로_오해하지_않는다() async throws {
        let folder = try temporaryDirectory()
        let picture = try portraitPNG()
        StubProtocol.install { _ in .init(type: "image/png", body: picture) }
        let photo = MediaRef(kind: .image, displayURL: display, originalURL: original, width: 2, height: 1)
        var plan = await downloader().plan(photo, quality: .original)
        #expect(plan.expectedLongSide == 2)
        plan.candidates = [original, display]
        let file = try await downloader().download(plan, directory: folder, baseName: "01")
        #expect(file.usedOriginal)
        #expect(StubProtocol.requests.count == 1)
    }

    @Test func 형식을_몰라도_내용으로_판별해_저장한다() async throws {
        let folder = try temporaryDirectory()
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0])
        StubProtocol.install { _ in .init(type: "application/octet-stream", body: png) }
        let url = URL(string: "https://ac.arca.live/noext")!
        let file = try await downloader().download(candidates: [url], directory: folder, baseName: "01")
        #expect(file.fileName == "01.png")
    }

    @Test func 판별이_안_돼도_버리지_않는다() async throws {
        let folder = try temporaryDirectory()
        StubProtocol.install { _ in .init(type: "application/x-unknown", body: Data(repeating: 1, count: 32)) }
        let named = URL(string: "https://ac.arca.live/a.xyz")!
        #expect(try await downloader().download(candidates: [named], directory: folder, baseName: "01").fileName == "01.xyz")
        let bare = URL(string: "https://ac.arca.live/noext")!
        #expect(try await downloader().download(candidates: [bare], directory: folder, baseName: "02").fileName == "02.bin")
    }

    @Test func 빈_파일은_저장하지_않는다() async throws {
        let folder = try temporaryDirectory()
        StubProtocol.install { _ in .init(body: Data()) }
        await #expect(throws: UncaliveError.incompleteFile) {
            try await downloader(retryCount: 1).download(candidates: [display], directory: folder, baseName: "01")
        }
        #expect(try listing(folder).isEmpty)
    }

    @Test func 내장_이미지를_파일로_푼다() async throws {
        let folder = try temporaryDirectory()
        let url = URL(string: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")!
        let file = try await downloader().download(candidates: [url], directory: folder, baseName: "01")
        #expect(file.fileName == "01.gif")
        #expect(try listing(folder) == ["01.gif"])
    }

    @Test func 일시적_오류는_재시도한다() async throws {
        let folder = try temporaryDirectory()
        let counter = Counter()
        StubProtocol.install { _ in counter.next() < 3 ? .init(status: 503) : .init() }
        _ = try await downloader(retryCount: 3).download(candidates: [display], directory: folder, baseName: "01")
        #expect(StubProtocol.requests.count == 3)
    }

    @Test func 영구_오류는_재시도하지_않는다() async throws {
        let folder = try temporaryDirectory()
        StubProtocol.install { _ in .init(status: 403) }
        await #expect(throws: UncaliveError.httpStatus(403)) {
            try await downloader(retryCount: 3).download(candidates: [display], directory: folder, baseName: "01")
        }
        #expect(StubProtocol.requests.count == 1)
    }

    @Test func 오류_페이지를_이미지로_저장하지_않는다() async throws {
        let folder = try temporaryDirectory()
        StubProtocol.install { _ in .init(type: "text/html") }
        await #expect(throws: UncaliveError.unsupportedMedia("text/html")) {
            try await downloader().download(candidates: [display], directory: folder, baseName: "01")
        }
        #expect(try listing(folder).isEmpty)
    }
}

}

@Suite struct LimiterTests {
    @Test func 동시_실행_수를_넘지_않는다() async throws {
        let limiter = Limiter(limit: 2)
        let gauge = Gauge()
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<20 {
                group.addTask {
                    try await limiter.withSlot {
                        gauge.enter()
                        try await Task.sleep(for: .milliseconds(5))
                        gauge.leave()
                    }
                }
            }
            try await group.waitForAll()
        }
        #expect(gauge.peak == 2)
    }

    @Test func 급한_요청이_먼저_슬롯을_받는다() async throws {
        let limiter = Limiter(limit: 1)
        let order = Order()
        let gate = Gate()
        let holder = Task { try await limiter.withSlot { await gate.wait() } }
        try await Task.sleep(for: .milliseconds(20))
        let normal = Task { try await limiter.withSlot { order.add("normal") } }
        try await Task.sleep(for: .milliseconds(20))
        let urgent = Task { try await limiter.withSlot(urgent: true) { order.add("urgent") } }
        try await Task.sleep(for: .milliseconds(20))
        await gate.open()
        _ = try await (holder.value, normal.value, urgent.value)
        #expect(order.values == ["urgent", "normal"])
    }
}

final class Gauge: @unchecked Sendable {
    private let lock = NSLock()
    private var current = 0
    private var highest = 0
    func enter() { lock.withLock { current += 1; highest = max(highest, current) } }
    func leave() { lock.withLock { current -= 1 } }
    var peak: Int { lock.withLock { highest } }
}

final class Order: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ item: String) { lock.withLock { items.append(item) } }
    var values: [String] { lock.withLock { items } }
}

actor Gate {
    private var waiter: CheckedContinuation<Void, Never>?
    func wait() async { await withCheckedContinuation { waiter = $0 } }
    func open() { waiter?.resume() }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func next() -> Int { lock.withLock { value += 1; return value } }
}

final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var delays: [TimeInterval] = []
    func add(_ delay: TimeInterval) { lock.withLock { delays.append(delay) } }
    var values: [TimeInterval] { lock.withLock { delays } }
}

extension NetworkTests {
@Suite struct EngineTests {
    private static func site() throws -> [String: LoadedPage] {
        [
            "/b/testchannel/4001": LoadedPage(html: try Fixture.html("post_comment_pages"), status: 200),
            "/b/testchannel/4001?cp=1": LoadedPage(html: try Fixture.html("post_comment_page1"), status: 200),
            "/b/testchannel?mode=best&p=1": LoadedPage(html: try Fixture.html("channel_list"), status: 200),
            "/b/testchannel?mode=best&p=2": LoadedPage(html: try Fixture.html("scrap_list_empty"), status: 200),
            "/u/scrap_list?p=1": LoadedPage(html: try Fixture.html("scrap_list_page1"), status: 200),
            "/u/scrap_list?p=2": LoadedPage(html: try Fixture.html("scrap_list_page2"), status: 200),
            "/b/testchannel/1001": LoadedPage(html: try Fixture.html("post_full"), status: 200),
            "/b/testchannel/1002": LoadedPage(html: try Fixture.html("post_no_media"), status: 200)
        ]
    }

    private func engine(_ source: FakePageSource, sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { _ in }) -> ScrapEngine {
        ScrapEngine(source: source, session: StubProtocol.session(), sleep: sleep, retryDelay: { _ in })
    }

    private func contentType(_ url: URL) -> StubProtocol.Response {
        switch url.pathExtension {
        case "mp4": .init(type: "video/mp4")
        case "webp": .init(type: "image/webp")
        case "png": .init(type: "image/png")
        default: .init()
        }
    }

    private func exists(_ root: URL, _ path: String) -> Bool {
        FileManager.default.fileExists(atPath: root.appending(path: path).path(percentEncoded: false))
    }

    @Test func 전체_흐름으로_파일과_보관본을_만든다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        let source = FakePageSource(try Self.site())
        let summary = try await engine(source).run(options: options(root))

        #expect(summary.postsFound == 3)
        #expect(summary.postsCompleted == 2)
        #expect(summary.postsFailed == 1) // 픽스처에 없는 2001번 글은 404입니다.
        let folder = "첫 번째_ 글_제목"
        #expect(exists(root, "\(folder)/01.jpg"))
        #expect(exists(root, "\(folder)/02.mp4"))
        #expect(exists(root, "\(folder)/03.png"))
        #expect(exists(root, "\(folder)/index.html"))
        #expect(exists(root, "\(folder)/post.json"))
        #expect(exists(root, "\(folder)/assets"))
        #expect(StubProtocol.requests.contains { $0.host() == "ac-o.arca.live" && $0.path() == "/2026/photo.jpg" })
    }

    @Test func 다시_실행해도_폴더를_늘리지_않고_건너뛴다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        let first = FakePageSource(try Self.site())
        _ = try await engine(first).run(options: options(root))
        let foldersBefore = try FileManager.default.contentsOfDirectory(atPath: root.path(percentEncoded: false)).sorted()
        let requestsBefore = StubProtocol.requests.count

        let second = FakePageSource(try Self.site())
        let summary = try await engine(second).run(options: options(root))

        #expect(summary.postsSkipped == 2)
        #expect(StubProtocol.requests.count == requestsBefore)
        #expect(second.requests.contains("/b/testchannel/1001") == false)
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path(percentEncoded: false)).sorted() == foldersBefore)
    }

    @Test func 실패한_파일만_이어서_받는다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install { [self] url in url.pathExtension == "mp4" ? .init(status: 500) : contentType(url) }
        let first = try await engine(FakePageSource(try Self.site())).run(options: options(root))
        #expect(first.postsIncomplete == 1)
        #expect(first.mediaFailed == 1)

        StubProtocol.install(contentType)
        let second = try await engine(FakePageSource(try Self.site())).run(options: options(root))
        #expect(second.mediaSaved == 1)
        #expect(second.mediaReused > 0)
        #expect(StubProtocol.requests.allSatisfy { $0.pathExtension == "mp4" })
        #expect(exists(root, "첫 번째_ 글_제목/02.mp4"))
        #expect(exists(root, "첫 번째_ 글_제목_1") == false)
    }

    @Test func 제목이_같은_다른_글은_번호를_붙인다() async throws {
        let root = try temporaryDirectory()
        let store = try ResumeStore(root: root)
        func post(_ id: String) -> ParsedPost {
            ParsedPost(id: id, channel: "c", url: URL(string: "https://arca.live/b/c/\(id)")!, title: "같은 제목", category: nil, author: nil, createdAt: nil, contentHTML: "", media: [], comments: [])
        }
        #expect(await store.reserveFolder(for: post("1"), preferred: "같은 제목") == "같은 제목")
        #expect(await store.reserveFolder(for: post("2"), preferred: "같은 제목") == "같은 제목_1")
        #expect(await store.reserveFolder(for: post("1"), preferred: "같은 제목") == "같은 제목")
    }

    @Test func 미디어가_없는_글_뒤에도_대기한다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        var opts = options(root)
        opts.pageDelay = 7
        opts.pages.last = 1
        let delays = Recorder()
        _ = try await engine(FakePageSource(try Self.site()), sleep: { delays.add($0) }).run(options: opts)
        #expect(delays.values.filter { $0 == 7 }.count == 1) // 글 2개 사이의 대기
    }

    @Test func 같은_파일은_원본_서버에서_내려받지_않는다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install { [self] url in
            var response = contentType(url)
            response.etag = "\"\(url.lastPathComponent)\""
            return response
        }
        var events = options(root)
        events.pages.last = 1
        _ = try await engine(FakePageSource(try Self.site())).run(options: events)
        #expect(StubProtocol.requests.allSatisfy { $0.host() != "ac-o.arca.live" })
        #expect(exists(root, "첫 번째_ 글_제목/02.mp4"))
    }

    @Test func 원본_대신_표시용을_받으면_경고한다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install { [self] url in url.host() == "ac-o.arca.live" ? .init(status: 404) : contentType(url) }
        var opts = options(root)
        opts.pages.last = 1
        let warnings = Recorder()
        _ = try await engine(FakePageSource(try Self.site())).run(options: opts) { event in
            if case .warning(let text) = event, text.contains("표시용") { warnings.add(1) }
        }
        #expect(warnings.values.count == 2) // 이미지와 동영상
    }

    @Test func 표시용으로_대체된_글은_다음_실행에서_원본을_다시_받는다() async throws {
        let root = try temporaryDirectory()
        var opts = options(root)
        opts.pages.last = 1
        StubProtocol.install { [self] url in url.host() == "ac-o.arca.live" ? .init(status: 404) : contentType(url) }
        let first = try await engine(FakePageSource(try Self.site())).run(options: opts)
        #expect(first.postsIncomplete == 1)

        StubProtocol.install(contentType)
        _ = try await engine(FakePageSource(try Self.site())).run(options: opts)
        #expect(StubProtocol.requests.contains { $0.host() == "ac-o.arca.live" && $0.path() == "/2026/photo.jpg" })
    }

    @Test func 균형_화질은_작은_이미지를_CDN에서_받는다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        var opts = options(root)
        opts.pages.last = 1
        opts.quality = .balanced
        let summary = try await engine(FakePageSource(try Self.site())).run(options: opts)
        #expect(summary.postsIncomplete == 0)
        #expect(StubProtocol.requests.contains { $0.host() == "ac.arca.live" && $0.path() == "/2026/photo.jpg" })
        #expect(StubProtocol.requests.contains { $0.host() == "ac-o.arca.live" && $0.path() == "/2026/clip.mp4" })
    }

    @Test func 나뉜_댓글을_모두_모아_순서대로_저장한다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install { [self] url in
            url.pathExtension == "mp3" ? .init(type: "audio/mpeg") : contentType(url)
        }
        let source = FakePageSource(try Self.site())
        let entry = ScrapEntry(id: "4001", channel: "testchannel", channelName: nil, url: URL(string: "https://arca.live/b/testchannel/4001")!, title: "t", author: nil, createdAt: nil)
        let warnings = Recorder()
        let summary = try await engine(source).download([entry], options: options(root)) { event in
            if case .warning(let text) = event, text.contains("임베드") { warnings.add(1) }
        }
        #expect(summary.postsCompleted == 1)
        #expect(warnings.values.count == 1)
        #expect(source.requests.contains("/b/testchannel/4001?cp=1"))

        let html = try String(contentsOf: root.appending(path: "댓글 많은 글/index.html"), encoding: .utf8)
        let first = try #require(html.range(of: "첫 페이지 댓글"))
        let last = try #require(html.range(of: "마지막 페이지 댓글"))
        #expect(first.lowerBound < last.lowerBound)
        #expect(html.contains("<audio"))
        #expect(html.contains("[저장되지 않은") == false)
        #expect(exists(root, "댓글 많은 글/01.mp3"))
        #expect(exists(root, "댓글 많은 글/03.gif"))
    }

    @Test func 지정한_목록을_범위만큼만_읽는다() async throws {
        let source = FakePageSource(try Self.site())
        let entries = try await engine(source).fetchEntries(
            listURL: URL(string: "https://arca.live/b/testchannel?mode=best")!,
            scope: ListScope(firstPage: 1, lastPage: 1),
            delay: 0
        )
        #expect(entries.map(\.id) == ["3001", "3002"])
        #expect(entries[0].channelName == nil)
        #expect(entries[0].category == "일반")
        #expect(source.requests == ["/b/testchannel?mode=best&p=1"])
    }

    @Test func 마지막_페이지_뒤의_404를_로그아웃으로_오해하지_않는다() async throws {
        // 1페이지는 2페이지가 있다고 표시하지만 2페이지는 404입니다.
        let source = FakePageSource(["/u/scrap_list?p=1": LoadedPage(html: try Fixture.html("scrap_list_page1"), status: 200)])
        let entries = try await engine(source).fetchEntries(options: options(try temporaryDirectory()))
        #expect(entries.map(\.id) == ["1001", "1002"])
        #expect(source.requests == ["/u/scrap_list?p=1", "/u/scrap_list?p=2"])
    }

    @Test func 한_페이지가_넘는_새_스크랩도_찾는다() async throws {
        let source = FakePageSource(try Self.site())
        let new = try await engine(source).fetchNewScraps(known: ["2001"], options: options(try temporaryDirectory()))
        #expect(new.map(\.id) == ["1001", "1002"])
        #expect(source.requests == ["/u/scrap_list?p=1", "/u/scrap_list?p=2"])
    }

    @Test func 아는_글이_나오면_다음_페이지를_읽지_않는다() async throws {
        let source = FakePageSource(try Self.site())
        let new = try await engine(source).fetchNewScraps(known: ["1002"], options: options(try temporaryDirectory()))
        #expect(new.map(\.id) == ["1001"])
        #expect(source.requests == ["/u/scrap_list?p=1"])
    }

    @Test func 끝까지_읽으면_글이_없는_페이지에서_멈춘다() async throws {
        let source = FakePageSource(try Self.site())
        let entries = try await engine(source).fetchEntries(
            listURL: URL(string: "https://arca.live/b/testchannel?mode=best")!,
            scope: ListScope(firstPage: 1, lastPage: nil),
            delay: 0
        )
        #expect(entries.count == 2)
        #expect(source.requests.count == 2)
    }

    @Test func 기준일보다_오래된_글을_빼고_멈춘다() async throws {
        let source = FakePageSource(try Self.site())
        let since = try Date.ISO8601FormatStyle().parse("2026-01-01T00:00:00Z")
        let entries = try await engine(source).fetchEntries(
            listURL: URL(string: "https://arca.live/b/testchannel?mode=best")!,
            scope: ListScope(firstPage: 1, lastPage: nil, since: since),
            delay: 0
        )
        #expect(entries.map(\.id) == ["3001"])
    }

    @Test func 출처별_폴더에_저장한다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        var opts = options(root)
        opts.pages.last = 1
        opts.source = .scrap
        _ = try await engine(FakePageSource(try Self.site())).run(options: opts)

        #expect(exists(root, "스크랩/첫 번째_ 글_제목/01.jpg"))
        #expect(exists(root, "스크랩/첫 번째_ 글_제목/index.html"))
        let posts = await LibraryStore.load(root: root)
        #expect(posts.count == 2)
        #expect(posts.allSatisfy { $0.source == .scrap })
    }

    @Test func 양쪽_목록에_있는_글은_처음_폴더에만_둔다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        var opts = options(root)
        opts.pages.last = 1
        opts.source = .collection
        opts.skipCompleted = false
        _ = try await engine(FakePageSource(try Self.site())).run(options: opts)
        let before = StubProtocol.requests.count

        opts.source = .scrap
        let summary = try await engine(FakePageSource(try Self.site())).run(options: opts)
        #expect(summary.mediaReused > 0)
        #expect(StubProtocol.requests.count == before)
        #expect(exists(root, "주소 수집/첫 번째_ 글_제목/01.jpg"))
        #expect(exists(root, "스크랩") == false)
        #expect(await LibraryStore.load(root: root).allSatisfy { $0.source == .collection })
    }

    @Test func 구분이_없던_글은_출처가_없다() {
        #expect(ArchiveSource(folder: "그냥 제목") == nil)
        #expect(ArchiveSource(folder: "스크랩") == nil)
        #expect(ArchiveSource(folder: "주소 수집/제목") == .collection)
    }

    @Test func 지운_폴더와_파일을_기록에서_뺀다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        var opts = options(root)
        opts.pages.last = 1
        _ = try await engine(FakePageSource(try Self.site())).run(options: opts)

        let fm = FileManager.default
        try fm.removeItem(at: root.appending(path: "두 번째 글"))
        try fm.removeItem(at: root.appending(path: "첫 번째_ 글_제목/01.jpg"))

        let records = try await ResumeStore(root: root).liveRecords()
        #expect(records.map(\.id) == ["1001"])
        #expect(records[0].completed == false)
        #expect(records[0].files.values.contains("01.jpg") == false)
        #expect(await LibraryStore.load(root: root).map(\.id) == ["1001"])
    }

    @Test func 지운_글을_다시_받으면_같은_자리에_복구한다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        var opts = options(root)
        opts.pages.last = 1
        opts.skipCompleted = false
        _ = try await engine(FakePageSource(try Self.site())).run(options: opts)
        try FileManager.default.removeItem(at: root.appending(path: "첫 번째_ 글_제목"))

        _ = try await engine(FakePageSource(try Self.site())).run(options: opts)
        #expect(exists(root, "첫 번째_ 글_제목/01.jpg"))
        #expect(exists(root, "첫 번째_ 글_제목_1") == false)
    }

    @Test func 보관함이_글_정보와_본문을_찾는다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        var opts = options(root)
        opts.pages.last = 1
        _ = try await engine(FakePageSource(try Self.site())).run(options: opts)

        let items = await LibraryStore.load(root: root)
        let item = try #require(items.first { $0.id == "1001" })
        #expect(item.channel == "testchannel")
        #expect(item.channelName == "테스트")
        #expect(item.category == "유머")
        #expect(item.author == "작성자A")
        #expect(item.matches("본문 글자"))
        #expect(item.matches("댓글러"))
        #expect(item.snippet(for: "본문")?.contains("본문") == true)
    }

    @Test func 이전_버전으로_받은_글도_보관함에서_보완한다() async throws {
        let root = try temporaryDirectory()
        let folder = root.appending(path: "옛글")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appending(path: ".uncalive"), withIntermediateDirectories: true)
        try Data(#"{"version":1,"posts":{"7":{"id":"7","folder":"옛글","title":"옛 제목","completed":true,"files":{},"updatedAt":"2026-01-01T00:00:00Z"}}}"#.utf8)
            .write(to: root.appending(path: ".uncalive/state.json"))
        try Data(#"{"channel":"oldch","category":"질문","author":"글쓴이"}"#.utf8).write(to: folder.appending(path: "post.json"))
        try "<html><body><p>옛날 본문</p></body></html>".write(to: folder.appending(path: "index.html"), atomically: true, encoding: .utf8)

        let item = try #require(await LibraryStore.load(root: root).first)
        #expect(item.channel == "oldch")
        #expect(item.category == "질문")
        #expect(item.matches("옛날 본문"))
        #expect(exists(root, ".uncalive/text/7.txt"))
    }

    @Test func 고른_글만_받는다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        let source = FakePageSource(try Self.site())
        let all = try await engine(source).fetchEntries(options: options(root))
        #expect(all.map(\.id) == ["1001", "1002", "2001"])

        let summary = try await engine(source).download([all[1]], options: options(root))
        #expect(summary.postsCompleted == 1)
        #expect(source.requests.contains("/b/testchannel/1001") == false)
        #expect(exists(root, "두 번째 글/index.html"))
    }

    @Test func 로그아웃_상태면_바로_멈춘다() async throws {
        let root = try temporaryDirectory()
        let notFound = FakePageSource([:])
        await #expect(throws: UncaliveError.loginRequired) {
            try await engine(notFound).run(options: options(root))
        }
        let loggedOut = FakePageSource(["/u/scrap_list?p=1": LoadedPage(html: try Fixture.html("logged_out"), status: 200)])
        await #expect(throws: UncaliveError.loginRequired) {
            try await engine(loggedOut).run(options: options(root))
        }
    }

    @Test func 옵션대로_종류를_거르고_보관본을_끈다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        var opts = options(root)
        opts.pages.last = 1
        opts.includeVideos = false
        opts.quality = .display
        opts.archive.offlineHTML = false
        opts.archive.metadataJSON = false
        opts.archive.webArchive = true
        _ = try await engine(FakePageSource(try Self.site())).run(options: opts)

        let folder = "첫 번째_ 글_제목"
        #expect(StubProtocol.requests.allSatisfy { $0.pathExtension != "mp4" && $0.host() != "ac-o.arca.live" })
        #expect(exists(root, "\(folder)/index.html") == false)
        #expect(exists(root, "\(folder)/page.webarchive"))
        #expect(exists(root, "\(folder)/assets") == false)
    }

    @Test func 일시정지하면_멈췄다가_재개하면_끝까지_받는다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        var opts = options(root)
        opts.pages.last = 1
        let source = FakePageSource(try Self.site())
        let control = RunControl()
        await control.pause()

        let subject = engine(source)
        let task = Task { try await subject.run(options: opts, control: control) }
        try await Task.sleep(for: .milliseconds(150))
        #expect(source.requests.isEmpty)

        await control.resume()
        let summary = try await task.value
        #expect(summary.postsCompleted == 2)
    }

    @Test func 취소하면_바로_멈추고_다음_실행에서_이어간다() async throws {
        let root = try temporaryDirectory()
        StubProtocol.install(contentType)
        let source = FakePageSource(try Self.site())
        let task = Task {
            try await engine(source, sleep: { _ in throw CancellationError() }).run(options: options(root))
        }
        await #expect(throws: CancellationError.self) { try await task.value }
        let summary = try await engine(FakePageSource(try Self.site())).run(options: options(root))
        #expect(summary.postsCompleted + summary.postsSkipped == 2)
    }
}
}
