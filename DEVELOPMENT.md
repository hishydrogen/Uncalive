# 언카라이브 개발 안내

언카라이브를 고치거나 직접 빌드하려는 분을 위한 문서입니다. 쓰는 법은 [README](README.md)를 보세요.

## 구조

언카라이브는 Electron 앱 하나로 macOS, Windows, Linux를 모두 지원합니다. 아카라이브를 읽고 파일을 받는 엔진(`src/core`)은 Electron에 기대지 않는 순수 TypeScript라서 Node.js만으로 시험할 수 있습니다.

```
src/
  core/                          엔진. Electron 없이 Node.js에서 돕니다
    parser.ts                    아카라이브 HTML 파서(cheerio 사용). 사이트 구조는 이 파일만 압니다
    targets.ts                   붙여 넣은 주소 판별. 화면에서도 쓰므로 Node 기능을 쓰지 않습니다
    engine.ts                    목록 수집, 게시글 미리 읽기, 다운로드 흐름 제어
    downloader.ts                화질 선택, ETag 비교, 조각 다운로드, 파일 형식 판별, 재시도
    limiter.ts, control.ts       동시 연결 제한기, 일시정지와 취소
    archiver.ts                  오프라인 페이지(index.html)와 글 정보(post.json)
    resume.ts                    진행 기록(.uncalive/state.json)과 폴더 예약
    library.ts                   보관함 색인(.uncalive/text/), 본문 검색, CSV
    queue.ts                     다운로드 대기열
    naming.ts                    파일과 폴더 이름 정리(Windows 예약 이름 포함)
    migration.ts                 1.x 맥판(Swift) 설정 읽기
  main/                          Electron 메인 프로세스
    main.ts                      앱 수명, 창, 메뉴, 알림 영역, 보관함 파일 프로토콜, 종료 확인
    model.ts                     앱 전체 상태. 화면에서 오는 명령을 처리하고 바뀐 부분만 화면에 보냅니다
    browser.ts                   로그인과 Cloudflare 확인, 페이지 읽기에 쓰는 숨긴 브라우저 창
    settings.ts, migrate.ts      설정 저장, 1.x 맥판 설정 가져오기
  preload/preload.ts             화면과 메인 프로세스를 잇는 통로(상태 받기와 명령 보내기만 엽니다)
  renderer/                      React로 만든 화면
  shared/types.ts                메인 프로세스와 화면이 함께 쓰는 상태와 명령의 형식
test/                            엔진 단위 시험과 HTML 픽스처
scripts/
  build-main.mjs                 메인 프로세스와 프리로드를 한 파일로 묶기
  dev.mjs                        개발용 실행
  smoke.mjs                      빌드한 앱을 실제로 띄워 화면을 한 바퀴 확인
  icon-shapes.mjs                아이콘 도형과 색(모든 아이콘의 원본)
  make-icons.mjs                 icon-shapes.mjs에서 운영체제별 아이콘 그림 만들기
resources/                       아이콘(맥은 AppIcon.icon, Windows·Linux는 icon.png)
electron-builder.yml             설치 파일 설정
```

## 실행과 시험

Node.js 22 이상이 필요합니다.

```bash
npm ci                           # 처음 한 번 의존성 설치
npm test                         # 엔진 단위 시험
npm run typecheck                # 타입 검사
npm run dev                      # 개발용 앱 실행(화면 코드를 고치면 바로 반영)
npm run build && node scripts/smoke.mjs   # 빌드한 앱을 띄워 화면 확인
```

설치 파일은 `dist/`에 만들어집니다. 맥에서는 세 운영체제의 설치 파일을 모두 만들 수 있습니다.

```bash
npm run build
npx electron-builder --mac --arm64
npx electron-builder --win --x64 --arm64
npx electron-builder --linux --x64 --arm64
```

- **개발본과 설치본 분리**: 개발본은 앱 이름이 `Uncalive Dev`, 설정 폴더가 `Uncalive Electron Dev`, 기본 보관함이 `~/Uncalive Dev`입니다. 설치본은 설정 폴더가 `Uncalive`(Windows는 `%APPDATA%\Uncalive`, 맥은 `~/Library/Application Support/Uncalive`), 기본 보관함이 홈 폴더의 `Uncalive`입니다.
- **시험용 격리**: `UNCALIVE_PROFILE_DIR`(설정과 로그인 세션 폴더)와 `UNCALIVE_DEFAULT_FOLDER`(기본 보관함, 절대 경로) 환경 변수를 주면 실사용 데이터와 완전히 떨어진 곳에서 실행합니다. 이때는 1.x 맥판 설정도 가져오지 않습니다. `scripts/smoke.mjs`가 이렇게 실행합니다.
- **개발 로그**: 개발본으로 실행할 때만 운영체제의 로그 폴더(`Uncalive Dev/debug.log`)에 진행 상태를 남깁니다. 쿠키 값이나 입력값, 글 제목은 기록하지 않으며 설치본은 아무것도 남기지 않습니다.
- **아이콘 바꾸기**: `scripts/icon-shapes.mjs`의 도형과 색을 고친 뒤 `npx electron scripts/make-icons.mjs`를 실행하면 맥 리퀴드 글래스 아이콘의 층 그림(`resources/AppIcon.icon/Assets`), `resources/icon.svg`·`icon.png`(Windows, Linux), `docs/icon.png`(README)를 다시 만듭니다. 리퀴드 글래스의 색, 유리, 굴절 설정은 `resources/AppIcon.icon/icon.json`에 있고 Xcode의 Icon Composer로 열어 볼 수 있습니다. 명령줄로 미리 보려면 `"/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool" resources/AppIcon.icon --export-image --output-file preview.png --platform macOS --rendition Default --width 1024 --height 1024 --scale 1 --design-generation 27`을 실행합니다(`--rendition`은 Dark, ClearLight, TintedDark 등).

