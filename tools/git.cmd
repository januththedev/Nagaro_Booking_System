@echo off
rem ---------------------------------------------------------------------------
rem Nagaro booking system - portable git launcher.
rem
rem Resolution order:
rem   1. %NAGARO_GIT% - full path to a git.exe you want to pin explicitly
rem   2. `git` from PATH
rem
rem A previous version hard-coded one developer's machine path, so it failed
rem for everyone else.
rem ---------------------------------------------------------------------------
setlocal
set "GIT_EXE="

if defined NAGARO_GIT if exist "%NAGARO_GIT%" set "GIT_EXE=%NAGARO_GIT%"
if not defined GIT_EXE for %%I in (git.exe) do set "GIT_EXE=%%~$PATH:I"

if not defined GIT_EXE (
  echo [tools\git.cmd] git was not found on PATH. Install Git, or set NAGARO_GIT to a git.exe path. 1>&2
  exit /b 9009
)

"%GIT_EXE%" %*
exit /b %ERRORLEVEL%
