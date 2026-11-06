import Foundation
import WebKit

/// 페이지를 읽는 동안 쓰는 차단 규칙입니다. 아카라이브와 Cloudflare 확인 화면 외의
/// 제3자 요청, 사이트의 광고 API를 막아 페이지의 추적 스크립트가 외부로 통신하지 못하게 합니다.
public enum PrivacyRules {
    public static let json = #"""
    [
      {"trigger": {"url-filter": ".*", "load-type": ["third-party"]}, "action": {"type": "block"}},
      {"trigger": {"url-filter": "^https?://([^/]+\\.)?arca\\.live/"}, "action": {"type": "ignore-previous-rules"}},
      {"trigger": {"url-filter": "^https?://challenges\\.cloudflare\\.com/"}, "action": {"type": "ignore-previous-rules"}},
      {"trigger": {"url-filter": "^https?://arca\\.live/api/v1/pagead"}, "action": {"type": "block"}}
    ]
    """#
}

/// 사용자가 로그인한 WKWebView로 페이지를 읽습니다.
/// Cloudflare 확인 화면이 나오면 통과를 대신하지 않고, 사용자가 직접 통과할 때까지 기다립니다.
@MainActor
public final class WebViewPageSource: NSObject, PageSource, WKNavigationDelegate {
    public let webView: WKWebView
    public var challengeTimeout: TimeInterval = 300
    public var pageTimeout: TimeInterval = 30
    /// 확인 화면이 나타나거나 사라질 때 호출됩니다. 앱은 이때 웹뷰를 보여 줍니다.
    public var onChallengeChanged: ((Bool) -> Void)?

    private var committed = false
    private var finished = false
    private var status = 0

    public init(webView: WKWebView) {
        self.webView = webView
        super.init()
    }

    public func load(_ url: URL, kind: PageKind) async throws -> LoadedPage {
        let previousDelegate = webView.navigationDelegate
        webView.navigationDelegate = self
        defer { webView.navigationDelegate = previousDelegate }

        committed = false
        finished = false
        status = 0
        webView.load(URLRequest(url: url))

        let selector = kind == .scrapList ? ".article-list" : ".article-content, .fr-view"
        var deadline = Date().addingTimeInterval(pageTimeout)
        var inChallenge = false
        defer { if inChallenge { onChallengeChanged?(false) } }

        while Date() < deadline {
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(250))
            guard committed else { continue }

            switch await evaluate(Self.stateScript(selector: selector)) ?? "loading" {
            case "challenge":
                if !inChallenge {
                    inChallenge = true
                    onChallengeChanged?(true)
                    deadline = Date().addingTimeInterval(challengeTimeout)
                }
            case "ready":
                if let html = await evaluate("document.documentElement.outerHTML") {
                    return LoadedPage(html: html, status: status == 0 ? 200 : status)
                }
            default:
                if inChallenge {
                    inChallenge = false
                    onChallengeChanged?(false)
                    deadline = Date().addingTimeInterval(pageTimeout)
                }
                if finished, status >= 400, let html = await evaluate("document.documentElement.outerHTML") {
                    return LoadedPage(html: html, status: status)
                }
            }
        }
        throw inChallenge ? UncaliveError.challengeTimedOut : UncaliveError.pageTimedOut(url)
    }

    public func userAgent() async -> String? {
        await evaluate("navigator.userAgent")
    }

    public func webArchiveData() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            webView.createWebArchiveData { continuation.resume(with: $0) }
        }
    }

    private func evaluate(_ script: String) async -> String? {
        await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script, in: nil, in: .defaultClient) { result in
                continuation.resume(returning: (try? result.get()) as? String)
            }
        }
    }

    private static func stateScript(selector: String) -> String {
        """
        (function () {
          const title = document.title || '';
          if (/just a moment|잠시만 기다|attention required/i.test(title) ||
              document.querySelector('#challenge-form, #challenge-stage, #challenge-error-text')) return 'challenge';
          if (document.readyState !== 'loading' && document.querySelector('\(selector)')) return 'ready';
          return 'waiting';
        })()
        """
    }

    public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        committed = true
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finished = true
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse {
            status = http.statusCode
        }
        return .allow
    }
}
