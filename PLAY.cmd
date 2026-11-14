@echo off
rem Sound Architect launcher: serves this folder on http://localhost:8790 and opens the browser.
cd /d "%~dp0"
start "" http://localhost:8790/index.html
python -m http.server 8790
