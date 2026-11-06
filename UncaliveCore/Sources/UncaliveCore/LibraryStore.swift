import Foundation
import SwiftSoup

/// 보관함 화면이 쓰는 글 한 개의 정보입니다.
public struct ArchivedPost: Sendable, Identifiable, Equatable {
    public var record: ResumeStore.PostRecord
    public var channel: String
    public var channelName: String
    public var category: String?
    public var author: String?
    public var createdAt: String?
    /// 검색용 소문자 글자입니다.
    public var searchText: String

    public var id: String { record.id }
    public var source: ArchiveSource? { ArchiveSource(folder: record.folder) }
    public var title: String { record.title }

    public func matches(_ query: String) -> Bool {
        searchText.contains(query.lowercased())
    }

    /// 검색어 주변의 글자를 돌려줍니다.
    public func snippet(for query: String, radius: Int = 40) -> String? {
        let needle = query.lowercased()
        guard !needle.isEmpty, let range = searchText.range(of: needle) else { return nil }
        let start = searchText.index(range.lowerBound, offsetBy: -radius, limitedBy: searchText.startIndex) ?? searchText.startIndex
        let end = searchText.index(range.upperBound, offsetBy: radius, limitedBy: searchText.endIndex) ?? searchText.endIndex
        return searchText[start..<end].replacingOccurrences(of: "\n", with: " ")
    }
}

/// 저장 폴더의 기록을 보관함 정보로 읽습니다. 이전 버전으로 받은 글도 저장된 파일에서 정보를 보완합니다.
public enum LibraryStore {
    private struct PostInfo: Decodable {
        let channel: String?
        let category: String?
        let author: String?
        let createdAt: String?
    }

    private static func textURL(postID: String, root: URL) -> URL {
        root.appending(path: ".uncalive/text/\(postID).txt")
    }

    static func writeText(_ text: String, postID: String, root: URL) throws {
        let url = textURL(postID: postID, root: root)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    public static func load(root: URL) async -> [ArchivedPost] {
        let state = root.appending(path: ".uncalive/state.json")
        guard FileManager.default.fileExists(atPath: state.path(percentEncoded: false)),
              let store = try? ResumeStore(root: root) else { return [] }
        let records = await store.liveRecords()
        let posts = await Task.detached(priority: .utility) {
            records.map { post(for: $0, root: root) }
        }.value

        // 이름이 없는 옛 기록도 같은 채널의 다른 글에서 이름을 찾아 한 채널로 묶습니다.
        var names: [String: String] = [:]
        for post in posts where post.channelName != post.channel { names[post.channel] = post.channelName }
        return posts.map { post in
            var named = post
            named.channelName = names[post.channel] ?? post.channelName
            return named
        }
    }

    private static func post(for record: ResumeStore.PostRecord, root: URL) -> ArchivedPost {
        let folder = root.appending(path: record.folder)
        var info: PostInfo?
        if record.channel == nil, let data = try? Data(contentsOf: folder.appending(path: "post.json")) {
            info = try? JSONDecoder().decode(PostInfo.self, from: data)
        }
        let channel = record.channel ?? info?.channel ?? ""
        return ArchivedPost(
            record: record,
            channel: channel,
            channelName: record.channelName ?? (channel.isEmpty ? "기타" : channel),
            category: record.category ?? info?.category,
            author: record.author ?? info?.author,
            createdAt: record.createdAt ?? info?.createdAt,
            searchText: text(for: record, folder: folder, root: root).lowercased()
        )
    }

    private static func text(for record: ResumeStore.PostRecord, folder: URL, root: URL) -> String {
        if let saved = try? String(contentsOf: textURL(postID: record.id, root: root), encoding: .utf8) {
            return saved
        }
        // 색인이 없던 시절에 받은 글은 오프라인 페이지에서 글자를 뽑아 저장해 둡니다.
        guard let html = try? String(contentsOf: folder.appending(path: "index.html"), encoding: .utf8),
              let body = try? SwiftSoup.parse(html).body()?.text() else { return record.title }
        try? writeText(body, postID: record.id, root: root)
        return body
    }
}

/// 엑셀에서 열 수 있는 CSV를 만듭니다.
public enum CSVWriter {
    public static func data(rows: [[String]]) -> Data {
        let text = rows.map { $0.map(escape).joined(separator: ",") }.joined(separator: "\r\n") + "\r\n"
        // BOM이 있어야 엑셀이 한글을 UTF-8로 읽습니다.
        return Data([0xEF, 0xBB, 0xBF]) + Data(text.utf8)
    }

    static func escape(_ field: String) -> String {
        var value = field
        // 남이 쓴 제목이 엑셀 수식으로 실행되지 않게 막습니다.
        if let first = value.first, "=+-@\t\r".contains(first) { value = "'" + value }
        guard value.contains(where: { ",\"\r\n".contains($0) }) else { return value }
        return "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
}
