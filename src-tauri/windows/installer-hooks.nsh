; Hooks into Tauri's NSIS installer (tauri.windows.conf.json → installerHooks).
;
; Written against the installer.nsi template of the Tauri CLI 2.12. The
; variables used here ($AppStartMenuFolder, $UpdateMode, $NoShortcutMode,
; $DeleteAppDataCheckboxState) are the template's own; they are declared
; after this file is included, which is fine because macros are expanded
; only where they are inserted.
;
; Start menu: Tauri puts the program's entry into the folder
; "CronoStream" (startMenuFolder). The hooks add the two others the Linux
; AppImage offers as well (desktop_integration.rs): the drop box entry
; ("CronoStream Ablage"), which opens only the drop box as a circle, and the
; uninstall entry ("CronoStream deinstallieren"), which opens the app's own
; uninstall dialog (uninstall.rs). That dialog deletes the chosen streams
; and then starts this uninstaller with /P /WIPEALL.
;
; Uninstall: Tauri's uninstaller removes the program, its start menu entry,
; and with its checkbox "Delete the application data" the folders
; %APPDATA%\com.felixheck.cronostream and %LOCALAPPDATA%\com.felixheck.cronostream
; (WebView2 data included). It also removes a Run value named after the
; product, but the drop box's is "CronoStream Ablage". The hooks remove
; that value, the two extra entries and, along with the checkbox, the
; folders the template doesn't know of.
;
; The app switches all of these on and off in its settings like the Linux
; entries (windows_links.rs): a shortcut switched off waits in the app's
; local data folder, which the checkbox removes with the rest.
;
; Languages: the installer follows the Windows language (German, English or
; Spanish, see tauri.windows.conf.json → languages), and so do the names of
; the two extra entries, like the Name[en]/Name[es] lines of the Linux
; entries. A .lnk name can't carry translations, so the name is picked once,
; at install time. LangString can't be used for it: this file is included
; before the template loads its languages, so ${LANG_GERMAN} isn't defined
; yet. $LANGUAGE is compared with the language ids instead.

Var CronoStreamDropboxLink
Var CronoStreamUninstallLink

!macro CRONOSTREAM_LINK_NAMES
  ${If} $LANGUAGE = 1031
    StrCpy $CronoStreamDropboxLink "CronoStream Ablage"
    StrCpy $CronoStreamUninstallLink "CronoStream deinstallieren"
  ${ElseIf} $LANGUAGE = 1034
  ${OrIf} $LANGUAGE = 3082
    StrCpy $CronoStreamDropboxLink "CronoStream Bandeja"
    StrCpy $CronoStreamUninstallLink "Desinstalar CronoStream"
  ${Else}
    StrCpy $CronoStreamDropboxLink "CronoStream Drop Box"
    StrCpy $CronoStreamUninstallLink "Uninstall CronoStream"
  ${EndIf}
!macroend

; Every name the two entries can have, whatever language they were made in.
!macro CRONOSTREAM_DELETE_LINKS DIR
  Delete "${DIR}\CronoStream Ablage.lnk"
  Delete "${DIR}\CronoStream deinstallieren.lnk"
  Delete "${DIR}\CronoStream Drop Box.lnk"
  Delete "${DIR}\Uninstall CronoStream.lnk"
  Delete "${DIR}\CronoStream Bandeja.lnk"
  Delete "${DIR}\Desinstalar CronoStream.lnk"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  ; Where versions before the start menu folder put the drop box entry.
  Delete "$SMPROGRAMS\CronoStream Ablage.lnk"
  ${If} $AppStartMenuFolder == ""
    StrCpy $AppStartMenuFolder "${STARTMENUFOLDER}"
  ${EndIf}
  ; A leading ">" is the start menu page's "Do not create shortcuts".
  StrCpy $0 $AppStartMenuFolder 1
  ; The folder, for the app's start menu switches (windows_links.rs), in
  ; the uninstall key, which goes with the program.
  ${If} $0 == ">"
    StrCpy $1 $AppStartMenuFolder "" 1
  ${Else}
    StrCpy $1 $AppStartMenuFolder
  ${EndIf}
  WriteRegStr SHCTX "${UNINSTKEY}" "CronoStreamStartMenuFolder" $1
  ${If} $0 != ">"
  ${AndIf} $NoShortcutMode <> 1
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    ; A reinstall in another language would leave the old names beside the
    ; new ones.
    !insertmacro CRONOSTREAM_DELETE_LINKS "$SMPROGRAMS\$AppStartMenuFolder"
    !insertmacro CRONOSTREAM_LINK_NAMES
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\$CronoStreamDropboxLink.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "--ablage" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\$CronoStreamUninstallLink.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "--deinstallieren" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  ${EndIf}
  Pop $1
  Pop $0
!macroend

; /WIPEALL comes from the app's uninstall dialog, where everything was
; already confirmed; it stands for the checkbox the passive uninstaller
; doesn't show. Read here, at the start of the uninstall section, because
; the confirmation page sets the checkbox state before that.
!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  ClearErrors
  ${GetOptions} $CMDLINE "/WIPEALL" $0
  ${IfNot} ${Errors}
    StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; An update runs the old uninstaller too, and keeps entries and settings.
  ${If} $UpdateMode <> 1
    ; $AppStartMenuFolder was read by the template's uninstall section. Its
    ; own entry and the attempt to remove the then still full folder come
    ; before this hook.
    ${If} $AppStartMenuFolder != ""
      !insertmacro CRONOSTREAM_DELETE_LINKS "$SMPROGRAMS\$AppStartMenuFolder"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    Delete "$SMPROGRAMS\CronoStream Ablage.lnk"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CronoStream Ablage"
  ${EndIf}
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    ; Preview and playback caches (dirs::cache_dir() is %LOCALAPPDATA%).
    RMDir /r "$LOCALAPPDATA\cronostream"
    ; Recordings not yet taken into a stream.
    RMDir /r "$TEMP\cronostream-recordings"
    ; Left over under the former name, LifeStream.
    RMDir /r "$APPDATA\com.felixheck.lifestream"
    RMDir /r "$LOCALAPPDATA\com.felixheck.lifestream"
    RMDir /r "$LOCALAPPDATA\lifestream"
  ${EndIf}
!macroend
