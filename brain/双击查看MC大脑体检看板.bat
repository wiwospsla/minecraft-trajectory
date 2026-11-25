@echo off
chcp 65001 >nul
rem Double-click entry: runs the Chinese brain status report (brain/status_report.mjs).
rem Read-only: no Minecraft server connection, no LLM calls, no network.
cd /d "%~dp0.."
echo ======================================
echo  正在运行：node brain/status_report.mjs
echo ======================================
echo.
node brain\status_report.mjs
echo.
echo ======================================
echo  看完了吗？按任意键关闭这个窗口。
echo ======================================
pause >nul
