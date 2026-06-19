@echo off
echo Stopping any running Screen Time instances...
taskkill /IM "Screen Time.exe" /F 2>nul
timeout /t 2 /nobreak >nul

echo Building Screen Time...
call npx electron-builder --win --config.directories.output=dist_build
if %ERRORLEVEL% neq 0 (
    echo.
    echo Build failed.
    pause
    exit /b 1
)

echo Copying installer to dist\...
if not exist dist mkdir dist
copy /Y dist_build\ScreenTime-Setup-*.exe dist\ >nul
copy /Y dist_build\ScreenTime-Setup-*.exe.blockmap dist\ >nul
copy /Y dist_build\latest.yml dist\ >nul
rd /s /q dist_build

echo.
echo Done. Installer updated in dist\
pause
