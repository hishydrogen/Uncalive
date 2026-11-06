import Foundation

public enum FileNaming {
    /// APFS의 이름 제한(255바이트)보다 여유 있게 둡니다.
    static let maxBytes = 200

    /// macOS, Windows, Linux에서 모두 안전한 이름으로 바꿉니다.
    public static func sanitize(_ raw: String, maxCharacters: Int) -> String {
        var name = raw.precomposedStringWithCanonicalMapping
        name = String(name.map { character in
            let illegal = "\\/:*?\"<>|".contains(character)
            let control = character.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
            return illegal || control ? "_" : character
        })
        name = name.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        name = trim(name)
        if name.count > maxCharacters { name = String(name.prefix(maxCharacters)) }
        while name.utf8.count > maxBytes { name.removeLast() }
        return trim(name)
    }

    public static func folderName(for post: ParsedPost, options: DownloadOptions) -> String {
        let title = sanitize(post.title, maxCharacters: options.folderNameMaxLength)
        switch options.folderNaming {
        case .title:
            return title.isEmpty ? "post_\(post.id)" : title
        case .idAndTitle:
            return title.isEmpty ? post.id : "\(post.id)_\(title)"
        }
    }

    /// 확장자를 뺀 파일 이름입니다.
    public static func baseName(sequence: Int, total: Int, media: MediaRef, naming: DownloadOptions.FileNaming) -> String {
        let number = String(sequence).leftPadded(to: max(2, String(total).count))
        guard naming == .sequenceAndOriginalName, media.displayURL.scheme != "data" else { return number }
        let stem = media.displayURL.deletingPathExtension().lastPathComponent
        let original = sanitize(stem.removingPercentEncoding ?? stem, maxCharacters: 100)
        return original.isEmpty ? number : "\(number)_\(original)"
    }

    private static func trim(_ text: String) -> String {
        text.trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespacesAndNewlines))
    }
}

private extension String {
    func leftPadded(to width: Int) -> String {
        String(repeating: "0", count: max(0, width - count)) + self
    }
}
