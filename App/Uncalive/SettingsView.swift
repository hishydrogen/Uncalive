import SwiftUI
import UncaliveCore

struct SettingsView: View {
    @Bindable var model: AppModel

    var body: some View {
        TabView {
            GeneralSettings(model: model)
                .tabItem { Label("일반", systemImage: "gearshape") }
            MediaSettings(options: $model.options)
                .tabItem { Label("미디어", systemImage: "photo.on.rectangle") }
            ArchiveSettings(options: $model.options)
                .tabItem { Label("페이지 저장", systemImage: "doc.richtext") }
            SpeedSettings(options: $model.options)
                .tabItem { Label("속도", systemImage: "speedometer") }
        }
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
        .navigationTitle("설정")
    }
}

/// 숫자를 키보드로 바로 입력하는 칸입니다. 범위를 벗어나면 가까운 값으로 맞춥니다.
struct NumberField: View {
    @Binding var value: Int
    let range: ClosedRange<Int>

    var body: some View {
        TextField("", value: Binding(
            get: { value },
            set: { value = min(max($0, range.lowerBound), range.upperBound) }
        ), format: .number.grouping(.never))
        .labelsHidden()
        .multilineTextAlignment(.trailing)
        .textFieldStyle(.roundedBorder)
        .frame(width: 80)
    }
}

/// 슬라이더 옆에 현재 값을 보여 줍니다.
private struct SecondsSlider: View {
    let title: String
    @Binding var value: TimeInterval
    let range: ClosedRange<TimeInterval>
    let step: TimeInterval

    var body: some View {
        LabeledContent(title) {
            HStack {
                Slider(value: $value, in: range, step: step)
                    .labelsHidden()
                    .frame(width: 200)
                Text("\(value.formatted(.number.precision(.fractionLength(1))))초")
                    .monospacedDigit()
                    .frame(width: 48, alignment: .trailing)
            }
        }
    }
}

private struct GeneralSettings: View {
    @Bindable var model: AppModel

    private enum RangeMode: Hashable {
        case all, custom
    }

    private var mode: Binding<RangeMode> {
        Binding(
            get: { model.options.pages == .init() ? .all : .custom },
            set: { model.options.pages = $0 == .all ? .init() : .init(first: 1, last: 10) }
        )
    }

