import SwiftUI

struct RootView: View {
    @Bindable var model: AppModel

    var body: some View {
        NavigationSplitView {
            List(selection: $model.section) {
                Label("스크랩", systemImage: "bookmark")
                    .badge(model.newScrapCount)
                    .tag(AppModel.Section.scraps)
                Label("주소 수집", systemImage: "link")
                    .badge(model.collection.entries.count)
                    .tag(AppModel.Section.collection)
                Label("다운로드", systemImage: "arrow.down.circle")
                    .badge(model.job?.isActive == true ? "진행 중" : nil)
                    .tag(AppModel.Section.downloads)
                Label("보관함", systemImage: "archivebox")
                    .badge(model.records.count)
                    .tag(AppModel.Section.library)
                Label("갤러리", systemImage: "photo.on.rectangle.angled")
                    .tag(AppModel.Section.gallery)
                Section {
                    Label("설정", systemImage: "gearshape").tag(AppModel.Section.settings)
                }
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190, max: 240)
            .safeAreaInset(edge: .bottom) { account }
        } detail: {
            switch model.section {
            case .scraps: EntryListView(model: model, list: model.scraps).id(AppModel.Section.scraps)
            case .collection: EntryListView(model: model, list: model.collection).id(AppModel.Section.collection)
            case .downloads: DownloadView(model: model)
            case .library: LibraryView(model: model)
            case .gallery: GalleryView(model: model)
            case .settings: SettingsView(model: model)
            }
        }
    }

    @ViewBuilder private var account: some View {
        HStack(spacing: 10) {
            Image(systemName: "person.crop.circle.fill")
                .font(.system(size: 30))
                .foregroundStyle(model.login == .loggedIn ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            VStack(alignment: .leading, spacing: 1) {
                switch model.login {
                case .loggedIn:
                    Text(model.username ?? "로그인됨")
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)
                    Button("로그아웃") { model.signOut() }
                        .buttonStyle(.link)
                        .font(.caption)
                        .disabled(model.job?.isActive == true)
                case .loggedOut:
                    Text("로그인 필요").font(.callout.weight(.semibold))
                    Button("로그인") { model.signIn() }
                        .buttonStyle(.link)
                        .font(.caption)
                case .unknown:
                    Text(model.username ?? "아카라이브").font(.callout.weight(.semibold))
                    Text("로그인 상태 확인 중…").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
    }
}
