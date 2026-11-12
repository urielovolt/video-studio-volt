# Instrucciones para Claude (y otros asistentes de IA)

Si la persona te pidió «instala esta herramienta» (o te compartió el enlace del repositorio),
haz esto, en este orden, y explícale en palabras sencillas lo que va pasando:

1. **Clonar** (si aún no está): `git clone https://github.com/urielovolt/video-studio-volt.git`
   en una carpeta que la persona elija (por defecto, `Documentos`). Si no hay `git`, descarga el
   ZIP de `https://github.com/urielovolt/video-studio-volt/archive/refs/heads/main.zip` y descomprímelo.
2. **Instalar**: en Windows, desde la carpeta del proyecto:
   `powershell -NoProfile -ExecutionPolicy Bypass -File Instalar.ps1`
   - Instala Python 3.13 con winget si falta (pide confirmación a la persona antes), crea `.venv`
     y pone ahí PyTorch 2.6.0 (CPU), librosa, Whisper (stable-ts), Demucs y Playwright.
   - Tarda de 5 a 15 minutos según la conexión. Córrelo en segundo plano y avisa cuando termine.
   - Al final imprime «Listo». Si falla, lee el error: casi siempre es Python que no es 3.13, o el
     Control de aplicaciones de Windows bloqueando una DLL (solución: las versiones exactas de
     `requirements.txt`; no las actualices).
3. **Abrir**: `Iniciar.bat` (o `.venv\Scripts\python.exe herramienta\servir.py`). Abre
   `http://localhost:8765/herramienta/video.html` en el navegador. Debe quedarse corriendo.
4. Dile a la persona: «+ Nueva canción» arriba, y el asistente la guía (audio, portada, letra).

## Datos útiles

- Solo Windows 10/11 está probado. El render usa Microsoft Edge (viene con Windows) para dibujar
  y codificar el video con la GPU; sin Edge, el instalador baja Chromium.
- Las canciones viven en `canciones/<nombre>/` y no se suben a git.
- La primera sincronización de letra descarga el modelo `medium` de Whisper (~1.5 GB).
- No hay nada en la nube: todo corre en la computadora de la persona.
- Estructura y detalles técnicos: `README.md`.

## Si vas a modificar el código

- `herramienta/motor.js` dibuja cada cuadro como función pura del tiempo (vista previa = video).
- `herramienta/disenos.js` tiene los 15 diseños de onda; agregar uno es agregar una entrada.
- `herramienta/servir.py` es el servidor local (sin dependencias) y lanza los procesos.
- `herramienta/analizar.py`, `sincronizar.py` y `render.py` son los pasos pesados.
- Textos de la interfaz y comentarios en español.
