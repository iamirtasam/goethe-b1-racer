@echo off
title Goethe B1 Racer

rem ================= EDIT THESE FOR YOUR RACE ==================
rem Login file: create yours from creds.example.json
set CREDS=creds-main.json
rem City to race for. Leave EMPTY to be asked at startup.
set CITY=
rem The exam page (B1 page of the country/institute you want):
set URL=https://www.goethe.de/ins/pk/en/spr/prf/gzb1.cfm
rem UTC offset of that page's advertised opening times (PKT=5, UAE=4, BD=6, TH=7, PH=8, JP=9):
set TZ=5
rem =============================================================

cd /d "%~dp0"
echo ==========================================================
echo   GOETHE B1 RACER
if "%CITY%"=="" set /p CITY=City to race for (e.g. Tokyo):
if "%CITY%"=="" set CITY=Lahore
echo   Target : %CITY%
echo   Page   : %URL%
echo   Opens  : per the page's own advertised times (UTC+%TZ%)
echo   Turbo  : auto-armed from the row itself
echo.
echo   Keep this window OPEN. Ctrl+C here stops the racer.
echo   Do NOT close the Brave window it opens.
echo ==========================================================
echo.
node racer.js --city="%CITY%" --url="%URL%" --tz=%TZ% --creds=%CREDS%
echo.
echo Racer exited. The Brave window stays open - check it.
pause
