import Foundation
import SwiftSoup

/// 받은 파일을 연결한 오프라인 페이지를 만듭니다. 인터넷 없이 어느 브라우저에서나 열립니다.
public enum PostArchiver {
    struct Metadata: Encodable {
        struct File: Encodable {
            let kind: MediaKind
            let path: String
        }
        let id: String
        let channel: String
        let url: URL
        let title: String
        let category: String?
        let author: String?
        let createdAt: String?
        let savedAt: Date
        let commentCount: Int
        let embeds: [URL]
        let files: [File]
    }

    /// - Parameter paths: 미디어 키 → 게시글 폴더 기준 상대 경로
    public static func write(post: ParsedPost, paths: [String: String], options: DownloadOptions.Archive, to folder: URL) throws {
        if options.offlineHTML {
            let html = try render(post: post, paths: paths, includeComments: options.includeComments)
            try html.write(to: folder.appending(path: "index.html"), atomically: true, encoding: .utf8)
        }
        if options.metadataJSON {
            let allMedia = post.media + post.comments.flatMap(\.media)
            let files = allMedia.compactMap { media in
                paths[media.key].map { Metadata.File(kind: media.kind, path: $0) }
            }
            let metadata = Metadata(
                id: post.id, channel: post.channel, url: post.url, title: post.title,
                category: post.category, author: post.author, createdAt: post.createdAt,
                savedAt: Date(), commentCount: post.comments.count, embeds: post.embeds, files: files
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            encoder.dateEncodingStrategy = .iso8601
            try encoder.encode(metadata).write(to: folder.appending(path: "post.json"), options: .atomic)
        }
    }

    /// 본문 검색에 쓸 글자를 뽑습니다. 제목, 본문, 댓글이 들어갑니다.
    public static func searchableText(of post: ParsedPost) throws -> String {
        var parts = [post.title, try SwiftSoup.parseBodyFragment(post.contentHTML).text()]
        for comment in post.comments {
            parts.append(comment.author)
            parts.append(try SwiftSoup.parseBodyFragment(comment.messageHTML).text())
        }
        return parts.joined(separator: "\n")
    }

    public static func render(post: ParsedPost, paths: [String: String], includeComments: Bool) throws -> String {
        let content = try rewrite(post.contentHTML, paths: paths)
        var details = [post.channel, post.category, post.author, post.createdAt].compactMap { $0 }.map(escape)
        details.append("<a href=\"\(escape(post.url.absoluteString))\">원문 보기</a>")

        var commentsHTML = ""
        if includeComments, !post.comments.isEmpty {
            let items = try post.comments.map { comment in
                """
                <li style="margin-left:\(min(comment.depth, 4) * 20)px">
                  <div class="meta"><strong>\(escape(comment.author))</strong> \(escape(comment.createdAt ?? ""))</div>
                  <div>\(try rewrite(comment.messageHTML, paths: paths))</div>
                </li>
                """
            }.joined(separator: "\n")
            commentsHTML = "<section><h2>댓글 \(post.comments.count)개</h2><ol class=\"comments\">\n\(items)\n</ol></section>"
        }

        return """
        <!doctype html>
        <html lang="ko">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="script-src 'none'">
        <title>\(escape(post.title))</title>
        <style>
        :root { color-scheme: light dark; --line: #d8d8dc; --muted: #6e6e73; }
        @media (prefers-color-scheme: dark) { :root { --line: #3a3a3c; --muted: #a1a1a6; } }
        body { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; font: 16px/1.7 -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; overflow-wrap: anywhere; }
        h1 { font-size: 1.5rem; line-height: 1.35; margin: 0 0 8px; }
        h2 { font-size: 1.1rem; margin-top: 40px; }
        .meta { color: var(--muted); font-size: .875rem; }
        header { border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 24px; }
        img, video { max-width: 100%; height: auto; }
        .comments { list-style: none; padding: 0; }
        .comments li { border-top: 1px solid var(--line); padding: 10px 0; }
        .comments pre { white-space: pre-wrap; font: inherit; margin: 0; }
        .missing { color: var(--muted); font-size: .875rem; }
        </style>
        </head>
        <body>
        <header>
        <h1>\(escape(post.title))</h1>
        <div class="meta">\(details.joined(separator: " · "))</div>
        </header>
        <main>
        \(content)
        </main>
        \(commentsHTML)
        </body>
        </html>
        """
    }

    /// 원격 주소를 로컬 경로로 바꾸고, 스크립트처럼 저장본에 필요 없는 요소를 지웁니다.
    static func rewrite(_ html: String, paths: [String: String]) throws -> String {
        let doc = try SwiftSoup.parseBodyFragment(html)
        guard let body = doc.body() else { return "" }
        try body.select("script, style, link, meta, object, embed, form").remove()

        for frame in try body.select("iframe") {
            let link = try frame.attr("src")
            if let url = ArcaParser.absoluteURL(link) {
                try frame.after("<p><a href=\"\(escape(url.absoluteString))\">외부 콘텐츠 열기</a></p>")
            }
            try frame.remove()
        }

        // data-src를 지우기 전에 지연 로딩 이미지의 진짜 주소를 기억해 둡니다.
        var rawDataSource: [Element: String] = [:]
        for image in try body.select("img[data-src]") { rawDataSource[image] = try image.attr("data-src") }

        for element in try body.select("*") {
            for attribute in element.getAttributes()?.asList() ?? [] {
                let key = attribute.getKey().lowercased()
                let reachesNetwork = key == "style" && attribute.getValue().lowercased().contains("url(")
                if key.hasPrefix("on") || reachesNetwork || ["data-originalurl", "data-src", "srcset", "loading"].contains(key) {
                    try element.removeAttr(attribute.getKey())
                }
            }
        }

        for link in try body.select("a[href]") {
            let href = try link.attr("href")
            if href.lowercased().hasPrefix("javascript:") {
                try link.removeAttr("href")
            } else if let url = ArcaParser.absoluteURL(href) {
                try link.attr("href", url.absoluteString)
            }
        }

        func local(_ raw: String) -> String? {
            guard let url = ArcaParser.mediaURL(raw), let path = paths[MediaRef.key(for: url)] else { return nil }
            return path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path
        }

        for image in try body.select("img") {
            if let path = try local(image.attr("src")) ?? local(rawDataSource[image] ?? "") {
                try image.attr("src", path)
            } else if try image.attr("src").hasPrefix("data:image/") {
                continue // 본문에 내장된 이미지는 그 자체로 오프라인에서 보입니다.
            } else {
                try image.after("<span class=\"missing\">[저장되지 않은 이미지]</span>")
                try image.remove()
            }
        }

        for video in try body.select("video, audio") {
            let sources = try video.select("source")
            var path = local(try video.attr("src"))
            for source in sources where path == nil { path = local(try source.attr("src")) }
            guard let path else {
                try video.after("<span class=\"missing\">[저장되지 않은 \(video.tagName() == "audio" ? "오디오" : "동영상")]</span>")
                try video.remove()
                continue
            }
            try sources.remove()
            try video.attr("src", path)
            try video.attr("controls", "controls")
            let poster = try video.attr("poster")
            if let posterPath = local(poster) {
                try video.attr("poster", posterPath)
            } else if !poster.isEmpty {
                try video.removeAttr("poster")
            }
        }
        return try body.html()
    }

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
