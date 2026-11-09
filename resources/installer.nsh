; 바로가기 파일은 영문 이름(Uncalive.lnk)으로 만들고, 보이는 이름만 한글로 둡니다.
; Windows는 폴더의 desktop.ini [LocalizedFileNames]에 적힌 이름을 파일 이름 대신 보여 줍니다.
; 맥에서 번들 이름은 영문으로 두고 InfoPlist.strings로 한글 이름을 보여 주는 것과 같은 방식입니다.

!define UNCALIVE_DISPLAY_NAME "언카라이브"

; desktop.ini가 없으면 UTF-16 파일로 새로 만듭니다. 그래야 한글이 깨지지 않고 써집니다.
!macro uncaliveSetDisplayName FOLDER
  ${ifNot} ${FileExists} "${FOLDER}\desktop.ini"
    FileOpen $0 "${FOLDER}\desktop.ini" w
    FileWriteWord $0 0xFEFF
    FileClose $0
    SetFileAttributes "${FOLDER}\desktop.ini" HIDDEN|SYSTEM
  ${endIf}
  WriteINIStr "${FOLDER}\desktop.ini" "LocalizedFileNames" "${SHORTCUT_NAME}.lnk" "${UNCALIVE_DISPLAY_NAME}"
!macroend

!macro customInstall
  ; 예전 설치 파일이 남긴, 실행되지 않는 한글 이름 바로가기를 지웁니다.
  Delete "$DESKTOP\${UNCALIVE_DISPLAY_NAME}.lnk"
  Delete "$SMPROGRAMS\${UNCALIVE_DISPLAY_NAME}.lnk"
  !insertmacro uncaliveSetDisplayName "$DESKTOP"
  !insertmacro uncaliveSetDisplayName "$SMPROGRAMS"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteINIStr "$DESKTOP\desktop.ini" "LocalizedFileNames" "${SHORTCUT_NAME}.lnk"
  DeleteINIStr "$SMPROGRAMS\desktop.ini" "LocalizedFileNames" "${SHORTCUT_NAME}.lnk"
!macroend
