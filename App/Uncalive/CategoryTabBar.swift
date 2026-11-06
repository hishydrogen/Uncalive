import SwiftUI
import UncaliveCore

extension ArchivedPost {
    /// 글이 많은 카테고리부터 나열합니다.
    static func categories(of posts: [ArchivedPost]) -> [String] {
        let counts = Dictionary(grouping: posts.compactMap(\.category), by: { $0 }).mapValues(\.count)
        return counts.keys.sorted { (counts[$1] ?? 0, $0) < (counts[$0] ?? 0, $1) }
    }
}

/// 아카라이브 게시판의 카테고리 줄과 같은 모양입니다.
struct CategoryTabBar: View {
    let categories: [String]
    @Binding var selection: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                tab("전체", isSelected: selection == nil) { selection = nil }
                ForEach(categories, id: \.self) { name in
                    tab(name, isSelected: selection == name) { selection = name }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
        // 가로 스크롤 영역이 세로 공간까지 차지하지 않게 합니다.
        .fixedSize(horizontal: false, vertical: true)
    }

    private func tab(_ title: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Text(title)
                    .font(.callout.weight(isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? .primary : .secondary)
                Rectangle()
                    .fill(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.clear))
                    .frame(height: 2)
            }
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// 보관함과 갤러리에서 글의 출처를 고릅니다. `nil`은 전체입니다.
struct SourcePicker: View {
    @Binding var selection: ArchiveSource?

    var body: some View {
        Picker("출처", selection: $selection) {
            Text("전체").tag(ArchiveSource?.none)
            ForEach(ArchiveSource.allCases, id: \.self) { source in
                Text(source.rawValue).tag(ArchiveSource?.some(source))
            }
        }
        .pickerStyle(.segmented)
    }
}
