; 바탕 화면 바로가기를 직접 만듭니다(electron-builder.yml의 createDesktopShortcut: false).
; electron-builder는 바로가기를 만든 다음 앱 ID(AUMID)를 덧써 넣습니다. Parallels가 맥과 같이 쓰는 바탕 화면에서는
; 이 덧쓰기를 거치며 바로가기가 실행 대상이 빈 채로 바뀌어, 아이콘도 없고 눌러도 실행되지 않았습니다.
; 앱 ID는 시작 메뉴 바로가기에만 넣어도 알림과 작업 표시줄 묶음에 충분하므로, 바탕 화면에는 보통의 바로가기만 둡니다.

!define UNCALIVE_DESKTOP_LINK "$DESKTOP\${SHORTCUT_NAME}.lnk"

!macro customInstall
  ; 2.0.1과 2.0.2는 바로가기를 영문 이름(Uncalive.lnk)으로 만들고 desktop.ini로 한글 이름을 붙였습니다. 남은 것을 정리합니다.
  Delete "$DESKTOP\Uncalive.lnk"
  Delete "$SMPROGRAMS\Uncalive.lnk"
  DeleteINIStr "$DESKTOP\desktop.ini" "LocalizedFileNames" "Uncalive.lnk"
  DeleteINIStr "$SMPROGRAMS\desktop.ini" "LocalizedFileNames" "Uncalive.lnk"

  ; 새로 설치하면 만들고, 업데이트할 때는 사용자가 지우지 않고 남겨 둔 경우에만 새로 만듭니다.
  ${ifNot} ${isUpdated}
  ${orIf} ${FileExists} "${UNCALIVE_DESKTOP_LINK}"
    Delete "${UNCALIVE_DESKTOP_LINK}"
    CreateShortCut "${UNCALIVE_DESKTOP_LINK}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
  ${endIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; 업데이트 중에는 바탕 화면 바로가기를 그대로 둡니다. 새 버전이 같은 자리에 다시 만듭니다.
  ${ifNot} ${isUpdated}
    Delete "${UNCALIVE_DESKTOP_LINK}"
  ${endIf}
!macroend
