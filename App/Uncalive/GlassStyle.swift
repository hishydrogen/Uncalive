import SwiftUI

/// macOS 26 이상에서는 리퀴드 글래스를, 이전 버전에서는 표준 재질을 씁니다.
extension View {
    @ViewBuilder func floatingGlass() -> some View {
        if #available(macOS 26, *) {
            padding(.horizontal, 16)
                .padding(.vertical, 12)
                .glassEffect(.regular, in: .rect(cornerRadius: 20))
        } else {
            padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(.bar, in: .rect(cornerRadius: 12))
        }
    }

    @ViewBuilder func prominentGlassButton() -> some View {
        if #available(macOS 26, *) {
            buttonStyle(.glassProminent)
        } else {
            buttonStyle(.borderedProminent)
        }
    }
}
