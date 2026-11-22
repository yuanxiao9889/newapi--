@echo off
setlocal
pushd "%~dp0" || exit /b 1
if not exist "node_modules\.bin\electron.cmd" (
    call npm.cmd ci
    if errorlevel 1 goto failed
)
call npm.cmd start
if errorlevel 1 goto failed
popd
exit /b 0

:failed
set "launch_error=%errorlevel%"
popd
if /i not "%~1"=="--no-pause" pause
exit /b %launch_error%
