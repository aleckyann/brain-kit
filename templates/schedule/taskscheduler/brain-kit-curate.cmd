@echo off
rem Written by brain-kit schedule for the vault {{VAULT_ID}}.
rem Run `brain-kit schedule install` again rather than editing this file.
chcp 65001 >nul
set "PATH={{PATH}}"
set "LC_ALL=C.UTF-8"
{{COMMAND}}
exit /b %ERRORLEVEL%
