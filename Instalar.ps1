# Video Studio Volt: instalación en Windows 10/11.
# Crea .venv dentro de esta carpeta con todo lo necesario. Se puede correr las veces que haga
# falta: lo que ya está instalado se salta.
#   Doble clic en Instalar.bat, o en PowerShell:  powershell -ExecutionPolicy Bypass -File Instalar.ps1
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Paso($t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Bien($t) { Write-Host "    $t" -ForegroundColor Green }

Write-Host "Video Studio Volt · instalación" -ForegroundColor White

# ---------- 1. Python 3.13 ----------
Paso "Buscando Python 3.13"
function Buscar-Python {
    $cands = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        try { $x = (& py -3.13 -c "import sys; print(sys.executable)" 2>$null); if ($LASTEXITCODE -eq 0 -and $x) { $cands += $x.Trim() } } catch {}
    }
    $cands += @("$env:LOCALAPPDATA\Programs\Python\Python313\python.exe", "$env:ProgramFiles\Python313\python.exe")
    foreach ($c in @('python', 'python3')) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { $cands += $cmd.Source }
    }
    foreach ($c in $cands) {
        if (-not $c -or -not (Test-Path -LiteralPath $c)) { continue }
        try {
            $v = (& $c -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null)
            if ($LASTEXITCODE -eq 0 -and $v.Trim() -eq '3.13') { return $c }
        } catch {}
    }
    return $null
}
$py = Buscar-Python
if (-not $py) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "    No está. Lo instalo con winget (Python 3.13, solo para tu usuario)…"
        winget install -e --id Python.Python.3.13 --scope user
        $py = Buscar-Python
    }
}
if (-not $py) {
    throw "No encontré Python 3.13. Instálalo desde https://www.python.org/downloads/ (versión 3.13) y vuelve a correr Instalar."
}
Bien "Python: $py"

# ---------- 2. Entorno .venv ----------
Paso "Preparando el entorno (.venv)"
$vpy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $vpy)) { & $py -m venv .venv; if ($LASTEXITCODE) { throw "No se pudo crear .venv" } }
& $vpy -m pip install --upgrade pip --quiet --disable-pip-version-check
Bien "Listo"

# ---------- 3. Dependencias ----------
Paso "Instalando PyTorch (CPU) — es la descarga más grande, unos minutos"
& $vpy -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu --disable-pip-version-check
if ($LASTEXITCODE) { throw "Falló la instalación de PyTorch" }

Paso "Instalando el resto (librosa, Whisper, Demucs, Playwright…)"
& $vpy -m pip install -r requirements.txt --disable-pip-version-check
if ($LASTEXITCODE) { throw "Falló la instalación de las dependencias" }

# ---------- 4. Navegador para el render ----------
Paso "Revisando el navegador para el render"
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($edge) {
    Bien "Microsoft Edge encontrado: el video se codifica con la GPU"
} else {
    Write-Host "    Sin Edge: descargo Chromium para Playwright…"
    & $vpy -m playwright install chromium
}

# ---------- 5. Comprobación ----------
Paso "Comprobando que todo cargue"
& $vpy -c "import torch, librosa, numba, stable_whisper, demucs, imageio_ffmpeg, playwright; print('    torch', torch.__version__, '| librosa', librosa.__version__)"
if ($LASTEXITCODE) {
    Write-Host ""
    Write-Host "Algo no cargó. Si el error habla de una DLL bloqueada, es el Control de aplicaciones de" -ForegroundColor Yellow
    Write-Host "Windows: usa exactamente las versiones de requirements.txt (son las que sí pasan)." -ForegroundColor Yellow
    throw "La comprobación falló"
}

Write-Host ""
Write-Host "Listo. Para abrir Video Studio Volt: doble clic en Iniciar.bat" -ForegroundColor Green
Write-Host "(La primera vez que sincronices una letra se descarga el modelo de voz de Whisper, ~1.5 GB.)"
