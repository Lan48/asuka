@echo off
setlocal
title Asuka Settings UI

set ASUKA_ROOT=D:\app\asuka
set ASUKA_PROJECT=%ASUKA_ROOT%\project
set SETTINGS_UI_DIR=%ASUKA_PROJECT%\settings-ui
set LOG_DIR=%ASUKA_ROOT%\logs
set OUT_LOG=%LOG_DIR%\settings-ui.out.log
set ERR_LOG=%LOG_DIR%\settings-ui.err.log
set NODE_EXE=C:\Program Files\nodejs\node.exe
set NPM_CMD=C:\Program Files\nodejs\npm.cmd

set HOME=%ASUKA_ROOT%\home
set USERPROFILE=%ASUKA_ROOT%\home
set OPENCLAW_CONFIG_PATH=%ASUKA_ROOT%\home\.openclaw\openclaw.json
set OPENCLAW_STATE_DIR=%ASUKA_ROOT%\home\.openclaw
set SETTINGS_UI_PROJECT_ROOT=%ASUKA_PROJECT%
set SETTINGS_UI_HOST=127.0.0.1
set SETTINGS_UI_WEB_PORT=5175
set SETTINGS_UI_API_PORT=18766
set NODE_PATH=%ASUKA_ROOT%\tools\node_modules;%ASUKA_PROJECT%\extensions\qqbot\node_modules

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
echo.>> "%OUT_LOG%"
echo [%date% %time%] launcher started >> "%OUT_LOG%"

if not exist "%SETTINGS_UI_DIR%\package.json" (
  echo [Asuka Settings] settings-ui not found: %SETTINGS_UI_DIR%
  echo [%date% %time%] settings-ui not found: %SETTINGS_UI_DIR% >> "%ERR_LOG%"
  pause
  exit /b 1
)

if not exist "%NODE_EXE%" (
  echo [Asuka Settings] Node.js not found: %NODE_EXE%
  echo [%date% %time%] Node.js not found: %NODE_EXE% >> "%ERR_LOG%"
  pause
  exit /b 1
)

if not exist "%NPM_CMD%" (
  echo [Asuka Settings] npm not found: %NPM_CMD%
  echo [%date% %time%] npm not found: %NPM_CMD% >> "%ERR_LOG%"
  pause
  exit /b 1
)

cd /d "%SETTINGS_UI_DIR%"

if not exist node_modules (
  echo [Asuka Settings] installing dependencies...
  echo [%date% %time%] npm install >> "%OUT_LOG%"
  call "%NPM_CMD%" install >> "%OUT_LOG%" 2>> "%ERR_LOG%"
  if errorlevel 1 (
    echo [Asuka Settings] npm install failed.
    echo [%date% %time%] npm install failed >> "%ERR_LOG%"
    pause
    exit /b 1
  )
)

echo [Asuka Settings] config: %OPENCLAW_CONFIG_PATH%
echo [Asuka Settings] workspace: %OPENCLAW_STATE_DIR%\workspace
echo [Asuka Settings] UI: http://127.0.0.1:%SETTINGS_UI_WEB_PORT%/

netstat -ano | findstr ":%SETTINGS_UI_WEB_PORT% " >nul
if errorlevel 1 (
  echo [%date% %time%] starting npm run dev >> "%OUT_LOG%"
  start "Asuka Settings UI Server" /min cmd /c ""%NPM_CMD%" run dev >> "%OUT_LOG%" 2>> "%ERR_LOG%""
) else (
  echo [%date% %time%] settings-ui already listening on %SETTINGS_UI_WEB_PORT% >> "%OUT_LOG%"
)

echo [Asuka Settings] waiting for server...
for /l %%i in (1,1,45) do (
  "%NODE_EXE%" -e "fetch('http://127.0.0.1:%SETTINGS_UI_WEB_PORT%/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>nul
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)

echo [Asuka Settings] server did not become ready. Check:
echo   %OUT_LOG%
echo   %ERR_LOG%
echo [%date% %time%] server readiness timeout >> "%ERR_LOG%"
pause
exit /b 1

:ready
echo [%date% %time%] server ready >> "%OUT_LOG%"
start "" "http://127.0.0.1:%SETTINGS_UI_WEB_PORT%/"

echo [Asuka Settings] opened browser. Logs:
echo   %OUT_LOG%
echo   %ERR_LOG%
timeout /t 3 /nobreak >nul
