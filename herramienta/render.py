"""Renderiza el video de la canción a MP4 listo para YouTube (por defecto 4K, 30 fps).

Uso:
  python herramienta/render.py canciones/mi-cancion                       -> video-2160p.mp4
  python herramienta/render.py canciones/mi-cancion --desde 40 --hasta 60 -> solo ese tramo (para probar)
  python herramienta/render.py canciones/mi-cancion --resolucion 1080     -> 1080p (más rápido)
  python herramienta/render.py canciones/mi-cancion --fps 60
  python herramienta/render.py canciones/mi-cancion 12.5 48 90            -> fotogramas sueltos (PNG) para revisar

Contrato con la página: window.seek(t), DURATION, ready y SIZE,
y cómo lo hace:
  - 4K: la página se dibuja a 1920x1080 y Chromium la escala 2x (device_scale_factor).
    YouTube le da mucha más calidad a los videos 4K, aunque se vean en 1080p.
  - Varios navegadores en paralelo (--hilos), cada uno con un tramo; al final se unen
    sin recomprimir. Como cada cuadro depende solo de t, los tramos casan exacto.
  - El audio es la canción tal cual (AAC 320 kbps), no voz ni música generada.
Todo se dibuja en <canvas> con la GPU y se captura con toDataURL (más rápido que una
captura de pantalla). Al final deja una hoja de control (control.jpg).
"""
import argparse
import re
import shutil
import base64
import multiprocessing as mp
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import imageio_ffmpeg

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import servir  # noqa: E402

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


CANVAS = False  # --canvas: lienzo vertical 1080x1920 para el Canvas de Spotify


def url_de(nombre):
    extra = "&formato=canvas" if CANVAS else ""
    return f"http://127.0.0.1:{servir.PORT}/herramienta/video.html?render&c={nombre}{extra}"


def vista():
    return {"width": 1080, "height": 1920} if CANVAS else {"width": 1920, "height": 1080}


def abrir(p, nombre, escala):
    # Con la GPU (Radeon vía ANGLE/D3D11) un cuadro 4K se dibuja en ~50 ms; sin ella, ~470 ms.
    browser = p.chromium.launch(args=["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist",
                                      "--disable-gpu-vsync", "--disable-frame-rate-limit"])
    page = browser.new_page(viewport=vista(), device_scale_factor=escala)
    page.goto(url_de(nombre), wait_until="load", timeout=60000)
    page.wait_for_function("typeof window.seek === 'function'", timeout=60000)
    page.evaluate("window.ready")
    return browser, page


# Dibuja el cuadro y lo devuelve como JPEG de calidad 0.97 en base64, directo del canvas.
# PNG sería sin pérdida pero tarda ~3.5 s por cuadro 4K; JPEG 0.97 ~0.17 s, y después de
# H.264 la diferencia no se ve (el video final también va en 4:2:0).
GRAB = ("t => { window.seek(t); const u = document.getElementById('stage').toDataURL('image/jpeg', 0.97);"
        " return u.slice(u.indexOf(',') + 1); }")


def x264(fps, salida, crf, preset):
    return subprocess.Popen(
        [FFMPEG, "-y", "-loglevel", "error",
         "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
         "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
         "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high",
         "-g", str(fps), "-bf", "2",
         "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
         str(salida)],
        stdin=subprocess.PIPE,
    )


def tramo(job):
    """Un proceso: un navegador que renderiza los cuadros [a, b) a su propio MP4."""
    from playwright.sync_api import sync_playwright
    nombre, escala, fps, a, b, salida, crf, preset, n, total = job
    servir.arrancar()
    with sync_playwright() as p:
        browser, page = abrir(p, nombre, escala)
        enc = x264(fps, salida, crf, preset)
        t0 = time.time()
        for i in range(a, b):
            enc.stdin.write(base64.b64decode(page.evaluate(GRAB, i / fps)))
            hechos = i - a + 1
            if hechos % 150 == 0:
                vel = hechos / (time.time() - t0)
                print(f"  [tramo {n + 1}/{total}] {hechos}/{b - a} cuadros · {vel:.1f} cuadros/s", flush=True)
        enc.stdin.close()
        enc.wait()
        browser.close()
    return salida


