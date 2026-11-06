import Foundation
import SwiftSoup

/// 아카라이브 HTML 구조를 아는 유일한 타입입니다. 사이트가 바뀌면 이 파일만 고칩니다.
public enum ArcaParser {
    public static let baseURL = URL(string: "https://arca.live")!

    public static func scrapListURL(page: Int) -> URL {
        URL(string: "https://arca.live/u/scrap_list?p=\(page)")!
    }

    /// 사용자가 붙여 넣은 주소의 종류입니다.
    public enum Target: Sendable, Equatable {
        case post(ScrapEntry)
        case list(URL)
    }

    /// 붙여 넣은 글에서 아카라이브 주소만 골라냅니다. 다른 사이트 주소는 무시합니다.
    public static func parseTargets(_ text: String) -> [Target] {
        var seen = Set<String>()
        return text.split(whereSeparator: \.isWhitespace).compactMap { token in
            let raw = token.hasPrefix("arca.live") ? "https://\(token)" : String(token)
            guard var parts = URLComponents(string: raw), parts.scheme == "https",
                  parts.host == "arca.live" || parts.host == "www.arca.live" else { return nil }
            parts.host = "arca.live"
            parts.fragment = nil
            if let (channel, id) = postPath(parts.path) {
                guard seen.insert(id).inserted, let url = URL(string: "https://arca.live/b/\(channel)/\(id)") else { return nil }
                return .post(ScrapEntry(id: id, channel: channel, channelName: nil, url: url, title: "글 \(id)", author: nil, createdAt: nil))
            }
            guard parts.path.hasPrefix("/b/") || parts.path.hasPrefix("/u/"), let url = parts.url,
                  seen.insert(url.absoluteString).inserted else { return nil }
            return .list(url)
        }
    }

