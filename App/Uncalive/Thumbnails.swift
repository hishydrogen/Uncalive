import AVFoundation
import AppKit
import ImageIO

/// 보관함과 갤러리의 썸네일을 만듭니다. 만든 썸네일은 메모리에 잠시 보관합니다.
enum Thumbnails {
    private final class Cache: @unchecked Sendable {
        let store = NSCache<NSURL, NSImage>()
    }

    private static let cache: Cache = {
        let cache = Cache()
        cache.store.countLimit = 600
        return cache
    }()

    static let imageExtensions: Set<String> = ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "heic", "heif", "tiff"]
    static let videoExtensions: Set<String> = ["mp4", "webm", "mov", "mpeg", "mkv", "avi", "ogv"]

    static func image(for url: URL) async -> NSImage? {
        if let cached = cache.store.object(forKey: url as NSURL) { return cached }
        let picture = await Task.detached(priority: .utility) { await render(url) }.value
        guard let picture else { return nil }
        let image = NSImage(cgImage: picture, size: .zero)
        cache.store.setObject(image, forKey: url as NSURL)
        return image
    }

    private static func render(_ url: URL) async -> CGImage? {
        guard imageExtensions.contains(url.pathExtension.lowercased()) else {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 720, height: 720)
            return try? await generator.image(at: .zero).image
        }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        // 세로로 아주 긴 이미지는 전체를 줄이면 알아볼 수 없으니 윗부분을 씁니다.
        if let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let width = properties[kCGImagePropertyPixelWidth] as? Int,
           let height = properties[kCGImagePropertyPixelHeight] as? Int,
           height > width * 2,
           let full = CGImageSourceCreateImageAtIndex(source, 0, nil) {
            return full.cropping(to: CGRect(x: 0, y: 0, width: width, height: width))
        }
        let settings: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 720,
            kCGImageSourceCreateThumbnailWithTransform: true
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, settings as CFDictionary)
    }
}
