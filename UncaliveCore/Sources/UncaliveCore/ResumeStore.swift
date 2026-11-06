import Foundation

/// 어떤 게시글을 어디까지 받았는지 저장 폴더 안에 기록합니다.
public actor ResumeStore {
    public struct PostRecord: Codable, Sendable, Equatable {
        public var id: String
        /// 저장 폴더 기준 상대 경로입니다.
        public var folder: String
        public var title: String
        public var completed: Bool
        /// 미디어 키 → 게시글 폴더 기준 상대 경로
        public var files: [String: String]
        public var updatedAt: Date
        // 보관함 표시용 정보입니다. 이전 버전의 기록에는 없을 수 있습니다.
        public var channel: String?
        public var channelName: String?
        public var category: String?
        public var author: String?
        public var createdAt: String?
        public var url: URL?
    }

    private struct State: Codable {
        var version = 1
        var posts: [String: PostRecord] = [:]
    }

    private let root: URL
    private let fileURL: URL
    private var state: State

    public init(root: URL) throws {
        self.root = root
        fileURL = root.appending(path: ".uncalive/state.json")
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        if let data = try? Data(contentsOf: fileURL) {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            state = try decoder.decode(State.self, from: data)
        } else {
            state = State()
        }
    }

    public func record(for id: String) -> PostRecord? {
        state.posts[id]
    }

    public func allRecords() -> [PostRecord] {
        Array(state.posts.values)
    }

    /// 디스크에 실제로 남은 것만 돌려줍니다. Finder에서 지운 글은 빠지고, 파일이 일부 지워진 글은 미완료가 됩니다.
    public func liveRecords() -> [PostRecord] {
        let fm = FileManager.default
        return state.posts.values.compactMap { record in
            let folder = root.appending(path: record.folder)
            guard fm.fileExists(atPath: folder.path(percentEncoded: false)) else { return nil }
            var live = record
            live.files = record.files.filter { fm.fileExists(atPath: folder.appending(path: $0.value).path(percentEncoded: false)) }
            if live.files.count != record.files.count { live.completed = false }
            return live
        }
    }

    /// 이 게시글의 폴더를 정합니다. 다시 받을 때는 기존 폴더를 그대로 씁니다.
    public func reserveFolder(for post: ParsedPost, preferred: String, channelName: String? = nil) -> String {
        defer {
            if var record = state.posts[post.id] {
                record.title = post.title
                record.channel = post.channel
                record.channelName = channelName ?? record.channelName
                record.category = post.category
                record.author = post.author
                record.createdAt = post.createdAt
                record.url = post.url
                state.posts[post.id] = record
            }
        }
        if let existing = state.posts[post.id]?.folder { return existing }
        let taken = Set(state.posts.values.map(\.folder))
        var candidate = preferred
        var counter = 1
        while taken.contains(candidate) || FileManager.default.fileExists(atPath: root.appending(path: candidate).path(percentEncoded: false)) {
            candidate = "\(preferred)_\(counter)"
            counter += 1
        }
        state.posts[post.id] = PostRecord(id: post.id, folder: candidate, title: post.title, completed: false, files: [:], updatedAt: Date())
        return candidate
    }

    public func setFile(_ path: String, forKey key: String, postID: String) {
        state.posts[postID]?.files[key] = path
    }

    public func finish(postID: String, completed: Bool) throws {
        state.posts[postID]?.completed = completed
        state.posts[postID]?.updatedAt = Date()
        try save()
    }

    public func save() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(state).write(to: fileURL, options: .atomic)
    }
}
