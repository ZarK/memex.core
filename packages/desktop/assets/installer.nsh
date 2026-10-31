; The NSIS hooks of a Memex app that carries the shared services (Memex.Node, Memex.User) in resources\services.
; memex-desktop pack includes this file when the app has services.json.
;
; Install: the app's own program copies the services into the per-user services folder
; (%LOCALAPPDATA%\Programs\Memex\Services, or MEMEX_SERVICES_DIR) and lists the app as a client. A failure does not
; stop the install: every start of the app installs them again.
;
; Uninstall: the app is no longer a client; when it was the last one, the services are drained and removed. Only the
; services folder is touched, never ~/Memex or the pack store. An update runs the old uninstaller with --updated: then
; the services stay, and the new installer adds its versions.

!macro customInstall
  DetailPrint "Installing the shared Memex services..."
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --memex-services=install' $0
  ${if} $0 != 0
    DetailPrint "The shared Memex services were not installed (exit code $0); the app installs them at its next start."
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing this app from the shared Memex services..."
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --memex-services=uninstall' $0
    ${if} $0 != 0
      DetailPrint "The shared Memex services could not be updated (exit code $0)."
    ${endIf}
  ${endIf}
!macroend
