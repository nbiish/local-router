@echo off
cd /d "%~dp0"
echo Installing Local Router...
call npm install
node scripts\setup-platform.mjs
pause
