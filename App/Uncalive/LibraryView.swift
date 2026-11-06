import AppKit
import SwiftUI
import UncaliveCore

struct LibraryView: View {
    private enum Layout: String, CaseIterable, Identifiable {
        case grid = "격자", list = "목록"
        var id: Self { self }
    }

    private struct ChannelGroup: Identifiable {
        let id: String
        let name: String
        let posts: [ArchivedPost]
    }

    let model: AppModel
    @State private var search = ""
    @State private var channel: String?
    @State private var category: String?
    @State private var source: ArchiveSource?
    @State private var collapsed = Set<String>()
    @AppStorage("libraryLayout") private var layout = Layout.grid

    private var channelPosts: [ArchivedPost] {
        model.library
            .filter { channel == nil || $0.channel == channel }
            .filter { source == nil || $0.source == source }
            .filter { search.isEmpty || $0.matches(search) || $0.author?.localizedCaseInsensitiveContains(search) == true }
            .sorted { $0.record.updatedAt > $1.record.updatedAt }
    }

    private var posts: [ArchivedPost] {
        channelPosts.filter { category == nil || $0.category == category }
    }

    private var channels: [(id: String, name: String)] {
        var seen = Set<String>()
        return model.library.compactMap { post in
            seen.insert(post.channel).inserted ? (post.channel, post.channelName) : nil
        }.sorted { $0.name < $1.name }
    }

    /// 카테고리는 채널마다 다르므로 채널을 골랐을 때만 나눕니다.
    private var categories: [String] {
        guard channel != nil else { return [] }
        var names = ArchivedPost.categories(of: channelPosts)
        // 검색으로 글이 줄어도 선택한 카테고리는 계속 보여 줍니다.
        if let category, !names.contains(category) { names.append(category) }
        return names
    }

    private var groups: [ChannelGroup] {
        Dictionary(grouping: posts, by: \.channel)
            .map { ChannelGroup(id: $0.key, name: $0.value[0].channelName, posts: $0.value) }
            .sorted { $0.name < $1.name }
    }

    private var isGrouped: Bool {
        channel == nil
    }

    private let columns = [GridItem(.adaptive(minimum: 220, maximum: 340), spacing: 16)]

