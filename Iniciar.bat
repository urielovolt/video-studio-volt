@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Video Studio Volt
if not exist ".venv\Scripts\python.exe" (
  echo Falta instalar. Primero haz doble clic en Instalar.bat
  echo.
  pause
  exit /b 1
)
echo Abriendo Video Studio Volt en el navegador...
echo Deja esta ventana abierta mientras usas la app. Para cerrarla: Ctrl+C o cierra la ventana.
echo.
".venv\Scripts\python.exe" herramienta\servir.py
pause
