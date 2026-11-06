# 언카라이브 개발 안내

언카라이브를 고치거나 직접 빌드하려는 분을 위한 문서입니다. 쓰는 법은 [README](README.md)를 보세요.

## 구조

언카라이브는 핵심 로직을 담은 Swift 패키지(`UncaliveCore`)와 macOS용 SwiftUI 앱(`App`) 두 부분으로 이루어져 있습니다.

```
UncaliveCore/                                목록과 게시글 파싱, 다운로드, 오프라인 보관 엔진
  Sources/UncaliveCore/
    Models.swift                             게시글, 댓글, 미디어 참조, 오류 타입
    DownloadOptions.swift                    다운로드와 보관 설정 값
    ArcaParser.swift                         아카라이브 HTML 파서(SwiftSoup 사용)
    WebViewPageSource.swift                  WKWebView 기반 페이지 로더와 제3자 요청 차단 규칙
    ScrapEngine.swift                        목록 수집, 게시글 선읽기, 다운로드 흐름 제어
    MediaDownloader.swift                    화질 선택, 연결 수 제한, 조각 다운로드, 파일 형식 판별
    Limiter.swift                            원본 서버와 CDN의 동시 연결 수 제한기
    PostArchiver.swift                       오프라인 페이지(index.html)와 글 정보(post.json) 생성
    ResumeStore.swift                        진행 상태 기록(.uncalive/state.json)과 폴더 예약
    LibraryStore.swift                       보관함 색인(.uncalive/text/)과 CSV 내보내기
    FileNaming.swift                         파일 및 폴더 이름 정제와 순번 매기기
  Tests/UncaliveCoreTests/                   단위 시험과 HTML 픽스처

App/                                         macOS용 SwiftUI 앱
  Uncalive.xcodeproj                         Xcode 프로젝트
  Uncalive/
    UncaliveApp.swift                        앱 진입점, 메뉴 명령, 종료 확인
    AppModel.swift                           전체 화면 상태, 자동 확인, 다운로드 작업 연결
    BrowserController.swift                  로그인 및 Cloudflare 보안 확인용 웹뷰 창 관리
    RootView.swift                           사이드바와 계정 상태 표시
    EntryList.swift                          스크랩 및 주소 수집 목록의 필터 상태
    EntryListView.swift                      글 목록 표, 필터 막대, 하단 작업 막대
    AddURLsSheet.swift                       주소 추가와 수집 범위 지정 시트
    DownloadOptionsPanel.swift               목록 옆 다운로드 옵션 인스펙터
    DownloadView.swift                       다운로드 진행률, 통계, 실시간 로그 화면
    DownloadJob.swift                        다운로드 한 회차의 진행 상태 집계
    LibraryView.swift                        보관함 격자 및 목록 보기, 본문 검색
    GalleryView.swift                        미디어 모아 보기와 Quick Look 미리 보기
    CategoryTabBar.swift                     카테고리 탭 막대와 출처 선택기
    SettingsView.swift                       일반, 미디어, 페이지 저장, 속도 설정 화면
    Thumbnails.swift                         이미지와 동영상 썸네일 생성 및 메모리 캐시
    GlassStyle.swift                         macOS 26 리퀴드 글래스 및 이전 버전 호환 스타일
    DebugLog.swift                           개발 빌드 전용 진단 로그
  scripts/
    build-app.sh                             개발용 앱(App/build/Uncalive Dev.app) 빌드
    install-app.sh                           실사용 앱(/Applications/언카라이브.app) 빌드 및 설치
```

## 실행과 시험

Xcode 16 이상(Swift 6.0)과 macOS 14.0 이상이 필요합니다.

```bash
cd UncaliveCore && swift test                # 코어 패키지 단위 시험 실행
./App/scripts/build-app.sh                   # 개발용 앱(App/build/Uncalive Dev.app) 빌드
./App/scripts/install-app.sh                 # 실사용 앱(/Applications/언카라이브.app) 빌드 및 설치
```

- **개발본과 설치본 분리**: 개발본(`Debug`)은 앱 이름이 `Uncalive Dev`, 번들 ID가 `io.github.hishydrogen.uncalive.dev`, 기본 보관함이 `~/Uncalive Dev`입니다. 설치본(`Release`)은 앱 이름이 `언카라이브`, 실행 파일 이름이 `Uncalive`, 번들 ID가 `io.github.hishydrogen.uncalive`, 기본 보관함이 `~/Uncalive`입니다. 두 앱은 로그인 세션, 설정, 보관함을 서로 건드리지 않습니다.
- **개발 로그**: 개발본(`Debug`)으로 실행할 때만 `~/Library/Logs/Uncalive Dev/debug.log`에 진행 상태가 기록됩니다. 쿠키 값이나 입력값 같은 민감한 정보는 기록하지 않으며, 릴리스 설치본에서는 아무 기록도 남기지 않습니다.

## 설계 특징

- **사이트 구조 분리**: 아카라이브의 HTML 선택자는 `ArcaParser.swift` 한 곳에만 모여 있습니다. 사이트 구조가 바뀌면 이 파일만 고치면 됩니다.
- **웹뷰와 다운로더 분리**: 로그인과 Cloudflare 보안 확인이 필요한 페이지 읽기는 숨겨진 `WKWebView`(`WebViewPageSource`)가 맡고, 미디어 파일 다운로드는 `URLSession`(`MediaDownloader`)이 맡습니다. 앞선 글의 미디어를 받는 동안 다음 글을 최대 3개까지 미리 읽어(`maxPostsInFlight = 3`) 대기 시간이 전체 다운로드 시간을 늘리지 않게 합니다.
- **원본 서버 제한 준수**: 아카라이브 원본 이미지 서버(`ac-o.arca.live`)는 IP당 동시 연결이 2개를 넘으면 `HTTP 429`를 반환합니다. `MediaDownloader`는 원본 서버 연결을 항상 2개로 제한하고, CDN(`ac.arca.live`) 파일과 원본 파일의 `ETag`가 같으면 빠른 CDN에서 먼저 받습니다. 2MB 이상인 원본 파일은 1MB 조각(`Range`)으로 나누어 받아 두 연결 슬롯이 놀지 않게 합니다.
- **안전한 파일 저장과 이어받기**: 내려받는 파일은 임시 파일과 `.part`를 거쳐 끝까지 받은 뒤에만 최종 이름을 얻습니다. 완료된 파일은 보관함 안의 `.uncalive/state.json`에 기록되어, 작업을 중단하거나 재실행할 때 이미 받은 파일을 재사용합니다. 원본 화질을 요청했으나 서버 문제로 표시용 화질만 받은 경우에는 완료로 표시하지 않아 다음 실행 때 원본을 다시 시도합니다.
- **오프라인 페이지 재작성**: `PostArchiver`는 본문과 댓글 HTML에서 `<script>`, `<style>`, 이벤트 속성, 외부 통신 요소를 모두 제거하고 `Content-Security-Policy: script-src 'none'`을 설정합니다. 본문 안의 이미지와 동영상 경로는 내려받은 로컬 파일의 상대 경로로 바꾸어 인터넷 연결 없이도 열람할 수 있게 합니다.
