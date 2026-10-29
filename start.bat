@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

title API Test Platform

rem ---------------- locate python ----------------
set "PY="
if exist "C:\Users\zhouli\.workbuddy\binaries\python\envs\default\Scripts\python.exe" (
  set "PY=C:\Users\zhouli\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
)
if not defined PY if exist "C:\Users\zhouli\.workbuddy\binaries\python\versions\3.13.12\python.exe" (
  set "PY=C:\Users\zhouli\.workbuddy\binaries\python\versions\3.13.12\python.exe"
)
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo [ERROR] Python not found. Please install Python 3.8+ and retry.
  pause
  exit /b 1
)

rem ---------------- port ----------------
set "PORT=8788"
if not "%~1"=="" set "PORT=%~1"

rem ---------------- case dir (optional override) ----------------
if not defined APIFOX_CASE_DIR set "APIFOX_CASE_DIR=C:\Users\zhouli\Downloads\apifox_case"

echo ==============================================================
echo   API Test Platform  (FastAPI + Apifox cases)
echo --------------------------------------------------------------
echo   Python    : %PY%
echo   Case dir  : %APIFOX_CASE_DIR%
echo   URL       : http://127.0.0.1:%PORT%
echo   API docs  : http://127.0.0.1:%PORT%/docs
echo   Stop      : press Ctrl+C in this window
echo ==============================================================
echo.

rem open browser after a short delay
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:%PORT%"

rem 后端已迁移到 FastAPI（app/ 包），server.py 仅作兼容启动壳
"%PY%" main.py %PORT%

echo.
echo Server stopped.
pause
