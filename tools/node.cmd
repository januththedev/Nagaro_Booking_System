@echo off
rem ---------------------------------------------------------------------------
rem Nagaro booking system - portable Node launcher.
rem
rem The application requires Node.js 22.5 or newer (it uses the built-in
rem `node:sqlite` module). Resolution order:
rem
rem   1. %NAGARO_NODE% - full path to a node.exe you want to pin explicitly
rem   2. `node` from PATH
rem
rem A previous version of this file hard-coded one developer's machine path
rem (C:\Users\janut\...), so it failed for everyone else. It now resolves the
rem runtime at call time and reports an actionable error instead of a
rem confusing ERR_UNKNOWN_BUILTIN_MODULE.
rem ---------------------------------------------------------------------------
setlocal
set "NODE_EXE="

if defined NAGARO_NODE if exist "%NAGARO_NODE%" set "NODE_EXE=%NAGARO_NODE%"
if not defined NODE_EXE for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"

if not defined NODE_EXE (
  echo [tools\node.cmd] Node.js was not found on PATH. 1>&2
  echo [tools\node.cmd] Install Node.js 22.5+ ^(Node 24 recommended^), or set NAGARO_NODE to a node.exe path. 1>&2
  exit /b 9009
)

"%NODE_EXE%" -e "const [M,m]=process.versions.node.split('.').map(Number);if(M<22||(M===22&&m<5)){console.error('[tools\\node.cmd] Node '+process.versions.node+' is too old; this project needs Node 22.5+ (node:sqlite).');process.exit(1)}"
if errorlevel 1 exit /b 1

"%NODE_EXE%" %*
exit /b %ERRORLEVEL%
