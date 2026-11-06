import Foundation

/// 글을 어느 목록에서 받았는지 나타냅니다. 보관함 안의 폴더 이름이기도 합니다.
public enum ArchiveSource: String, Codable, Sendable, CaseIterable {
    case scrap = "스크랩"
    case collection = "주소 수집"

    /// 저장된 폴더 경로로 출처를 판단합니다. 구분이 없던 시절의 글은 `nil`입니다.
    public init?(folder: String) {
        guard let match = Self.allCases.first(where: { folder.hasPrefix($0.rawValue + "/") }) else { return nil }
        self = match
    }
}

/// 채널이나 검색 결과 같은 목록을 어디까지 읽을지 정합니다.
public struct ListScope: Codable, Sendable, Equatable {
    public var firstPage: Int
    /// `nil`이면 마지막 페이지까지 읽습니다.
    public var lastPage: Int?
    /// 지정하면 이보다 오래된 글만 남은 페이지에서 멈춥니다.
    public var since: Date?

    public init(firstPage: Int = 1, lastPage: Int? = 1, since: Date? = nil) {
        self.firstPage = firstPage
        self.lastPage = lastPage
        self.since = since
    }
}

/// GUI의 설정 화면과 1:1로 대응하는 다운로드 옵션입니다.
public struct DownloadOptions: Codable, Sendable, Equatable {
    public enum Quality: String, Codable, Sendable, CaseIterable {
        /// 원본 파일을 받습니다. CDN에 같은 파일이 있으면 그쪽에서 받습니다.
        case original
        /// 표시용으로 줄어드는 큰 이미지만 원본으로 받고, 나머지는 빠른 CDN의 재압축본을 받습니다.
        case balanced
        /// 웹페이지에 표시되는 압축본을 받습니다.
        case display
    }

    public enum FolderNaming: String, Codable, Sendable, CaseIterable {
        case title
        case idAndTitle
    }

    public enum FileNaming: String, Codable, Sendable, CaseIterable {
        /// `01.jpg`
        case sequence
        /// `01_원본이름.jpg`
        case sequenceAndOriginalName
    }

    public struct PageRange: Codable, Sendable, Equatable {
        public var first: Int
        /// `nil`이면 마지막 페이지까지 진행합니다.
        public var last: Int?

        public init(first: Int = 1, last: Int? = nil) {
            self.first = first
            self.last = last
        }
    }

    public struct Archive: Codable, Sendable, Equatable {
        /// 받은 파일을 연결한 `index.html`을 만듭니다.
        public var offlineHTML = true
        public var includeComments = true
        /// 제목, 작성자, 파일 목록을 담은 `post.json`을 만듭니다.
        public var metadataJSON = true
        /// Safari에서 열 수 있는 `page.webarchive`를 만듭니다.
        public var webArchive = false
        /// 페이지 원문을 `page.html`로 저장합니다. 계정 닉네임이 포함될 수 있습니다.
        public var rawHTML = false

        public init() {}
    }

    public var destination: URL
    /// 지정하면 저장 위치 아래 이 출처의 폴더에 글을 저장합니다.
    public var source: ArchiveSource?
    public var pages = PageRange()
    public var quality = Quality.original

    public var includeImages = true
    public var includeVideos = true
    public var includeAudio = true
    public var includeEmoticons = false
    public var includeVideoPosters = false

    public var folderNaming = FolderNaming.title
    public var fileNaming = FileNaming.sequence
    public var groupByChannel = false
    public var folderNameMaxLength = 80

    public var archive = Archive()

    /// 완료로 기록된 게시글은 다시 방문하지 않습니다.
    public var skipCompleted = true

    public var pageDelay: TimeInterval = 2
    public var mediaDelay: TimeInterval = 0.2
    /// CDN 파일의 동시 다운로드 수입니다. 원본 서버는 `MediaDownloader.originConnectionLimit`을 따릅니다.
    public var maxConcurrentDownloads = 4
    public var retryCount = 3

    public init(destination: URL) {
        self.destination = destination
    }
}
