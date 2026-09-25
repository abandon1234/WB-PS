@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PY="

rem 1) 项目内虚拟环境
if exist "%~dp0.venv\Scripts\python.exe" set "PY=%~dp0.venv\Scripts\python.exe"

rem 2) WorkBuddy 隔离环境
if not defined PY if exist "%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe" set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"

rem 3) 系统 python
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)

if not defined PY (
  echo [错误] 未找到 Python 解释器，请先安装 Python 3.10+
  pause
  exit /b 1
)

echo.
echo   图片文字处理工具
echo   解释器: %PY%
echo   地址  : http://127.0.0.1:8000
echo.

"%PY%" -m app.main --port 8000
pause
