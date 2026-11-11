; 바탕 화면 바로가기를 직접 만듭니다(electron-builder.yml의 createDesktopShortcut: false).
; electron-builder는 바로가기를 만든 다음 앱 ID(AUMID)를 덧써 넣습니다. Parallels가 맥과 같이 쓰는 바탕 화면에서는
; 이 덧쓰기를 거치며 바로가기가 실행 대상이 빈 채로 바뀌어, 아이콘도 없고 눌러도 실행되지 않았습니다.
; 앱 ID는 시작 메뉴 바로가기에만 넣어도 알림과 작업 표시줄 묶음에 충분하므로, 바탕 화면에는 보통의 바로가기만 둡니다.

!define UNCALIVE_DESKTOP_LINK "$DESKTOP\${SHORTCUT_NAME}.lnk"

; 2.0.x까지는 설치 마법사에서 '모든 사용자'를 고를 수 있었습니다. 원클릭 설치는 현재 사용자 계정에만 설치하고
; 그쪽(HKCU)의 이전 버전만 지우므로, 모든 사용자용 이전 설치가 있으면 따로 지우도록 알립니다(나무덤프와 같음).
!macro customInit
  ${IfNot} ${Silent}
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
    ${AndIf} $1 == ""
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "이 컴퓨터에 '모든 사용자'용으로 설치된 이전 언카라이브가 있습니다.$\r$\n$\r$\n새 버전은 현재 사용자 계정에 설치됩니다. 설치가 끝나면 Windows 설정의 '앱'에서 이전 언카라이브를 제거해 주세요. 설정과 로그인 정보, 보관함은 그대로 남습니다." IDOK +2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

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
