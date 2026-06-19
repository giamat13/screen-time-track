@echo off
setlocal

echo [1/4] Stopping any running Screen Time instances...
taskkill /IM "Screen Time.exe" /F 2>nul
timeout /t 2 /nobreak >nul

echo [2/4] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

echo [3/4] Building installer...
set ELECTRON_RUN_AS_NODE=
rd /s /q dist_build 2>nul
call npx electron-builder --win --config.directories.output=dist_build
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Build failed.
    pause
    exit /b 1
)

echo [4/4] Moving installer to dist\...
if not exist dist mkdir dist
copy /Y "dist_build\ScreenTime-Setup-*.exe" dist\ >nul
rd /s /q dist_build 2>nul

echo.
echo Done. Installer is in dist\
echo.
pause
