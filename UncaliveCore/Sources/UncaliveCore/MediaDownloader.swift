import Foundation
import ImageIO

public struct DownloadedFile: Sendable, Equatable {
    public let fileName: String
    public let bytes: Int64
    public let usedOriginal: Bool
    /// 앞선 후보가 실패해 대체했을 때의 사유입니다.
    public var fallbackReason: String?
}

/// 파일 하나를 어디서 어떻게 받을지 정한 결과입니다.
public struct DownloadPlan: Sendable, Equatable {
    public var candidates: [URL]
    /// CDN 파일이 원본과 같은 파일인지 ETag로 확인했는지 나타냅니다.
    public var identicalToOriginal = false
    /// 원본 서버가 알려 준 파일 크기입니다. 큰 파일을 조각으로 받을 때 씁니다.
    public var originalBytes: Int64?
    /// 받은 이미지의 긴 변이 이보다 짧으면 서버가 축소한 것으로 봅니다.
    /// 본문의 크기 값은 가로세로가 뒤바뀌어 있을 수 있어 긴 변끼리 비교합니다.
    public var expectedLongSide: Int?

    public init(candidates: [URL]) {
        self.candidates = candidates
    }
}

/// 파일 하나를 안전하게 받습니다. 끝까지 받은 파일만 최종 이름을 얻습니다.
public struct MediaDownloader: Sendable {
    public typealias Progress = @Sendable (_ received: Int64, _ expected: Int64) -> Void

    /// 원본 서버는 IP당 동시 연결 2개를 넘으면 429로 거부합니다(연결당 약 100KB/s).
    /// 서버가 정한 한도이므로 설정으로 늘리지 않습니다.
    public static let originConnectionLimit = 2

    /// 이보다 큰 원본은 조각으로 받아, 다른 파일이 끝나 비는 연결을 바로 이어서 씁니다.
    static let chunkThreshold: Int64 = 2 * 1024 * 1024
    static let chunkSize: Int64 = 1024 * 1024

    private static let extensions: [String: String] = [
        "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
        "image/avif": "avif", "image/bmp": "bmp", "image/heic": "heic", "image/heif": "heif",
        "image/tiff": "tiff", "image/svg+xml": "svg", "image/x-icon": "ico", "image/jxl": "jxl",
        "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/mpeg": "mpeg",
        "video/ogg": "ogv", "video/x-matroska": "mkv", "video/x-msvideo": "avi",
        "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/ogg": "ogg",
        "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "weba", "audio/flac": "flac"
    ]

    let session: URLSession
    let retryCount: Int
    let userAgent: String?
    let retryDelay: @Sendable (Int) async throws -> Void
    let originLimiter: Limiter
    let cdnLimiter: Limiter

    public init(
        session: URLSession,
        retryCount: Int,
        userAgent: String? = nil,
        cdnConnections: Int = 4,
        retryDelay: @escaping @Sendable (Int) async throws -> Void = { attempt in
            try await Task.sleep(for: .seconds(pow(2, Double(attempt))))
        }
    ) {
        self.session = session
        self.retryCount = retryCount
        self.userAgent = userAgent
        self.retryDelay = retryDelay
        originLimiter = Limiter(limit: Self.originConnectionLimit)
        cdnLimiter = Limiter(limit: cdnConnections)
    }

    /// 받을 주소의 우선순위를 정합니다. CDN 파일의 ETag가 원본과 같으면 빠른 CDN을 먼저 씁니다.
    public func plan(_ media: MediaRef, quality: DownloadOptions.Quality) async -> DownloadPlan {
        var plan = DownloadPlan(candidates: media.candidates(for: quality))
        guard media.prefersOriginal(quality) else { return plan }
        if media.kind == .image {
            plan.expectedLongSide = [media.width, media.height].compactMap { $0 }.max()
        }

        guard let original = media.originalURL else { return plan }
        let cdn = await headers(of: media.displayURL)
        let origin = await headers(of: original)
        plan.originalBytes = origin?.length
        if let tag = origin?.tag, tag == cdn?.tag {
            plan.candidates = [media.displayURL, original]
            plan.identicalToOriginal = true
        }
        return plan
    }

    private struct RemoteHeaders: Sendable {
        let tag: String?
        let length: Int64?
    }

