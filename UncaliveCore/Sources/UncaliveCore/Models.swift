import CryptoKit
import Foundation

public struct ScrapEntry: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let channel: String
    /// 화면에 표시되는 채널 이름입니다.
    public let channelName: String?
    public let url: URL
    public let title: String
    public let author: String?
    public let createdAt: String?
    /// 게시판의 카테고리입니다. 목록에 표시되지 않으면 비어 있습니다.
    public var category: String? = nil

    /// 목록에 적힌 작성일입니다.
    public var date: Date? {
        createdAt.flatMap { try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse($0) }
    }

    /// 한 채널의 목록에서는 뱃지가 채널 이름이 아니라 카테고리입니다.
    var inSingleChannelList: ScrapEntry {
        ScrapEntry(id: id, channel: channel, channelName: nil, url: url, title: title, author: author, createdAt: createdAt, category: channelName)
    }
}

public struct ScrapPage: Sendable, Equatable {
    public let entries: [ScrapEntry]
    /// 페이지 이동 영역에 보이는 가장 큰 번호입니다. 실제 마지막 페이지가 아닐 수 있습니다.
    public let highestVisiblePage: Int
    public let isLoggedIn: Bool
    public let username: String?
}

public enum MediaKind: String, Codable, Sendable {
    case image, video, audio, emoticon, poster
}

public struct MediaRef: Codable, Sendable, Equatable {
    /// 서명이 바뀌어도 변하지 않는 식별자입니다.
    public let key: String
    public let kind: MediaKind
    public let displayURL: URL
    public let originalURL: URL?
    /// 본문 HTML에 적힌 원본의 크기입니다. 회전된 사진은 실제 파일과 가로세로가 뒤바뀌어 있을 수 있습니다.
    public let width: Int?
    public let height: Int?

    /// CDN 표시용 이미지의 최대 가로 크기입니다. 이보다 큰 이미지는 표시용에서 축소됩니다.
    public static let displayMaxWidth = 1280

    private static let recompressedExtensions: Set<String> = ["jpg", "jpeg", "png", "webp"]

    public init(kind: MediaKind, displayURL: URL, originalURL: URL?, width: Int? = nil, height: Int? = nil) {
        self.key = MediaRef.key(for: displayURL)
        self.kind = kind
        self.displayURL = displayURL
        self.originalURL = originalURL
        self.width = width
        self.height = height
    }

    public static func key(for url: URL) -> String {
        // 본문에 직접 들어 있는 이미지는 내용이 곧 주소이므로 해시로 줄입니다.
        if url.scheme == "data" {
            return "data:" + SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        }
        return (url.host() ?? "") + url.path()
    }

    /// 시도할 주소를 우선순위대로 돌려줍니다.
    public func candidates(for quality: DownloadOptions.Quality) -> [URL] {
        guard prefersOriginal(quality) else {
            // 균형 화질은 CDN을 쓰되, CDN이 실패하면 원본으로 받습니다.
            if quality == .balanced, let originalURL { return [displayURL, originalURL] }
            return [displayURL]
        }
        var result: [URL] = []
        if let originalURL {
            result.append(originalURL)
        } else if let inferred = inferredOriginalURL {
            result.append(inferred)
        }
        result.append(displayURL)
        return result
    }

    /// 이 화질에서 원본 파일을 받아야 하는지 알려 줍니다.
    public func prefersOriginal(_ quality: DownloadOptions.Quality) -> Bool {
        switch quality {
        case .original: true
        case .display: false
        case .balanced: !keepsResolutionOnCDN
        }
    }

    /// 크기를 확인할 수 있고 표시용에서도 해상도가 유지되는 정지 이미지인지 봅니다.
    private var keepsResolutionOnCDN: Bool {
        guard kind == .image, let width, width <= Self.displayMaxWidth else { return false }
        return Self.recompressedExtensions.contains(displayURL.pathExtension.lowercased())
    }

    /// `data-originalurl`이 없는 아카라이브 이미지에만 쓰는 대체 경로입니다.
    private var inferredOriginalURL: URL? {
        guard kind == .image, let host = displayURL.host(),
              host.hasSuffix("arca.live") || host.hasSuffix("namu.la"),
              var parts = URLComponents(url: displayURL, resolvingAgainstBaseURL: false) else { return nil }
        var items = parts.queryItems ?? []
        guard !items.contains(where: { $0.name == "type" }) else { return nil }
        items.append(URLQueryItem(name: "type", value: "orig"))
        parts.queryItems = items
        return parts.url
    }
}

public struct ParsedComment: Codable, Sendable, Equatable {
    public let id: String
    public let author: String
    public let createdAt: String?
    public let depth: Int
    public let messageHTML: String
    public let media: [MediaRef]
}

public struct ParsedPost: Codable, Sendable, Equatable {
    public let id: String
    public let channel: String
    public let url: URL
    public let title: String
    public let category: String?
    public let author: String?
    public let createdAt: String?
    public let contentHTML: String
    public let media: [MediaRef]
    public var comments: [ParsedComment]
    /// YouTube처럼 파일로 받을 수 없는 외부 임베드 주소입니다.
    public let embeds: [URL]
    /// 댓글이 여러 페이지일 때의 마지막 페이지 번호입니다. 글을 열면 이 페이지가 먼저 보입니다.
    public let commentPages: Int

    public init(
        id: String, channel: String, url: URL, title: String, category: String?, author: String?,
        createdAt: String?, contentHTML: String, media: [MediaRef], comments: [ParsedComment],
        embeds: [URL] = [], commentPages: Int = 1
    ) {
        self.id = id
        self.channel = channel
        self.url = url
        self.title = title
        self.category = category
        self.author = author
        self.createdAt = createdAt
        self.contentHTML = contentHTML
        self.media = media
        self.comments = comments
        self.embeds = embeds
        self.commentPages = commentPages
    }
}

public enum UncaliveError: Error, Equatable, Sendable {
    case loginRequired
    case challengeTimedOut
    case pageTimedOut(URL)
    case postUnavailable(status: Int)
    case contentNotFound
    case httpStatus(Int)
    case unsupportedMedia(String)
    case destinationUnavailable(String)
    case serverResized(expected: Int, actual: Int)
    case rangeNotSupported
    case incompleteFile
}

extension UncaliveError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .loginRequired: "로그인이 필요합니다."
        case .challengeTimedOut: "제한 시간 안에 Cloudflare 보안 확인을 완료하지 못했습니다."
        case .pageTimedOut(let url): "페이지를 불러오지 못했습니다: \(url.path())"
        case .postUnavailable(let status): "게시글을 열 수 없습니다. (HTTP \(status))"
        case .contentNotFound: "게시글 본문을 찾지 못했습니다."
        case .httpStatus(let status): "서버 응답 오류입니다. (HTTP \(status))"
        case .unsupportedMedia(let type): "지원하지 않는 파일 형식입니다: \(type)"
        case .destinationUnavailable(let reason): "저장 위치를 사용할 수 없습니다: \(reason)"
        case .serverResized(let expected, let actual): "서버에서 축소된 이미지 응답: 긴 변 \(expected)px → \(actual)px"
        case .rangeNotSupported: "서버가 나눠 받기를 지원하지 않습니다."
        case .incompleteFile: "파일을 끝까지 받지 못했습니다."
        }
    }
}