## 릴리스

1. `package.json`의 `version`을 올리고 [CHANGELOG](CHANGELOG.md)에 적습니다.
2. `v<버전>` 태그를 올리면 GitHub Actions(`release.yml`)가 세 운영체제의 설치 파일을 만들어 같은 이름의 릴리스 초안에 붙입니다.
3. 초안의 노트와 파일을 확인한 뒤 공개합니다.

`ci.yml`은 푸시마다 macOS, Windows(x64, ARM), Linux(x64, ARM) 서버에서 시험과 빌드를 하고 앱을 실제로 띄워 봅니다.

## 설계 특징

- **사이트 구조 분리**: 아카라이브의 HTML 선택자는 `src/core/parser.ts` 한 곳에만 있습니다. 사이트 구조가 바뀌면 이 파일과 `test/fixtures`의 픽스처를 함께 고칩니다.
- **브라우저와 다운로더 분리**: 로그인과 Cloudflare 확인이 필요한 페이지 읽기는 숨긴 브라우저 창(`browser.ts`)이 맡고, 미디어 파일은 쿠키 없이 Node.js의 `fetch`(`downloader.ts`)로 받습니다. 앞선 글의 미디어를 받는 동안 다음 글을 최대 3개까지 미리 읽습니다.
- **원본 서버 제한 준수**: 아카라이브 원본 이미지 서버(`ac-o.arca.live`)는 IP당 동시 연결이 2개를 넘으면 `HTTP 429`를 반환합니다. 원본 서버 연결은 항상 2개로 제한하고, CDN(`ac.arca.live`) 파일과 원본의 `ETag`가 같으면 빠른 CDN에서 받습니다. 2MB 이상인 원본은 1MB 조각(`Range`)으로 나누어 받습니다.
- **안전한 파일 저장과 이어받기**: 받는 파일은 임시 파일과 `.part`를 거쳐 끝까지 받은 뒤에만 최종 이름을 얻습니다. 완료된 파일은 `.uncalive/state.json`에 기록되어 다시 실행할 때 재사용합니다. 원본을 원했는데 표시용만 받은 경우에는 완료로 표시하지 않아 다음 실행 때 원본을 다시 시도합니다.
- **보관함 형식 유지**: `state.json`, `collection.json`, `.uncalive/text/`의 형식은 1.x 맥판과 같습니다. 날짜는 소수점 없는 ISO 8601로 씁니다. 1.x 맥판으로 받은 보관함을 그대로 읽습니다.
- **오프라인 페이지 재작성**: 본문과 댓글 HTML에서 `<script>`, `<style>`, 이벤트 속성, 외부 통신 요소를 모두 지우고 `Content-Security-Policy: script-src 'none'`을 넣습니다. 미디어 경로는 내려받은 파일의 상대 경로로 바꿉니다.
- **화면 보안**: 화면은 샌드박스와 컨텍스트 격리 안에서 돌고, 미리 정한 명령만 메인 프로세스에 보낼 수 있습니다. 보관함 파일은 `uncalive-media:` 프로토콜로 보관함 폴더 안의 파일만 보여 줍니다.
- **맥의 앱 이름**: 맥에서 Electron은 번들 이름(`CFBundleName`)이 한글이면 시작하자마자 멈춥니다. 그래서 파일과 번들 이름은 `Uncalive`로 두고, Finder와 Launchpad, Dock, 메뉴 막대에 보이는 '언카라이브'는 언어별 이름 파일(`resources/mac/InfoPlist.strings`)의 `CFBundleDisplayName`과 `CFBundleName`으로 붙입니다. 언어별 파일의 한글 이름은 Electron이 쓰지 않으므로 멈추지 않습니다. 이때 Info.plist의 기본 `CFBundleDisplayName`은 파일 이름과 같은 `Uncalive`여야 합니다. 다르면 macOS가 사용자가 이름을 바꾼 앱으로 보고 파일 이름을 보여 줍니다.
