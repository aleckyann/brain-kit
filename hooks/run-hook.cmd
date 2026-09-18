: << 'CMDBLOCK'
@echo off
REM brain-kit hook entry point, Windows half. cmd.exe runs this block; on Unix,
REM bash treats the first line as a no-op heredoc and jumps to the bottom.
REM Usage: run-hook.cmd <event>   (event JSON arrives on stdin)
set "HOOK_DIR=%~dp0"
node "%HOOK_DIR%..\bin\brain-kit.mjs" hook %1
exit /b %ERRORLEVEL%
CMDBLOCK

# brain-kit hook entry point, Unix half. Claude Code runs this file for the
# Stop and SessionStart events with the event JSON on stdin; exec keeps stdin
# attached to the engine and returns its exit code unchanged.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "${SCRIPT_DIR}/../bin/brain-kit.mjs" hook "$1"
