#!/bin/zsh
# 개발용 앱을 App/build/Uncalive Dev.app에 빌드합니다.
# 로그인, 설정, 보관함(~/Uncalive Dev)을 설치본과 공유하지 않습니다.
set -euo pipefail
cd "${0:a:h}/.."

xcodebuild \
  -project Uncalive.xcodeproj \
  -scheme Uncalive \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath build/DerivedData \
  build

rm -rf "build/Uncalive Dev.app"
cp -R "build/DerivedData/Build/Products/Debug/Uncalive Dev.app" "build/Uncalive Dev.app"
echo "빌드 완료: $PWD/build/Uncalive Dev.app"
