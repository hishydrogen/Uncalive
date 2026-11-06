#!/bin/zsh
# 릴리스 빌드를 만들어 /Applications/언카라이브.app에 설치합니다. 인자가 있으면 그 경로에 설치합니다.
set -euo pipefail
cd "${0:a:h}/.."

TARGET="${1:-/Applications/언카라이브.app}"

xcodebuild \
  -project Uncalive.xcodeproj \
  -scheme Uncalive \
  -configuration Release \
  -destination 'platform=macOS' \
  -derivedDataPath build/DerivedData \
  build

SOURCE="build/DerivedData/Build/Products/Release/언카라이브.app"
codesign --verify --strict "$SOURCE"

# 설치본이 실행 중이면 정상 종료를 요청합니다. 다운로드 중이면 앱이 확인을 받습니다.
if pgrep -f '^/Applications/언카라이브.app/' >/dev/null; then
  osascript -e 'tell application id "io.github.hishydrogen.uncalive" to quit' || true
  sleep 2
fi
if pgrep -f '^/Applications/언카라이브.app/' >/dev/null; then
  echo "설치본이 아직 실행 중입니다. 종료한 뒤 다시 실행하세요." >&2
  exit 1
fi

rm -rf "$TARGET"
ditto "$SOURCE" "$TARGET"
echo "설치 완료: $TARGET"
