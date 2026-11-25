@echo off
chcp 65001 >nul
rem Double-click entry: runs the 5-episode offline learning-curve demo (brain/multi_episode_eval.mjs).
rem Pure offline deterministic simulation: no Minecraft server, no LLM calls, no tokens spent.
cd /d "%~dp0.."
echo ======================================
echo  正在运行：node brain/multi_episode_eval.mjs
echo  （5 局离线学习曲线演示，0 LLM、0 真实服务器依赖，几秒内跑完）
echo ======================================
echo.
node brain\multi_episode_eval.mjs
echo.
echo ======================================
echo  看完了吗？按任意键关闭这个窗口。
echo ======================================
pause >nul
