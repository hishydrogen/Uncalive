import Foundation
@testable import UncaliveCore

enum Fixture {
    static func html(_ name: String) throws -> String {
        let url = Bundle.module.url(forResource: name, withExtension: "html", subdirectory: "Fixtures")!
        return try String(contentsOf: url, encoding: .utf8)
    }
}

func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "uncalive-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

func options(_ destination: URL) -> DownloadOptions {
    var result = DownloadOptions(destination: destination)
    result.pageDelay = 0
    result.mediaDelay = 0
    return result
}

/// 게시글 페이지를 메모리에서 돌려주는 가짜 브라우저입니다.
final class FakePageSource: PageSource, @unchecked Sendable {
    private let lock = NSLock()
    private let pages: [String: LoadedPage]
    private var requested: [String] = []

    init(_ pages: [String: LoadedPage]) { self.pages = pages }

    var requests: [String] {
        lock.withLock { requested }
    }

    func load(_ url: URL, kind: PageKind) async throws -> LoadedPage {
        let key = url.path() + (url.query().map { "?\($0)" } ?? "")
        lock.withLock { requested.append(key) }
        return pages[key] ?? LoadedPage(html: "", status: 404)
    }

    func userAgent() async -> String? { "TestAgent" }
    func webArchiveData() async throws -> Data { Data("archive".utf8) }
}

/// 네트워크 대신 응답을 돌려주는 URLProtocol입니다.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    struct Response {
        var status = 200
        var type = "image/jpeg"
        var body = Data("media".utf8)
        var etag: String?
        var supportsRanges = false
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (URL) -> Response = { _ in Response() }
    nonisolated(unsafe) private static var seen: [URL] = []
    nonisolated(unsafe) private static var heads: [URL] = []

    static func install(_ newHandler: @escaping (URL) -> Response) {
        lock.withLock {
            handler = newHandler
            seen = []
            heads = []
        }
    }

    /// HEAD를 뺀 실제 다운로드 요청입니다.
    static var requests: [URL] {
        lock.withLock { seen }
    }

    static var headRequests: [URL] {
        lock.withLock { heads }
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let url = request.url!
        let isHead = request.httpMethod == "HEAD"
        let response: Response = Self.lock.withLock {
            if isHead { Self.heads.append(url) } else { Self.seen.append(url) }
            return Self.handler(url)
        }
        var headers = ["Content-Type": response.type, "Content-Length": String(response.body.count)]
        if let etag = response.etag { headers["ETag"] = etag }

        var status = response.status
        var body = isHead ? Data() : response.body
        if !isHead, response.supportsRanges, let range = request.value(forHTTPHeaderField: "Range") {
            let bounds = range.replacingOccurrences(of: "bytes=", with: "").split(separator: "-").compactMap { Int($0) }
            body = response.body.subdata(in: bounds[0]..<(bounds[1] + 1))
            status = 206
            headers["Content-Range"] = "bytes \(bounds[0])-\(bounds[1])/\(response.body.count)"
            headers["Content-Length"] = String(body.count)
        }

        let http = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
