@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.12 或更新的 LTS 版本，然后重新运行此脚本。
  pause
  exit /b 1
)
call npm ci
if errorlevel 1 goto failed
call npm run pack:win-x64
if errorlevel 1 goto failed
echo 构建完成，压缩包位于 dist 目录。
pause
exit /b 0
:failed
echo 构建失败，请保留上方的错误信息以便排查。
pause
exit /b 1