def buscar_cancion(folder):
    for ext in ("wav", "flac", "mp3", "m4a", "aac", "ogg"):
        if (folder / f"cancion.{ext}").exists():
            return folder / f"cancion.{ext}"
    sys.exit("No encuentro cancion.* en la carpeta.")


def tiene_audio(video):
    err = subprocess.run([FFMPEG, "-i", str(video)], capture_output=True, text=True, errors="replace").stderr
    return "Audio:" in err


def contar_cuadros(video):
    """Cuadros de video que de verdad quedaron en el archivo (sin decodificar, solo paquetes)."""
    err = subprocess.run([FFMPEG, "-i", str(video), "-map", "0:v", "-c", "copy", "-f", "null", "-"],
                         capture_output=True, text=True, errors="replace").stderr
    m = re.findall(r"frame=\s*(\d+)", err)
    return int(m[-1]) if m else -1


def hoja_control(video, out, dur):
    """Un cuadro cada 2 s en una sola imagen, para revisar de un vistazo."""
    cols = 8
    rows = max(1, -(-int(dur / 2) // cols))
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(video),
                    "-vf", f"fps=0.5,scale=320:-1,tile={cols}x{rows}:padding=4:color=black",
                    "-frames:v", "1", str(out)], check=True)


# ---------- Método GPU (por defecto): el navegador codifica el video él mismo ----------
# El canvas se convierte en VideoFrame y WebCodecs lo comprime a H.264 con el codificador
# de la Radeon. A Python solo llegan los bytes ya comprimidos (~200 KB por cuadro en vez de
# ~1.5 MB de JPEG), y el CPU queda libre. Medido en 4K: ~12 cuadros/s a 35 Mbps y ~6 a
# 100 Mbps (el default, por calidad), contra ~2.6 del método CPU (capturar JPEG + x264).
JS_INICIO = r"""
async ([fps, mbps, a0]) => {
  const cv = document.getElementById('stage');
  const cfg = { codec: 'avc1.640033', width: cv.width, height: cv.height, bitrate: mbps * 1e6,
                framerate: fps, hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality',
                bitrateMode: 'constant', avc: { format: 'annexb' } };
  let sup = await VideoEncoder.isConfigSupported(cfg);
  if (!sup.supported) { cfg.hardwareAcceleration = 'no-preference'; sup = await VideoEncoder.isConfigSupported(cfg); }
  if (!sup.supported) return 'Este navegador no puede codificar H.264 en ' + cv.width + 'x' + cv.height;
  window.__trozos = []; window.__error = null; window.__a0 = a0;
  window.__enc = new VideoEncoder({
    output: c => { const b = new Uint8Array(c.byteLength); c.copyTo(b); window.__trozos.push(b); },
    error: e => { window.__error = e.message; },
  });
  window.__enc.configure(cfg);
  return 'ok';
}
"""

JS_LOTE = r"""
async ([a, b, fps, final]) => {
  const cv = document.getElementById('stage'), enc = window.__enc;
  for (let i = a; i < b; i++) {
    window.seek(i / fps);
    const f = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    enc.encode(f, { keyFrame: (i - window.__a0) % (2 * fps) === 0 });  // un cuadro clave cada 2 s
    f.close();
    while (enc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 1));
  }
  if (final) await enc.flush();
  if (window.__error) throw new Error(window.__error);
  const partes = window.__trozos; window.__trozos = [];
  let n = 0; for (const p of partes) n += p.length;
  const todo = new Uint8Array(n); let o = 0;
  for (const p of partes) { todo.set(p, o); o += p.length; }
  let s = ''; for (let k = 0; k < todo.length; k += 0x8000) s += String.fromCharCode.apply(null, todo.subarray(k, k + 0x8000));
  return btoa(s);
}
"""