    private var lastPage: Binding<Int> {
        Binding(
            get: { model.options.pages.last ?? model.options.pages.first },
            set: { model.options.pages.last = $0 }
        )
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("저장 위치") {
                    HStack {
                        Text(model.options.destination.path(percentEncoded: false))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Button("변경…") { model.chooseDestination() }
                            .disabled(model.job?.isActive == true)
                    }
                }
                Toggle("계정마다 보관함 나누기", isOn: $model.useAccountFolder)
                    .disabled(model.job?.isActive == true)
            } footer: {
                Text("현재 보관함: \(model.libraryRoot.path(percentEncoded: false))\n로그인한 계정을 바꾸면 해당 계정의 보관함과 주소 수집 목록으로 전환됩니다.")
            }
            Section("스크랩 목록") {
                Picker("불러올 범위", selection: mode) {
                    Text("전체").tag(RangeMode.all)
                    Text("페이지 지정").tag(RangeMode.custom)
                }
                .pickerStyle(.segmented)
                if mode.wrappedValue == .custom {
                    LabeledContent("페이지") {
                        HStack {
                            NumberField(value: $model.options.pages.first, range: 1...100_000)
                            Text("페이지부터")
                            NumberField(value: lastPage, range: model.options.pages.first...100_000)
                            Text("페이지까지")
                        }
                    }
                }
            }
            Section {
                Picker("확인 주기", selection: $model.autoCheckHours) {
                    Text("끄기").tag(0)
                    Text("1시간").tag(1)
                    Text("6시간").tag(6)
                    Text("12시간").tag(12)
                    Text("하루").tag(24)
                }
                Toggle("새 스크랩 자동으로 받기", isOn: $model.autoDownloadNew)
                    .disabled(model.autoCheckHours == 0)
                LabeledContent("마지막 확인") {
                    HStack {
                        Text(model.lastCheck?.formatted(date: .omitted, time: .shortened) ?? "없음")
                        Button("지금 확인") { Task { await model.checkForNewScraps() } }
                            .disabled(model.isBusy || model.login != .loggedIn)
                    }
                }
            } header: {
                Text("새 스크랩 자동 확인")
            } footer: {
                Text("앱이 실행 중일 때는 첫 페이지부터 확인해 이전에 불러온 글이 나올 때까지 새 스크랩을 찾으므로, 여러 페이지를 스크랩해도 놓치지 않습니다. 자동 확인을 켜 두면 창을 닫아도 앱이 Dock에 남아 동작하며, 알림에는 글 제목이 표시되지 않습니다.")
            }
            Section("폴더") {
                Picker("폴더 이름", selection: $model.options.folderNaming) {
                    Text("제목").tag(DownloadOptions.FolderNaming.title)
                    Text("글 번호_제목").tag(DownloadOptions.FolderNaming.idAndTitle)
                }
                Toggle("채널별 폴더로 나누기", isOn: $model.options.groupByChannel)
                LabeledContent("이름 최대 길이") {
                    HStack {
                        NumberField(value: $model.options.folderNameMaxLength, range: 20...120)
                        Text("자")
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}

private struct MediaSettings: View {
    @Binding var options: DownloadOptions

    var body: some View {
        Form {
            Section {
                Picker("화질", selection: $options.quality) {
                    ForEach(DownloadOptions.Quality.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
            } footer: {
                Text(options.quality.detail)
            }
            Section("받을 파일") {
                Toggle("이미지", isOn: $options.includeImages)
                Toggle("동영상", isOn: $options.includeVideos)
                Toggle("오디오", isOn: $options.includeAudio)
                Toggle("본문 아카콘", isOn: $options.includeEmoticons)
                Toggle("동영상 표지 이미지", isOn: $options.includeVideoPosters)
            }
            Picker("파일 이름", selection: $options.fileNaming) {
                Text("01.jpg").tag(DownloadOptions.FileNaming.sequence)
                Text("01_원본이름.jpg").tag(DownloadOptions.FileNaming.sequenceAndOriginalName)
            }
        }
        .formStyle(.grouped)
    }
}

private struct ArchiveSettings: View {
    @Binding var options: DownloadOptions

    var body: some View {
        Form {
            Section {
                Toggle("오프라인 페이지 (index.html)", isOn: $options.archive.offlineHTML)
                Toggle("댓글 포함", isOn: $options.archive.includeComments)
                    .disabled(!options.archive.offlineHTML)
            } footer: {
                Text("다운로드한 미디어가 본문에 연결되어 있어, 인터넷 없이도 어느 브라우저에서나 열 수 있습니다.")
            }
            Section {
                Toggle("글 정보 (post.json)", isOn: $options.archive.metadataJSON)
                Toggle("Safari 웹 아카이브 (page.webarchive)", isOn: $options.archive.webArchive)
                Toggle("페이지 원문 (page.html)", isOn: $options.archive.rawHTML)
            } footer: {
                Text("웹 아카이브는 글마다 약 2MB의 용량을 더 차지합니다. 페이지 원문에는 로그인한 계정의 닉네임이 포함될 수 있습니다.")
            }
        }
        .formStyle(.grouped)
    }
}

private struct SpeedSettings: View {
    @Binding var options: DownloadOptions

    var body: some View {
        Form {
            Section {
                SecondsSlider(title: "글 사이 대기", value: $options.pageDelay, range: 1...10, step: 0.5)
                SecondsSlider(title: "파일 사이 대기", value: $options.mediaDelay, range: 0...2, step: 0.1)
            } footer: {
                Text("글을 너무 빠르게 연속해서 열면 이용이 제한될 수 있습니다. 앞선 글의 파일을 받는 동안 다음 글을 미리 불러오므로, 대기 시간을 늘려도 전체 소요 시간은 크게 늘어나지 않습니다.")
            }
            Section {
                Picker("CDN 동시 다운로드", selection: $options.maxConcurrentDownloads) {
                    ForEach([1, 2, 4, 6], id: \.self) { Text("\($0)개").tag($0) }
                }
                .pickerStyle(.segmented)
                Picker("실패 시 재시도", selection: $options.retryCount) {
                    ForEach([0, 1, 3, 5], id: \.self) { Text("\($0)회").tag($0) }
                }
                .pickerStyle(.segmented)
            } footer: {
                Text("원본 서버는 자체 연결 제한에 맞춰 동시 다운로드 수를 2개로 고정합니다.")
            }
        }
        .formStyle(.grouped)
    }
}