    private func headers(of url: URL) async -> RemoteHeaders? {
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        prepare(&request)
        return try? await limiter(for: url).withSlot(urgent: true) { [request] in
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return RemoteHeaders(
                tag: http.value(forHTTPHeaderField: "ETag")?.replacingOccurrences(of: "W/", with: ""),
                length: http.value(forHTTPHeaderField: "Content-Length").flatMap(Int64.init)
            )
        }
    }

    private func prepare(_ request: inout URLRequest) {
        request.httpShouldHandleCookies = false
        // 다른 사이트의 파일을 받을 때는 어디서 왔는지 알리지 않습니다.
        guard let host = request.url?.host(), host.hasSuffix("arca.live") || host.hasSuffix("namu.la") else { return }
        request.setValue("https://arca.live/", forHTTPHeaderField: "Referer")
        if let userAgent { request.setValue(userAgent, forHTTPHeaderField: "User-Agent") }
    }

    private func isOrigin(_ url: URL) -> Bool {
        url.host()?.hasPrefix("ac-o.") == true || url.query()?.contains("type=orig") == true
    }

    private func limiter(for url: URL) -> Limiter {
        isOrigin(url) ? originLimiter : cdnLimiter
    }

    public func download(candidates: [URL], directory: URL, baseName: String, progress: Progress? = nil) async throws -> DownloadedFile {
        try await download(DownloadPlan(candidates: candidates), directory: directory, baseName: baseName, progress: progress)
    }

    /// 후보 주소를 차례로 시도합니다. 마지막 후보가 아니면 받은 이미지의 크기도 확인합니다.
    public func download(_ plan: DownloadPlan, directory: URL, baseName: String, progress: Progress? = nil) async throws -> DownloadedFile {
        var lastError: Error?
        for (index, url) in plan.candidates.enumerated() {
            do {
                let file = try await fetchBest(url, plan: plan, directory: directory, baseName: baseName, progress: progress)
                let path = directory.appending(path: file.name)
                if index < plan.candidates.count - 1, let expected = plan.expectedLongSide,
                   let actual = Self.longSide(of: path), actual < expected {
                    try? FileManager.default.removeItem(at: path)
                    throw UncaliveError.serverResized(expected: expected, actual: actual)
                }
                return DownloadedFile(
                    fileName: file.name,
                    bytes: file.bytes,
                    usedOriginal: plan.identicalToOriginal || isOrigin(url),
                    fallbackReason: lastError?.localizedDescription
                )
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                lastError = error
            }
        }
        throw lastError ?? UncaliveError.httpStatus(0)
    }

    private func fetchBest(_ url: URL, plan: DownloadPlan, directory: URL, baseName: String, progress: Progress?) async throws -> StoredFile {
        if isOrigin(url), let length = plan.originalBytes, length >= Self.chunkThreshold {
            do {
                return try await fetchInChunks(url, length: length, directory: directory, baseName: baseName, progress: progress)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                // 나눠 받기에 실패하면 한 번에 받습니다.
            }
        }
        return try await fetch(url, directory: directory, baseName: baseName, progress: progress)
    }

    private func fetch(_ url: URL, directory: URL, baseName: String, progress: Progress?) async throws -> StoredFile {
        if url.scheme == "data" { return try storeInlineData(url, directory: directory, baseName: baseName) }

        var mutableRequest = URLRequest(url: url)
        prepare(&mutableRequest)
        let request = mutableRequest

        return try await withRetries {
            // 재시도 대기 중에는 슬롯을 비워 다른 파일이 쓰게 합니다.
            try await limiter(for: url).withSlot {
                let (temporary, response) = try await session.download(for: request, delegate: progress.map(ProgressRelay.init))
                defer { try? FileManager.default.removeItem(at: temporary) }
                guard let http = response as? HTTPURLResponse else { throw UncaliveError.httpStatus(0) }
                guard (200..<300).contains(http.statusCode) else { throw UncaliveError.httpStatus(http.statusCode) }
                try Self.verifyComplete(temporary, response: http)
                return try store(temporary, contentType: Self.contentType(of: http), url: url, directory: directory, baseName: baseName)
            }
        }
    }

    /// 본문에 내장된 `data:` 미디어를 파일로 풀어 저장합니다.
    private func storeInlineData(_ url: URL, directory: URL, baseName: String) throws -> StoredFile {
        let header = url.absoluteString.dropFirst("data:".count).prefix { $0 != "," }
        let contentType = header.split(separator: ";").first.map { $0.lowercased() } ?? ""
        let temporary = directory.appending(path: ".\(baseName).inline")
        try Data(contentsOf: url).write(to: temporary)
        return try store(temporary, contentType: contentType, url: url, directory: directory, baseName: baseName)
    }

