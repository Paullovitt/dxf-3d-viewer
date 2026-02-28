param(
    [string]$OutputDir = "release-portable",
    [switch]$SkipCuda
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host "[build-portable] $msg"
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path $projectRoot).Path
$outputRoot = Join-Path $projectRoot $OutputDir

$pythonExe = (Get-Command py -ErrorAction Stop).Source
$pythonRoot = & $pythonExe -3.9 -c "import sys; print(sys.base_prefix)"
if (-not (Test-Path $pythonRoot)) {
    throw "Python 3.9 nao encontrado para empacotamento."
}

$cudaRoot = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.0"
$hasCudaToolkit = (Test-Path (Join-Path $cudaRoot "bin\nvrtc64_120_0.dll"))

if (Test-Path $outputRoot) {
    Write-Step "Limpando pasta antiga: $outputRoot"
    Remove-Item -Recurse -Force $outputRoot
}

Write-Step "Criando estrutura de release em: $outputRoot"
New-Item -ItemType Directory -Path $outputRoot | Out-Null
New-Item -ItemType Directory -Path (Join-Path $outputRoot "backend") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $outputRoot "frontend") | Out-Null

Write-Step "Copiando projeto"
Copy-Item -Path (Join-Path $projectRoot "backend\*") -Destination (Join-Path $outputRoot "backend") -Recurse -Force
Copy-Item -Path (Join-Path $projectRoot "frontend\*") -Destination (Join-Path $outputRoot "frontend") -Recurse -Force
Copy-Item -Path (Join-Path $projectRoot "run_cef.py") -Destination $outputRoot -Force
Copy-Item -Path (Join-Path $projectRoot "run_server.py") -Destination $outputRoot -Force
Copy-Item -Path (Join-Path $projectRoot "requirements.txt") -Destination $outputRoot -Force
Copy-Item -Path (Join-Path $projectRoot "README.md") -Destination $outputRoot -Force
if (Test-Path (Join-Path $projectRoot ".cache")) {
    New-Item -ItemType Directory -Path (Join-Path $outputRoot ".cache\parsed") -Force | Out-Null
}

Write-Step "Copiando runtime Python 3.9: $pythonRoot"
$pythonDest = Join-Path $outputRoot "python"
New-Item -ItemType Directory -Path $pythonDest -Force | Out-Null

# Robocopy e mais estavel para arvores grandes (Python completo).
$null = robocopy $pythonRoot $pythonDest /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) {
    throw "Falha ao copiar runtime Python (robocopy exit code: $LASTEXITCODE)."
}

# Reduz um pouco o tamanho removendo cache transitario.
Get-ChildItem -Path (Join-Path $outputRoot "python") -Recurse -Filter "__pycache__" -Directory -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path (Join-Path $outputRoot "python") -Recurse -Filter "*.pyc" -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

if (-not $SkipCuda) {
    if ($hasCudaToolkit) {
        Write-Step "Copiando CUDA Toolkit runtime (v12.0 bin/libnvvp)"
        New-Item -ItemType Directory -Path (Join-Path $outputRoot "cuda\v12.0") -Force | Out-Null
        Copy-Item -Path (Join-Path $cudaRoot "bin") -Destination (Join-Path $outputRoot "cuda\v12.0") -Recurse -Force
        if (Test-Path (Join-Path $cudaRoot "libnvvp")) {
            Copy-Item -Path (Join-Path $cudaRoot "libnvvp") -Destination (Join-Path $outputRoot "cuda\v12.0") -Recurse -Force
        }
    } else {
        Write-Step "CUDA Toolkit local nao encontrado. O pacote portatil vai abrir em modo CPU."
    }
} else {
    Write-Step "SkipCuda ativo: pacote sem pasta CUDA."
}

$startPortableBat = @'
@echo off
setlocal
cd /d %~dp0

set "ROOT=%~dp0"
set "PY_HOME=%ROOT%python"
set "CUDA_HOME=%ROOT%cuda\v12.0"

if exist "%CUDA_HOME%\bin\nvrtc64_120_0.dll" (
  set "CUDA_PATH=%CUDA_HOME%"
  set "PATH=%CUDA_HOME%\bin;%CUDA_HOME%\libnvvp;%PY_HOME%;%PY_HOME%\Scripts;%PATH%"
) else (
  set "PATH=%PY_HOME%;%PY_HOME%\Scripts;%PATH%"
)

"%PY_HOME%\python.exe" run_cef.py
endlocal
'@
Set-Content -Path (Join-Path $outputRoot "start_portable.bat") -Value $startPortableBat -Encoding ASCII

$startServerBat = @'
@echo off
setlocal
cd /d %~dp0

set "ROOT=%~dp0"
set "PY_HOME=%ROOT%python"
set "CUDA_HOME=%ROOT%cuda\v12.0"

if exist "%CUDA_HOME%\bin\nvrtc64_120_0.dll" (
  set "CUDA_PATH=%CUDA_HOME%"
  set "PATH=%CUDA_HOME%\bin;%CUDA_HOME%\libnvvp;%PY_HOME%;%PY_HOME%\Scripts;%PATH%"
) else (
  set "PATH=%PY_HOME%;%PY_HOME%\Scripts;%PATH%"
)

"%PY_HOME%\python.exe" run_server.py
endlocal
'@
Set-Content -Path (Join-Path $outputRoot "start_server_portable.bat") -Value $startServerBat -Encoding ASCII

$checkPortablePy = @'
import os
import sys

print("python:", sys.version)
print("executable:", sys.executable)
print("CUDA_PATH:", os.environ.get("CUDA_PATH", ""))

try:
    import cupy as cp
    n = cp.cuda.runtime.getDeviceCount()
    x = cp.arange(10000, dtype=cp.float32)
    s = float(x.sum().get())
    print("cupy_ok:", cp.__version__, "gpu_count:", n, "sum:", s)
except Exception as e:
    print("cupy_warning:", e)

try:
    import backend.server as s
    print("backend_cuda_available:", s.CUDA_AVAILABLE)
    print("backend_cpu_workers:", s.CPU_POOL_WORKERS)
    print("backend_cuda_workers:", s.CUDA_POOL_WORKERS)
except Exception as e:
    print("backend_warning:", e)
'@
Set-Content -Path (Join-Path $outputRoot "check_portable_env.py") -Value $checkPortablePy -Encoding ASCII

$checkBat = @'
@echo off
setlocal
cd /d %~dp0
set "ROOT=%~dp0"
set "PY_HOME=%ROOT%python"
set "CUDA_HOME=%ROOT%cuda\v12.0"
if exist "%CUDA_HOME%\bin\nvrtc64_120_0.dll" (
  set "CUDA_PATH=%CUDA_HOME%"
  set "PATH=%CUDA_HOME%\bin;%CUDA_HOME%\libnvvp;%PY_HOME%;%PY_HOME%\Scripts;%PATH%"
) else (
  set "PATH=%PY_HOME%;%PY_HOME%\Scripts;%PATH%"
)
"%PY_HOME%\python.exe" check_portable_env.py
endlocal
'@
Set-Content -Path (Join-Path $outputRoot "check_portable_env.bat") -Value $checkBat -Encoding ASCII

Write-Step "Pacote portatil criado com sucesso."
Write-Host ""
Write-Host "Saida: $outputRoot"
Write-Host "Entrada principal: start_portable.bat"
