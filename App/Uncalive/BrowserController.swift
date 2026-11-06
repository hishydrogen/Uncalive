import AppKit
import UncaliveCore
import WebKit

/// 로그인에 쓰는 웹뷰와 그 창을 관리합니다.
/// 창은 로그인이나 Cloudflare 확인이 필요할 때만 보이고, 평소에는 숨긴 채 페이지를 읽습니다.
@MainActor
final class BrowserController: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    static let sessionCookie = "arca.at"

    let webView: WKWebView
    var onLoginDetected: (() -> Void)?

    private let window: NSWindow
    private var waitingForLogin = false
    private var loginWatch: Task<Void, Never>?
    private var privacyRuleList: WKContentRuleList?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // 창이 숨겨져 있어도 페이지가 멈추지 않게 합니다.
        configuration.preferences.inactiveSchedulingPolicy = .none
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 760), configuration: configuration)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1000, height: 760),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.center()

        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.delegate = self
        #if DEBUG
        installDiagnostics()
        #endif
    }

    func prepare() async {
        privacyRuleList = try? await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "uncalive.privacy",
            encodedContentRuleList: PrivacyRules.json
        )
        enablePrivacyRules()
    }

    /// 로그인 화면 외에는 항상 켜 둡니다.
    func enablePrivacyRules() {
        guard let privacyRuleList else { return }
        let controller = webView.configuration.userContentController
        controller.remove(privacyRuleList)
        controller.add(privacyRuleList)
    }

    func showLogin() {
        waitingForLogin = true
        // 로그인 절차가 쓰는 외부 요소가 막히지 않도록 이 화면에서만 끕니다.
        if let privacyRuleList { webView.configuration.userContentController.remove(privacyRuleList) }
        window.title = "아카라이브 로그인"
        // goto가 없으면 사이트가 로그인 뒤 /u/null(404)로 이동합니다.
        webView.load(URLRequest(url: URL(string: "https://arca.live/u/login?goto=%2F")!))
        present()
        watchForLogin()
    }

    /// 로그인 뒤 사이트가 다음 화면으로 넘어가지 않아도 알 수 있게 세션 쿠키를 직접 살핍니다.
    private func watchForLogin() {
        loginWatch?.cancel()
        loginWatch = Task {
            let previous = await sessionValue()
            while waitingForLogin, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                _ = try? await webView.evaluateJavaScript(Self.loginFixupScript)
                #if DEBUG
                await logLoginState()
                #endif
                if let current = await sessionValue(), current != previous {
                    finishLogin()
                    return
                }
            }
        }
    }

    /// 아카라이브 로그인 페이지가 캡챠 단계(stage-3)를 중복 초기화할 때
    /// Turnstile 위젯은 성공했는데 로그인 버튼이 숨겨진 채 멈추는 사이트 버그를 보완합니다.
    private static let loginFixupScript = """
    (function () {
      if (typeof turnstile === 'undefined') return;
      if (!turnstile.__uncalivePatched && typeof turnstile.render === 'function') {
        turnstile.__uncalivePatched = true;
        const origRender = turnstile.render.bind(turnstile);
        turnstile.render = function (container, options) {
          const el = typeof container === 'string' ? document.querySelector(container) : container;
          if (el && el.childElementCount > 0) {
            try { turnstile.remove(el); } catch (e) { el.innerHTML = ''; }
          }
          return origRender(container, options);
        };
      }
      const stage = document.querySelector('#stage-3.active');
      if (!stage) {
        window.__uncaliveSubmittedToken = null;
        return;
      }
      let token = null;
      try {
        if (turnstile.isExpired && turnstile.isExpired()) {
          turnstile.reset();
          return;
        }
        token = turnstile.getResponse();
      } catch (e) {}
      if (!token) return;
      const button = stage.querySelector('button[data-submitstage]');
      if (!button) return;
      if (getComputedStyle(button).display === 'none') {
        button.style.display = '';
        if (window.__uncaliveSubmittedToken !== token) {
          window.__uncaliveSubmittedToken = token;
          button.click();
        }
      }
    })();
    true
    """

    private func finishLogin() {
        guard waitingForLogin else { return }
        DebugLog.write("로그인 감지: 세션 쿠키 변경")
        waitingForLogin = false
        loginWatch?.cancel()
        enablePrivacyRules()
        hide()
        onLoginDetected?()
    }

    /// 로그인 창을 닫으면 그 시점의 로그인 여부를 확인합니다.
    func windowWillClose(_ notification: Notification) {
        guard waitingForLogin else { return }
        DebugLog.write("로그인 창 닫힘")
        Task {
            if await hasSession() {
                finishLogin()
            } else {
                waitingForLogin = false
                loginWatch?.cancel()
                enablePrivacyRules()
            }
        }
    }

    func showChallenge() {
        window.title = "Cloudflare 보안 확인을 완료해 주세요"
        present()
    }

    func hide() {
        window.orderOut(nil)
    }

    func hasSession() async -> Bool {
        await sessionValue() != nil
    }

    /// 로그인이 바뀌었는지 비교하는 데만 쓰고 저장하지 않습니다.
    private func sessionValue() async -> String? {
        let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
        return cookies.first { $0.name == Self.sessionCookie && $0.domain.hasSuffix("arca.live") }?.value
    }

    /// 이 앱에 저장된 아카라이브 로그인 정보를 지웁니다.
    func signOut() async {
        let store = webView.configuration.websiteDataStore
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        let records = await store.dataRecords(ofTypes: types).filter { $0.displayName.contains("arca.live") }
        await store.removeData(ofTypes: types, for: records)
    }

    private func present() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// 새 창을 여는 링크도 같은 웹뷰에서 엽니다.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        webView.load(navigationAction.request)
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "확인")
        alert.addButton(withTitle: "취소")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

