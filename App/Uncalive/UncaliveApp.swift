import AppKit
import SwiftUI

/// 개발본과 설치본이 서로의 파일을 건드리지 않게 이름과 기본 폴더를 나눕니다.
enum AppInfo {
    static let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "언카라이브"

    #if DEBUG
    static let defaultFolder = "Uncalive Dev"
    #else
    static let defaultFolder = "Uncalive"
    #endif
}

@main
struct UncaliveApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        Window(AppInfo.name, id: "main") {
            RootView(model: model)
                .frame(minWidth: 980, minHeight: 600)
                .task {
                    delegate.model = model
                    await model.start()
                }
        }
        .defaultSize(width: 1160, height: 720)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("설정…") { model.section = .settings }
                    .keyboardShortcut(",")
            }
            CommandGroup(after: .newItem) {
                Button("스크랩 목록 새로고침") { model.refreshScraps() }
                    .keyboardShortcut("r")
                    .disabled(model.isBusy || model.login == .loggedOut)
            }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?

    /// 다운로드 중이거나 자동 확인을 켠 동안에는 창을 닫아도 앱이 남습니다.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        model?.job?.isActive != true && UserDefaults.standard.integer(forKey: "autoCheckHours") == 0
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model, model.job?.isActive == true else { return .terminateNow }

        let alert = NSAlert()
        alert.messageText = "다운로드가 진행 중입니다"
        alert.informativeText = "지금 종료하면 다운로드 중인 파일은 저장되지 않습니다. 이미 다 받은 파일은 그대로 남으며, 나중에 다시 시작하면 나머지를 이어서 받습니다."
        // 첫 번째 버튼이 파란 기본 버튼이자 처음 포커스입니다.
        alert.addButton(withTitle: "계속 받기")
        let quit = alert.addButton(withTitle: "중단하고 종료")
        quit.hasDestructiveAction = true

        guard alert.runModal() == .alertSecondButtonReturn else { return .terminateCancel }
        Task {
            await model.cancelDownloadAndWait()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
