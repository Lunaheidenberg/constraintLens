@echo off
title ConstraintLens Dev Launcher
chcp 65001 >nul

echo ===================================================
echo   ConstraintLens - AI Kanban Flow Simulator
echo   Khoi dong Backend va Frontend song song...
echo ===================================================

:: Dam bao duong dan Node.js va uv duoc nap day du
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.20.0-win-x64;%USERPROFILE%\.local\bin;%PATH%"

cd /d "%~dp0"

echo [1/2] Dang mo tien trinh Backend (FastAPI - Port 8000)...
start "ConstraintLens - Backend" cmd /k "cd /d "%~dp0" && title ConstraintLens - Backend && echo [Backend] Khoi chay Uvicorn... && uv run uvicorn api:app --reload --port 8000"

echo [2/2] Dang mo tien trinh Frontend (Vite - Port 5173)...
start "ConstraintLens - Frontend" cmd /k "cd /d "%~dp0frontend" && title ConstraintLens - Frontend && echo [Frontend] Khoi chay Vite Dev Server... && npm run dev"

echo.
echo ===================================================
echo   Ca 2 tien trinh da duoc mo trong 2 cua so rieng biet!
echo   - Backend API : http://localhost:8000
echo   - Swagger API : http://localhost:8000/docs
echo   - Frontend UI : http://localhost:5173
echo ===================================================
echo.
pause

