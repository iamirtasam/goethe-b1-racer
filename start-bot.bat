@echo off
title Goethe B1 Racer - LAHORE
cd /d H:\goethe
echo ==========================================================
echo   GOETHE B1 RACER
echo   Target : Lahore (any date)
echo   Opens  : 04.09.2026 at 11:12 Pakistan time
echo   Turbo/ultra : auto-armed from the row itself.
echo.
echo   Keep this window OPEN. Ctrl+C here stops the racer.
echo   Do NOT close the Brave window it opens.
echo ==========================================================
echo.
node racer.js --creds=creds-main.json
echo.
echo Racer exited. The Brave window stays open - check it.
pause