#if DEBUG
/// 개발 빌드 전용 진단입니다. 입력값, 쿠키 값, 토큰은 기록하지 않고 단계와 참거짓만 남깁니다.
extension BrowserController: WKScriptMessageHandler {
    private static let diagnosticsScript = """
    (function () {
      const send = t => { try { window.webkit.messageHandlers.uncaliveDebug.postMessage(String(t).slice(0, 200)); } catch (e) {} };
      const clean = u => { try { const x = new URL(u, location.href); return x.host + x.pathname; } catch (e) { return '?'; } };
      addEventListener('error', e => {
        if (e.target && e.target !== window) send('리소스 실패 ' + e.target.tagName + ' ' + clean(e.target.src || e.target.href));
        else send('JS 오류 ' + e.message + ' @' + clean(e.filename) + ':' + e.lineno);
      }, true);
      addEventListener('unhandledrejection', e => send('Promise 거부 ' + (e.reason && e.reason.message || e.reason)));
      addEventListener('securitypolicyviolation', e => send('CSP 차단 ' + e.violatedDirective + ' ' + clean(e.blockedURI)));
      try {
        new PerformanceObserver(list => list.getEntries().forEach(r => {
          if (r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest')
            send('요청 ' + clean(r.name) + ' 상태=' + (r.responseStatus ?? '?') + ' ' + Math.round(r.duration) + 'ms');
        })).observe({ type: 'resource', buffered: true });
      } catch (e) {}
    })();
    """

    private static let stateScript = """
    (function () {
      const stage = [...document.querySelectorAll('[id^="stage-"]')].find(e => e.classList.contains('active'));
      const button = stage && stage.querySelector('button[data-submitstage]');
      let response = null;
      try { response = typeof turnstile === 'undefined' ? null : !!turnstile.getResponse(); } catch (e) { response = 'error'; }
      const modal = document.querySelector('.modal.show');
      return JSON.stringify({
        path: location.pathname, ready: document.readyState, visible: document.visibilityState,
        stage: stage ? stage.id : null,
        button: button ? getComputedStyle(button).display : null,
        turnstile: typeof turnstile, token: response, modal: !!modal
      });
    })()
    """

    func installDiagnostics() {
        webView.isInspectable = true
        let controller = webView.configuration.userContentController
        controller.add(self, name: "uncaliveDebug")
        controller.addUserScript(WKUserScript(source: Self.diagnosticsScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        DebugLog.write("=== 개발 빌드 시작 ===")
    }

    nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let text = message.body as? String ?? "?"
        Task { @MainActor in DebugLog.write("[페이지] \(text)") }
    }

    func logLoginState() async {
        let cookie = await hasSession()
        let state = (try? await webView.evaluateJavaScript(Self.stateScript)) as? String ?? "상태 없음"
        DebugLog.writeChange("[로그인 창] 세션=\(cookie) \(state)")
    }
}
#endif

