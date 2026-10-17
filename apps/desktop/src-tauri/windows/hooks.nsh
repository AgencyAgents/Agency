; $LOCALAPPDATA\Agency is the daemon's data folder: a new install goes beside other per-user apps.
; Template defines come after this include, so the product name is spelled out.
!define MUI_CUSTOMFUNCTION_GUIINIT AgencyInstallDir
Function AgencyInstallDir
  StrCmp $INSTDIR "$LOCALAPPDATA\Agency" 0 done
  IfFileExists "$INSTDIR\uninstall.exe" done
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Agency"
  done:
FunctionEnd