    /// 빈 파일이나 도중에 끊긴 파일을 완성본으로 저장하지 않습니다.
    private static func verifyComplete(_ file: URL, response: HTTPURLResponse) throws {
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false))[.size] as? Int64) ?? 0
        let isEncoded = response.value(forHTTPHeaderField: "Content-Encoding") != nil
        let expected = response.expectedContentLength
        guard size > 0, isEncoded || expected <= 0 || size == expected else { throw UncaliveError.incompleteFile }
    }

    private func withRetries<T: Sendable>(_ body: @Sendable () async throws -> T) async throws -> T {
        var attempt = 0
        while true {
            try Task.checkCancellation()
            do {
                return try await body()
            } catch {
                guard attempt < retryCount, Self.isRetryable(error) else { throw error }
                attempt += 1
                try await retryDelay(attempt)
            }
        }
    }

    // MARK: - 조각 다운로드

    /// 큰 원본을 조각으로 받습니다. 조각마다 슬롯을 다시 빌리므로 다른 파일과 공평하게 나눠 쓰고,
    /// 슬롯이 비면 바로 채웁니다. 동시 연결 수는 원본 서버 제한을 그대로 따릅니다.
    private func fetchInChunks(_ url: URL, length: Int64, directory: URL, baseName: String, progress: Progress?) async throws -> StoredFile {
        let fm = FileManager.default
        let folder = directory.appending(path: ".\(baseName).chunks")
        try? fm.removeItem(at: folder)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: folder) }

        let ranges = stride(from: Int64(0), to: length, by: Int(Self.chunkSize)).map { start in
            start...min(start + Self.chunkSize - 1, length - 1)
        }
        let tracker = ChunkTracker(total: length, handler: progress)
        var contentType = ""
        var next = 0

        try await withThrowingTaskGroup(of: String.self) { group in
            func addNext() {
                guard next < ranges.count else { return }
                let index = next
                next += 1
                group.addTask {
                    try await fetchChunk(url, range: ranges[index], index: index, folder: folder, tracker: tracker)
                }
            }
            for _ in 0..<Self.originConnectionLimit { addNext() }
            while let type = try await group.next() {
                if contentType.isEmpty { contentType = type }
                addNext()
            }
        }

        let joined = folder.appending(path: "joined")
        fm.createFile(atPath: joined.path(percentEncoded: false), contents: nil)
        let output = try FileHandle(forWritingTo: joined)
        defer { try? output.close() }
        for index in ranges.indices {
            try output.write(contentsOf: Data(contentsOf: folder.appending(path: String(index))))
        }
        guard try output.offset() == UInt64(length) else { throw UncaliveError.rangeNotSupported }
        return try store(joined, contentType: contentType, url: url, directory: directory, baseName: baseName)
    }

    private func fetchChunk(_ url: URL, range: ClosedRange<Int64>, index: Int, folder: URL, tracker: ChunkTracker) async throws -> String {
        var mutableRequest = URLRequest(url: url)
        prepare(&mutableRequest)
        mutableRequest.setValue("bytes=\(range.lowerBound)-\(range.upperBound)", forHTTPHeaderField: "Range")
        let request = mutableRequest
        let target = folder.appending(path: String(index))

        return try await withRetries {
            try await limiter(for: url).withSlot {
                let relay = ProgressRelay { received, _ in tracker.update(index, received: received) }
                let (temporary, response) = try await session.download(for: request, delegate: relay)
                defer { try? FileManager.default.removeItem(at: temporary) }
                guard let http = response as? HTTPURLResponse else { throw UncaliveError.httpStatus(0) }
                guard http.statusCode != 200 else { throw UncaliveError.rangeNotSupported }
                guard http.statusCode == 206 else { throw UncaliveError.httpStatus(http.statusCode) }
                guard http.value(forHTTPHeaderField: "Content-Range")?.hasPrefix("bytes \(range.lowerBound)-\(range.upperBound)/") == true else {
                    throw UncaliveError.rangeNotSupported
                }
                try? FileManager.default.removeItem(at: target)
                try FileManager.default.moveItem(at: temporary, to: target)
                tracker.update(index, received: Int64(range.count))
                return Self.contentType(of: http)
            }
        }
    }

    private static func contentType(of response: HTTPURLResponse) -> String {
        (response.value(forHTTPHeaderField: "Content-Type") ?? "")
            .split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
    }

    static func longSide(of url: URL) -> Int? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else { return nil }
        return max(width, height)
    }

    private struct StoredFile: Sendable {
        let name: String
        let bytes: Int64
    }

    private func store(_ temporary: URL, contentType: String, url: URL, directory: URL, baseName: String) throws -> StoredFile {
        let fm = FileManager.default
        let fileExtension = try Self.fileExtension(contentType: contentType, url: url, file: temporary)
        let name = "\(baseName).\(fileExtension)"

        // 임시 폴더는 다른 볼륨일 수 있으므로 같은 폴더의 .part를 거쳐 원자적으로 옮깁니다.
        let part = directory.appending(path: name + ".part")
        let final = directory.appending(path: name)
        try? fm.removeItem(at: part)
        try fm.moveItem(at: temporary, to: part)
        try? fm.removeItem(at: final)
        try fm.moveItem(at: part, to: final)

        let bytes = (try? fm.attributesOfItem(atPath: final.path(percentEncoded: false))[.size] as? Int64) ?? 0
        return StoredFile(name: name, bytes: bytes)
    }

    /// 확장자를 정합니다. 오류 페이지만 거부하고, 낯선 형식도 버리지 않고 저장합니다.
    static func fileExtension(contentType: String, url: URL, file: URL? = nil) throws -> String {
        if contentType.hasPrefix("text/") || contentType.contains("json") {
            throw UncaliveError.unsupportedMedia(contentType)
        }
        if let known = extensions[contentType] { return known }
        if let file, let sniffed = sniffExtension(of: file) { return sniffed }
        let fromURL = url.scheme == "data" ? "" : url.pathExtension.lowercased()
        if (1...5).contains(fromURL.count), fromURL.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) {
            return fromURL == "jpeg" ? "jpg" : fromURL
        }
        return "bin"
    }

    /// 파일 앞부분의 서명으로 형식을 알아냅니다.
    static func sniffExtension(of file: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: 16), head.count >= 12 else { return nil }
        let bytes = [UInt8](head)
        func ascii(_ range: Range<Int>) -> String { String(decoding: bytes[range], as: UTF8.self) }

        if bytes.starts(with: [0xFF, 0xD8, 0xFF]) { return "jpg" }
        if bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "png" }
        if ascii(0..<4) == "GIF8" { return "gif" }
        if ascii(0..<4) == "RIFF", ascii(8..<12) == "WEBP" { return "webp" }
        if ascii(0..<2) == "BM" { return "bmp" }
        if bytes.starts(with: [0x1A, 0x45, 0xDF, 0xA3]) { return "webm" }
        if ascii(4..<8) == "ftyp" {
            let brand = ascii(8..<12)
            if brand.hasPrefix("avif") { return "avif" }
            if brand.hasPrefix("heic") { return "heic" }
            return brand.hasPrefix("qt") ? "mov" : "mp4"
        }
        return nil
    }

    static func isRetryable(_ error: Error) -> Bool {
        if case UncaliveError.incompleteFile = error { return true }
        if case UncaliveError.httpStatus(let status) = error {
            return status == 408 || status == 429 || (500..<600).contains(status)
        }
        guard let urlError = error as? URLError else { return false }
        return [.timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost].contains(urlError.code)
    }
}

/// 조각별로 받은 양을 합쳐 파일 전체의 진행률로 전달합니다.
private final class ChunkTracker: @unchecked Sendable {
    private let lock = NSLock()
    private let total: Int64
    private let handler: MediaDownloader.Progress?
    private var received: [Int: Int64] = [:]

    init(total: Int64, handler: MediaDownloader.Progress?) {
        self.total = total
        self.handler = handler
    }

    func update(_ index: Int, received bytes: Int64) {
        let sum = lock.withLock {
            received[index] = bytes
            return received.values.reduce(0, +)
        }
        handler?(sum, total)
    }
}

/// 내려받는 중인 바이트 수를 초당 몇 번만 전달합니다.
private final class ProgressRelay: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let handler: MediaDownloader.Progress
    private let lock = NSLock()
    private var lastReport = Date.distantPast

    init(_ handler: @escaping MediaDownloader.Progress) {
        self.handler = handler
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let shouldReport = lock.withLock {
            guard Date().timeIntervalSince(lastReport) >= 0.25 else { return false }
            lastReport = Date()
            return true
        }
        if shouldReport { handler(totalBytesWritten, totalBytesExpectedToWrite) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}