    var body: some View {
        VStack(spacing: 0) {
            if !categories.isEmpty {
                CategoryTabBar(categories: categories, selection: $category)
                Divider()
            }
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle("보관함")
        .navigationSubtitle("\(posts.count)개 · \(model.libraryRoot.path(percentEncoded: false))")
        .searchable(text: $search, prompt: "제목, 작성자, 본문, 댓글 검색")
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
                Picker("보기", selection: $layout) {
                    ForEach(Layout.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }
        }
    }

    @ViewBuilder private var content: some View {
        if model.library.isEmpty {
            if model.isLoadingLibrary {
                ProgressView("보관함을 불러오는 중입니다")
            } else {
                ContentUnavailableView("받은 글이 없습니다", systemImage: "archivebox", description: Text("다운로드한 글이 여기에 표시됩니다."))
            }
        } else if posts.isEmpty {
            if search.isEmpty {
                ContentUnavailableView("표시할 글이 없습니다", systemImage: "archivebox", description: Text("다른 채널이나 카테고리, 출처를 선택해 보세요."))
            } else {
                ContentUnavailableView.search(text: search)
            }
        } else if layout == .grid {
            gridContent
        } else {
            listContent
        }
    }

    @ViewBuilder private var gridContent: some View {
        ScrollView {
            if isGrouped {
                LazyVStack(alignment: .leading, spacing: 12, pinnedViews: .sectionHeaders) {
                    ForEach(groups) { group in
                        Section {
                            if !collapsed.contains(group.id) { grid(group.posts).padding(.horizontal, 20) }
                        } header: {
                            header(group)
                                .padding(.horizontal, 20)
                                .padding(.vertical, 8)
                                .background(.bar)
                        }
                    }
                }
            } else {
                grid(posts).padding(20)
            }
        }
    }

    private func grid(_ posts: [ArchivedPost]) -> some View {
        LazyVGrid(columns: columns, spacing: 20) {
            ForEach(posts) { LibraryCard(model: model, item: $0, search: search) }
        }
    }

    @ViewBuilder private var listContent: some View {
        if isGrouped {
            List {
                ForEach(groups) { group in
                    Section {
                        if !collapsed.contains(group.id) {
                            ForEach(group.posts) { LibraryRow(model: model, item: $0, search: search) }
                        }
                    } header: {
                        header(group)
                    }
                }
            }
        } else {
            List(posts) { LibraryRow(model: model, item: $0, search: search) }
        }
    }

    /// 눌러서 접고 펼 수 있는 채널 머리글입니다.
    private func header(_ group: ChannelGroup) -> some View {
        HStack {
            Button {
                if collapsed.contains(group.id) { collapsed.remove(group.id) } else { collapsed.insert(group.id) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: collapsed.contains(group.id) ? "chevron.right" : "chevron.down")
                        .font(.caption.weight(.semibold))
                        .frame(width: 12)
                    Text(group.name).font(.headline)
                    Text("\(group.posts.count)").foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Spacer()
        }
    }
}

/// 번호가 붙은 첫 사진이나 동영상을 대표 파일로 씁니다.
@MainActor private func coverURL(of item: ArchivedPost, model: AppModel) -> URL? {
    item.record.files.values
        .filter { !$0.hasPrefix("assets/") }
        .filter {
            let ext = ($0 as NSString).pathExtension.lowercased()
            return Thumbnails.imageExtensions.contains(ext) || Thumbnails.videoExtensions.contains(ext)
        }
        .min()
        .map { model.folderURL(for: item.record).appending(path: $0) }
}

private func metadata(of item: ArchivedPost) -> String {
    var parts = [item.channelName]
    if let category = item.category { parts.append(category) }
    if let author = item.author { parts.append(author) }
    parts.append("파일 \(item.record.files.count)개")
    if !item.record.completed { parts.append("일부만 받음") }
    return parts.joined(separator: " · ")
}

private struct LibraryCard: View {
    let model: AppModel
    let item: ArchivedPost
    let search: String
    @State private var thumbnail: NSImage?

    var body: some View {
        Button { model.open(item.record) } label: {
            VStack(alignment: .leading, spacing: 8) {
                Color.clear
                    .aspectRatio(4 / 3, contentMode: .fit)
                    .overlay(alignment: .top) {
                        if let thumbnail {
                            Image(nsImage: thumbnail).resizable().scaledToFill()
                        } else {
                            Image(systemName: "doc.richtext")
                                .font(.largeTitle)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                    .background(.quaternary)
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                Text(item.title)
                    .font(.callout.weight(.medium))
                    .lineLimit(2, reservesSpace: true)
                    .multilineTextAlignment(.leading)
                Text(item.snippet(for: search) ?? metadata(of: item))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(item.title)
        .libraryMenu(model: model, item: item)
        .task(id: item.record.updatedAt) {
            if let url = coverURL(of: item, model: model) { thumbnail = await Thumbnails.image(for: url) }
        }
    }
}

private struct LibraryRow: View {
    let model: AppModel
    let item: ArchivedPost
    let search: String
    @State private var thumbnail: NSImage?

    var body: some View {
        HStack(spacing: 12) {
            Color.clear
                .frame(width: 64, height: 64)
                .overlay(alignment: .top) {
                    if let thumbnail {
                        Image(nsImage: thumbnail).resizable().scaledToFill()
                    } else {
                        Image(systemName: "doc.richtext")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .background(.quaternary)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).lineLimit(1)
                Text(metadata(of: item)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let snippet = item.snippet(for: search) {
                    Text(snippet).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            Spacer()
            Button("열기") { model.open(item.record) }
        }
        .padding(.vertical, 2)
        .libraryMenu(model: model, item: item)
        .task(id: item.record.updatedAt) {
            if let url = coverURL(of: item, model: model) { thumbnail = await Thumbnails.image(for: url) }
        }
    }
}

private extension View {
    func libraryMenu(model: AppModel, item: ArchivedPost) -> some View {
        contextMenu {
            Button("열기") { model.open(item.record) }
            Button("Finder에서 보기") { model.reveal(item.record) }
        }
    }
}
