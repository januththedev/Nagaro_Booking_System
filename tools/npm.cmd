@echo off
rem ---------------------------------------------------------------------------
rem Nagaro booking system - portable npm launcher.
rem
rem Uses %NAGARO_NODE% (if set) to locate the matching npm, otherwise falls
rem back to `npm` on PATH. See tools\node.cmd for the Node version policy.
rem ---------------------------------------------------------------------------
setlocal
if defined NAGARO_NODE (
  for %%I in ("%NAGARO_NODE%") do set "PATH=%%~dpI;%PATH%"
)
call npm.cmd %*
exit /b %ERRORLEVEL%
