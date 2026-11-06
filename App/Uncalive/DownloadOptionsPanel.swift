import SwiftUI
import UncaliveCore

extension DownloadOptions.Quality {
    var title: String {
        switch self {
        case .original: "원본"
        case .balanced: "균형"
        case .display: "웹 표시용"
        }
    }

    var detail: String {
        switch self {
        case .original:
            "모든 파일을 원본으로 받습니다. 원본 서버의 속도 제한(약 200KB/s) 때문에 가장 느립니다."
        case .balanced:
            "가로 1280px보다 큰 이미지만 원본으로 받습니다. 그 이하인 이미지는 해상도가 같은 압축본으로 받아 속도가 훨씬 빠릅니다."
        case .display:
            "모든 이미지를 웹 표시용 압축본으로 받습니다. 가장 빠르지만, 큰 이미지는 가로 1280px 크기로 줄어듭니다."
        }
    }
}

/// 다운로드 전에 자주 바꾸는 옵션을 스크랩 화면 옆에서 바로 보여 줍니다.
struct DownloadOptionsPanel: View {
    @Bindable var model: AppModel

    var body: some View {
        Form {
            Section("저장 위치") {
                HStack {
                    Text(model.libraryRoot.path(percentEncoded: false))
                        .font(.caption)
                        .lineLimit(2)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    Button("변경…") { model.chooseDestination() }
                        .disabled(model.job?.isActive == true)
                }
            }

            Section {
                Picker("화질", selection: $model.options.quality) {
                    ForEach(DownloadOptions.Quality.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                Text(model.options.quality.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } header: {
                Text("화질")
            }

            Section("받을 파일") {
                Toggle("이미지", isOn: $model.options.includeImages)
                Toggle("동영상", isOn: $model.options.includeVideos)
                Toggle("오디오", isOn: $model.options.includeAudio)
                Toggle("본문 아카콘", isOn: $model.options.includeEmoticons)
            }

            Section("페이지 저장") {
                Toggle("오프라인 페이지", isOn: $model.options.archive.offlineHTML)
                Toggle("댓글 포함", isOn: $model.options.archive.includeComments)
                    .disabled(!model.options.archive.offlineHTML)
            }

            Section {
                Button {
                    model.section = .settings
                } label: {
                    Label("모든 설정 보기", systemImage: "gearshape")
                }
                .buttonStyle(.link)
            }
        }
        .formStyle(.grouped)
    }
}