    /// 목록 주소의 페이지 번호만 바꿉니다. 검색 조건 같은 다른 값은 유지합니다.
    public static func listURL(_ base: URL, page: Int) -> URL {
        guard var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return base }
        var items = (parts.queryItems ?? []).filter { $0.name != "p" }
        items.append(URLQueryItem(name: "p", value: String(page)))
        parts.queryItems = items
        return parts.url ?? base
    }

    public static func commentPageURL(_ post: URL, page: Int) -> URL {
        URL(string: post.absoluteString + "?cp=\(page)") ?? post
    }

    public static func parseCommentPage(html: String) throws -> [ParsedComment] {
        try comments(in: SwiftSoup.parse(html, baseURL.absoluteString))
    }

    public static func parseScrapList(html: String) throws -> ScrapPage {
        let doc = try SwiftSoup.parse(html, baseURL.absoluteString)
        var seen = Set<String>()
        var entries: [ScrapEntry] = []

        for row in try doc.select("a.vrow") where !row.hasClass("notice") {
            let href = try row.attr("href")
            guard let (channel, id) = postPath(href), seen.insert(id).inserted,
                  let url = URL(string: "/b/\(channel)/\(id)", relativeTo: baseURL)?.absoluteURL else { continue }
            let title = try row.select(".col-title .title").first()?.text() ?? ""
            let author = try row.select(".col-author [data-filter]").first()?.attr("data-filter")
            // 여러 채널이 섞인 목록의 뱃지는 [채널, 카테고리] 순서입니다.
            let badges = try row.select(".col-title .badges .badge").map { try $0.text() }
            let createdAt = try row.select(".col-time time[datetime]").first()?.attr("datetime")
            entries.append(ScrapEntry(id: id, channel: channel, channelName: badges.first, url: url, title: title, author: author, createdAt: createdAt, category: badges.dropFirst().first))
        }

        var highest = 1
        for link in try doc.select(".pagination a[href]") {
            let href = try link.attr("href")
            if let items = URLComponents(string: href)?.queryItems,
               let value = items.first(where: { $0.name == "p" })?.value,
               let page = Int(value) {
                highest = max(highest, page)
            }
        }
        let username = try doc.select(".user-menu-link .username").first()?.text()
        return ScrapPage(
            entries: entries,
            highestVisiblePage: highest,
            isLoggedIn: try isLoggedIn(doc),
            username: username?.isEmpty == false ? username : nil
        )
    }

    public static func parsePost(html: String, url: URL) throws -> ParsedPost {
        let doc = try SwiftSoup.parse(html, baseURL.absoluteString)
        guard let content = try doc.select(".article-content").first() ?? doc.select(".fr-view").first() else {
            throw UncaliveError.contentNotFound
        }
        let (channel, id) = postPath(url.path()) ?? ("", "")
        let head = try doc.select(".article-head").first()
        let titleNode = try head?.select(".title").first()
        let category = try titleNode?.select(".category-badge").first()?.text()
        let author = try head?.select(".member-info .user-info [data-filter]").first()?.attr("data-filter")
        let createdAt = try head?.select(".article-info time[datetime]").first()?.attr("datetime")

        return ParsedPost(
            id: id,
            channel: channel,
            url: url,
            title: titleNode?.ownText().trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            category: category?.isEmpty == false ? category : nil,
            author: author,
            createdAt: createdAt,
            contentHTML: try content.html(),
            media: try media(in: content),
            comments: try comments(in: doc),
            embeds: try content.select("iframe[src], embed[src]").compactMap { absoluteURL(try $0.attr("src")) },
            commentPages: try commentPages(in: doc)
        )
    }

    public static func absoluteURL(_ raw: String) -> URL? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.hasPrefix("data:"), !text.hasPrefix("blob:") else { return nil }
        if text.hasPrefix("//") { return URL(string: "https:" + text) }
        return URL(string: text, relativeTo: baseURL)?.absoluteURL
    }

    /// 본문 미디어 주소로 쓸 수 있는 값을 절대 주소로 바꿉니다. 내장된 `data:` 미디어도 허용합니다.
    public static func mediaURL(_ raw: String) -> URL? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("data:image/") || text.hasPrefix("data:video/") || text.hasPrefix("data:audio/") {
            return URL(string: text)
        }
        return absoluteURL(text)
    }

    // MARK: - 세부 분석

    private static func isLoggedIn(_ doc: Document) throws -> Bool {
        try !doc.select("a[href^='/u/logout']").isEmpty()
    }

    /// `/b/<채널>/<번호>` 경로에서 채널과 번호를 꺼냅니다.
    private static func postPath(_ path: String) -> (channel: String, id: String)? {
        let bare = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        let parts = bare.split(separator: "/").map(String.init)
        guard parts.count >= 3, parts[0] == "b", parts[2].allSatisfy(\.isNumber) else { return nil }
        return (parts[1], parts[2])
    }

    private static func media(in root: Element) throws -> [MediaRef] {
        var seen = Set<String>()
        var result: [MediaRef] = []
        func add(_ ref: MediaRef?) {
            if let ref, seen.insert(ref.key).inserted { result.append(ref) }
        }

        for element in try root.select("img, video, audio") {
            let original = absoluteURL(try element.attr("data-originalurl"))
            let isEmoticon = element.hasClass("arca-emoticon") || element.hasClass("emoticon")
            // 지연 로딩이면 src는 자리표시자이고 data-src가 진짜 주소입니다.
            var sources = [try element.attr("data-src"), try element.attr("src")]
            sources += try element.select("source").flatMap { [try $0.attr("data-src"), try $0.attr("src")] }
            let source = sources.lazy.compactMap(mediaURL).first

            switch element.tagName() {
            case "img":
                let width = Int(try element.attr("width"))
                let height = Int(try element.attr("height"))
                add(source.map { MediaRef(kind: isEmoticon ? .emoticon : .image, displayURL: $0, originalURL: original, width: width, height: height) })
            case "audio":
                add(source.map { MediaRef(kind: .audio, displayURL: $0, originalURL: original) })
            default:
                if let poster = absoluteURL(try element.attr("poster")) {
                    add(MediaRef(kind: .poster, displayURL: poster, originalURL: nil))
                }
                add(source.map { MediaRef(kind: isEmoticon ? .emoticon : .video, displayURL: $0, originalURL: original) })
            }
        }
        return result
    }

    private static func commentPages(in doc: Document) throws -> Int {
        var highest = 1
        for link in try doc.select("#comment .pagination a[href]") {
            let items = URLComponents(string: try link.attr("href"))?.queryItems
            if let value = items?.first(where: { $0.name == "cp" })?.value, let page = Int(value) {
                highest = max(highest, page)
            }
        }
        return highest
    }

    private static func comments(in doc: Document) throws -> [ParsedComment] {
        try doc.select("#comment .comment-item").compactMap { item in
            guard let message = try item.select(".message").first() else { return nil }
            try message.select(".btn-more").remove()
            var depth = -1
            for parent in item.parents() where parent.hasClass("comment-wrapper") { depth += 1 }
            return ParsedComment(
                id: item.id().replacingOccurrences(of: "c_", with: ""),
                author: try item.select(".user-info [data-filter]").first()?.attr("data-filter") ?? "",
                createdAt: try item.select("time[datetime]").first()?.attr("datetime"),
                depth: max(depth, 0),
                messageHTML: try message.html(),
                media: try media(in: message)
            )
        }
    }
}