def render_gpu(p, nombre, escala, fps, a0, a1, h264, mbps):
    for canal in ("msedge", None):  # Edge trae H.264 por hardware; Chromium de respaldo
        try:
            browser = p.chromium.launch(channel=canal, args=[
                "--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist",
                "--disable-gpu-vsync", "--disable-frame-rate-limit"])
        except Exception:
            continue
        page = browser.new_page(viewport=vista(), device_scale_factor=escala)
        page.goto(url_de(nombre), wait_until="load", timeout=60000)
        page.wait_for_function("typeof window.seek === 'function'", timeout=60000)
        page.evaluate("window.ready")
        r = page.evaluate(JS_INICIO, [fps, mbps, a0])
        if r == "ok":
            break
        print(f"  {canal or 'chromium'}: {r}")
        browser.close()
    else:
        sys.exit("Ningún navegador pudo codificar; usa --metodo cpu.")
    print(f"  Codificando en {canal or 'chromium'} con la GPU…", flush=True)
    print("FASE codificando", flush=True)
    t0, lote = time.time(), fps * 2
    with open(h264, "wb") as out:
        for a in range(a0, a1, lote):
            b = min(a + lote, a1)
            out.write(base64.b64decode(page.evaluate(JS_LOTE, [a, b, fps, b >= a1])))
            hechos = b - a0
            print(f"PROGRESO {hechos} {a1 - a0} {hechos / (time.time() - t0):.2f}", flush=True)  # para el editor
            if (hechos // lote) % 5 == 0 or b >= a1:
                vel = hechos / (time.time() - t0)
                falta = (a1 - b) / vel if vel else 0
                print(f"  {hechos}/{a1 - a0} cuadros · {vel:.1f} cuadros/s · faltan {falta / 60:.1f} min", flush=True)
    browser.close()


def inicio_canvas(folder, largo):
    """Dónde empieza el canvas: la primera sección fuerte (el coro, casi siempre) que alcance."""
    import json
    S = json.loads((folder / "analisis.json").read_text(encoding="utf-8")).get("secciones", [])
    if not S:
        return 30.0
    tope = max(x["intensidad"] for x in S)
    for x in S:
        if x["intensidad"] >= 0.9 * tope and x["fin"] - x["inicio"] >= largo:
            return x["inicio"]
    return max(S, key=lambda x: x["intensidad"])["inicio"]


def canvas_spotify(args):
    """Canvas de Spotify: video vertical 9:16, sin audio, que se repite sin brinco.

    Se dibujan «segundos + cruce» y el final se funde con el principio (xfade): el último cuadro
    queda igual al que sigue del primero, así el bucle no se nota. Spotify pide 9:16, al menos
    720 px de alto, de 3 a 8 s, MP4; aquí sale 1080x1920 H.264."""
    global CANVAS
    CANVAS = True
    folder = Path(args.carpeta).resolve()
    largo, cruce = max(3.0, min(args.segundos, 8.0)), 1.0
    desde = args.desde if args.desde else inicio_canvas(folder, largo + cruce)
    fps = args.fps
    a0 = int(round(desde * fps))
    a1 = a0 + int(round((largo + cruce) * fps))
    salida = folder / (Path(args.salida).name if args.salida else "canvas-spotify.mp4")
    servir.arrancar()
    from playwright.sync_api import sync_playwright
    print("FASE preparando", flush=True)
    print(f"Canvas de Spotify: 1080x1920, {largo:g} s desde {desde:.1f} s, {fps} fps", flush=True)
    t0 = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        h264 = Path(tmp) / "video.h264"
        with sync_playwright() as p:
            render_gpu(p, folder.name, 1, fps, a0, a1, h264, 40)
        print("FASE uniendo", flush=True)
        # Primero el H.264 crudo a MP4 (marcas de tiempo, sin el relleno de la tasa constante), como en main().
        solo = Path(tmp) / "video.mp4"
        subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-fflags", "+genpts", "-r", str(fps), "-f", "h264", "-i", str(h264),
             "-c:v", "copy", "-bsf:v", "filter_units=remove_types=12", str(solo)],
            check=True,
        )
        # A = cuadros [cruce, largo+cruce); B = [0, cruce). Al final de A entra B: el último cuadro
        # del video es el cuadro «cruce» del tramo, que es justo el primero del video.
        filtro = (f"[0:v]split[a][b];"
                  f"[a]trim=start={cruce},setpts=PTS-STARTPTS,settb=AVTB,fps={fps}[A];"
                  f"[b]trim=end={cruce},setpts=PTS-STARTPTS,settb=AVTB,fps={fps}[B];"
                  f"[A][B]xfade=transition=fade:duration={cruce}:offset={largo - cruce},"
                  f"scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]")
        subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-i", str(solo),
             "-filter_complex", filtro, "-map", "[v]", "-an",
             "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-profile:v", "high", "-g", str(fps),
             "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
             "-movflags", "+faststart", str(salida)],
            check=True,
        )
    n = contar_cuadros(salida)
    print(f"Listo: {salida}  ({n} cuadros = {n / fps:.2f} s, {(time.time() - t0):.0f} s de render)")
    print(f"SALIDA {salida}", flush=True)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("carpeta")
    ap.add_argument("fotogramas", nargs="*", type=float)
    ap.add_argument("--resolucion", type=int, default=2160, choices=[1080, 1440, 2160])
    ap.add_argument("--fps", type=int, default=30, choices=[24, 25, 30, 50, 60])
    ap.add_argument("--desde", type=float, default=0.0)
    ap.add_argument("--hasta", type=float)
    ap.add_argument("--hilos", type=int, default=4)
    ap.add_argument("--crf", type=int, default=16, help="menor = más calidad y más peso (12–18); 16 da ~45 Mbps en 4K")
    ap.add_argument("--preset", default="medium", help="x264: faster, medium, slow (más lento = un poco mejor)")
    ap.add_argument("--metodo", default="gpu", choices=["gpu", "cpu"],
                    help="gpu: el navegador codifica con la Radeon (rápido); cpu: JPEG + x264 en paralelo")
    ap.add_argument("--mbps", type=int, default=80,
                    help="método gpu: tasa de bits constante. El codificador de la GPU necesita ~100 en 4K "
                         "para no perder el grano ni hacer escalones en los degradados (x264 lo logra con ~45); "
                         "40 sirve para borradores rápidos")
    ap.add_argument("--salida", help="nombre del archivo dentro de la carpeta de la canción (p. ej. prueba.mp4)")
    ap.add_argument("--sin-control", action="store_true", help="no hacer la hoja de control (control.jpg)")
    ap.add_argument("--canvas", action="store_true",
                    help="Canvas de Spotify: 1080x1920, sin audio, en bucle (canvas-spotify.mp4)")
    ap.add_argument("--segundos", type=float, default=8.0, help="--canvas: duración del bucle (Spotify: 3 a 8 s)")
    args = ap.parse_args()
    if args.canvas:
        return canvas_spotify(args)

    folder = Path(args.carpeta).resolve()
    nombre = folder.name
    escala = args.resolucion / 1080
    srv = servir.arrancar()
    from playwright.sync_api import sync_playwright

    if args.fotogramas:
        out = folder / "fotogramas"
        out.mkdir(exist_ok=True)
        with sync_playwright() as p:
            browser, page = abrir(p, nombre, escala)
            for t in args.fotogramas:
                png = page.evaluate("t => { window.seek(t); return document.getElementById('stage')"
                                    ".toDataURL('image/png').slice(22); }", t)
                (out / f"t{t:07.2f}.png").write_bytes(base64.b64decode(png))
            browser.close()
        print(f"{len(args.fotogramas)} fotogramas en {out}")
        return

    with sync_playwright() as p:
        browser, page = abrir(p, nombre, escala)
        dur = page.evaluate("window.DURATION")
        browser.close()

    hasta = min(args.hasta if args.hasta is not None else dur, dur)
    a0, a1 = int(round(args.desde * args.fps)), int(round(hasta * args.fps))
    cuadros = a1 - a0
    hilos = max(1, min(args.hilos, cuadros // (args.fps * 2) or 1))
    tramo_suf = "" if args.desde == 0 and hasta >= dur else f"-{args.desde:g}a{hasta:g}s"
    salida = folder / (Path(args.salida).name if args.salida else f"video-{args.resolucion}p{tramo_suf}.mp4")
    print("FASE preparando", flush=True)

    t0 = time.time()
    song = buscar_cancion(folder)
    if args.metodo == "gpu":
        print(f"Render {args.resolucion}p a {args.fps} fps: {cuadros} cuadros ({hasta - args.desde:.1f} s), método GPU…")
        with tempfile.TemporaryDirectory() as tmp:
            h264 = Path(tmp) / "video.h264"
            with sync_playwright() as p:
                render_gpu(p, nombre, escala, args.fps, a0, a1, h264, args.mbps)
            # Dos pasos. 1) El H.264 crudo a MP4: aquí se generan las marcas de tiempo. Si se mezcla
            # el crudo directo con el audio, ffmpeg (con -shortest) tira el audio entero sin avisar.
            # Se quitan las unidades de relleno (tipo 12) que mete la tasa constante: h264_metadata
            # no las entiende y tiraba el paquete completo (cuadros perdidos). Y se etiqueta BT.709,
            # porque la GPU escribe «reservado».
            solo_video = Path(tmp) / "video.mp4"
            print("FASE uniendo", flush=True)
            subprocess.run(
                [FFMPEG, "-y", "-loglevel", "error", "-fflags", "+genpts",
                 "-r", str(args.fps), "-f", "h264", "-i", str(h264), "-c:v", "copy",
                 "-bsf:v", "filter_units=remove_types=12,"
                           "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
                 str(solo_video)],
                check=True,
            )
            # 2) Ese MP4 + la canción (solo el tramo pedido) en AAC 320k.
            subprocess.run(
                [FFMPEG, "-y", "-loglevel", "error",
                 "-i", str(solo_video),
                 "-ss", f"{a0 / args.fps:.3f}", "-t", f"{cuadros / args.fps:.3f}", "-i", str(song),
                 "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                 "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
                 "-shortest", "-movflags", "+faststart", str(salida)],
                check=True,
            )
            if not tiene_audio(salida):
                print("OJO: el MP4 salió sin audio.")
            n = contar_cuadros(salida)
            if not cuadros - 1 <= n <= cuadros:  # -shortest puede recortar el último si el audio es 1 cuadro más corto
                guardado = folder / "video-gpu.h264"
                shutil.copy(h264, guardado)
                print(f"OJO: el MP4 tiene {n} cuadros y debían ser {cuadros}. Dejé el video crudo en {guardado}.")
        seg = time.time() - t0
        print(f"Listo: {salida}  ({seg / 60:.1f} min, {cuadros / seg:.1f} cuadros/s)")
        if not args.sin_control:
            hoja_control(salida, folder / "control.jpg", hasta - args.desde)
            print(f"Hoja de control: {folder / 'control.jpg'}")
        print(f"SALIDA {salida}", flush=True)
        return

    print(f"(método CPU, {hilos} navegadores)")
    with tempfile.TemporaryDirectory() as tmp:
        cortes = [a0 + cuadros * k // hilos for k in range(hilos + 1)]
        jobs = [(nombre, escala, args.fps, cortes[k], cortes[k + 1], str(Path(tmp) / f"t{k:02d}.mp4"),
                 args.crf, args.preset, k, hilos) for k in range(hilos)]
        if srv:
            srv.shutdown()  # los procesos hijos levantan el suyo (el primero gana; los demás lo usan)
            srv.server_close()
        ctx = mp.get_context("spawn")
        with ctx.Pool(hilos) as pool:
            partes = pool.map(tramo, jobs)
        lista = Path(tmp) / "lista.txt"
        lista.write_text("".join(f"file '{Path(x).as_posix()}'\n" for x in partes), encoding="utf-8")
        song = buscar_cancion(folder)
        subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", str(lista),
             "-ss", f"{a0 / args.fps:.3f}", "-t", f"{cuadros / args.fps:.3f}", "-i", str(song),
             "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
             "-shortest", "-movflags", "+faststart", str(salida)],
            check=True,
        )
    seg = time.time() - t0
    print(f"Listo: {salida}  ({seg / 60:.1f} min, {cuadros / seg:.1f} cuadros/s)")
    hoja_control(salida, folder / "control.jpg", hasta - args.desde)
    print(f"Hoja de control: {folder / 'control.jpg'}")


if __name__ == "__main__":
    main()
