@echo off
chcp 65001 >nul
cd /d "%~dp0app"
node app.js settings
if errorlevel 1 pause
