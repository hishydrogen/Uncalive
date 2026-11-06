import AppKit
import QuickLook
import SwiftUI
import UncaliveCore

/// 받은 미디어만 모아 봅니다. 아카라이브의 카테고리별로 나눠 볼 수 있습니다.
struct GalleryView: View {
    private enum Kind: String, CaseIterable, Identifiable {
        case all = "전체", images = "이미지", videos = "동영상"
        var id: Self { self }
    }

    private struct Media: Identifiable {
        let url: URL
        let isVideo: Bool
        let item: ArchivedPost
        var id: URL { url }
    }

    let model: AppModel
    @State private var kind = Kind.all
    @State private var channel: String?
    @State private var category: String?
    @State private var source: ArchiveSource?
    @State private var search = ""
    @State private var preview: URL?

    /// 채널과 검색 조건에 맞는 글입니다.
    private var items: [ArchivedPost] {
        model.library
            .filter { channel == nil || $0.channel == channel }
            .filter { source == nil || $0.source == source }
            .filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }
            .sorted { $0.record.updatedAt > $1.record.updatedAt }
    }

    private var channels: [(id: String, name: String)] {
        var seen = Set<String>()
        return model.library.compactMap { item in
            seen.insert(item.channel).inserted ? (item.channel, item.channelName) : nil
        }.sorted { $0.name < $1.name }
    }

    /// 카테고리는 채널마다 다르므로 채널을 골랐을 때만 나눕니다.
    private var categories: [String] {
        guard channel != nil else { return [] }
        var names = ArchivedPost.categories(of: items)
        // 검색으로 글이 줄어도 선택한 카테고리는 계속 보여 줍니다.
        if let category, !names.contains(category) { names.append(category) }
        return names
    }

    private var media: [Media] {
        items.filter { category == nil || $0.category == category }.flatMap { item in
            let folder = model.folderURL(for: item.record)
            return item.record.files.values.filter { !$0.hasPrefix("assets/") }.sorted().compactMap { path -> Media? in
                let ext = (path as NSString).pathExtension.lowercased()
                let isVideo = Thumbnails.videoExtensions.contains(ext)
                guard isVideo || Thumbnails.imageExtensions.contains(ext) else { return nil }
                if kind == .images, isVideo { return nil }
                if kind == .videos, !isVideo { return nil }
                return Media(url: folder.appending(path: path), isVideo: isVideo, item: item)
            }
        }
    }

    var body: some View {
        let media = media
        VStack(spacing: 0) {
            if !categories.isEmpty {
                CategoryTabBar(categories: categories, selection: $category)
                Divider()
            }
            Group {
                if media.isEmpty {
                    ContentUnavailableView("표시할 미디어가 없습니다", systemImage: "photo.on.rectangle", description: Text("다운로드한 이미지와 동영상이 여기에 모입니다."))
                } else {
                    ScrollView {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: 8)], spacing: 8) {
                            ForEach(media) { file in
                                GalleryCell(url: file.url, isVideo: file.isVideo) { preview = file.url }
                                    .help(file.item.title)
                                    .contextMenu {
                                        Button("글 열기") { model.open(file.item.record) }
                                        Button("Finder에서 보기") { NSWorkspace.shared.activateFileViewerSelecting([file.url]) }
                                    }
                            }
                        }
                        .padding(12)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .quickLookPreview($preview, in: media.map(\.url))
        .navigationTitle("갤러리")
        .navigationSubtitle("\(media.count)개")
        .searchable(text: $search, prompt: "글 제목 검색")
        .onChange(of: channel) { category = nil }
        .onChange(of: model.libraryRoot) {
            channel = nil
            category = nil
            source = nil
        }
        .toolbar {
            ToolbarItemGroup {
                Picker("채널", selection: $channel) {
                    Text("모든 채널").tag(String?.none)
                    ForEach(channels, id: \.id) { Text($0.name).tag(String?.some($0.id)) }
                }
                SourcePicker(selection: $source)
                Picker("종류", selection: $kind) {
                    ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }
        }
    }
}

private struct GalleryCell: View {
    let url: URL
    let isVideo: Bool
    let action: () -> Void
    @State private var thumbnail: NSImage?

    var body: some View {
        Button(action: action) {
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .overlay(alignment: .top) {
                    if let thumbnail {
                        Image(nsImage: thumbnail).resizable().scaledToFill()
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    if isVideo {
                        Image(systemName: "play.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.white)
                            .shadow(radius: 3)
                            .padding(6)
                    }
                }
                .background(.quaternary)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .task(id: url) { thumbnail = await Thumbnails.image(for: url) }
    }
}
