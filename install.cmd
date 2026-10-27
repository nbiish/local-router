@echo off
cd /d "%~dp0"
echo Installing Local Router...
call npm install --prefer-offline
if errorlevel 1 call npm install
if errorlevel 1 exit /b 1
node scripts\setup-platform.mjs
if errorlevel 1 exit /b 1
if not defined CI pause
