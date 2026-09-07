# One-command Windows wrapper around build_models3d.py.
# Usage:  powershell -ExecutionPolicy Bypass -File build-models3d.ps1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
    py -3 build_models3d.py --all
    if ($LASTEXITCODE -ne 0) { throw "build_models3d.py failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
