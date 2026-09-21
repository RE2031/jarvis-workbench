@echo off
REM Camera access needs http://localhost (a secure context), not file://
cd /d "%~dp0"
start "" http://localhost:8000
python -m http.server 8000
