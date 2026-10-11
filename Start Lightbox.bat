@echo off
rem FO4 Lightbox - starts the local viewer server and opens it in your browser.
rem The release zip brings its own Python in runtime\ (nothing to install). Without that folder it uses your
rem Python 3.10+ with numpy. Pass --game "D:\Games\Fallout 4" if your install is not found automatically.
cd /d "%~dp0"
set PY=python
where py >nul 2>nul && set PY=py -3
if exist "runtime\python.exe" set PY="runtime\python.exe"
%PY% -c "import numpy" 2>nul || (
  echo FO4 Lightbox needs Python 3.10 or newer with numpy, or the runtime folder of the release zip.
  echo With Python installed, add numpy once with:  py -3 -m pip install numpy
  pause
  exit /b 1
)
%PY% server\app.py %*
pause
