"""Abre el editor de una canción en el navegador.

Uso:
  python herramienta/servir.py                         -> http://localhost:8765/herramienta/video.html
  python herramienta/servir.py canciones/mi-cancion    -> abre directo esa canción
  python herramienta/servir.py --sin-abrir             (no abre el navegador)

Es un servidor local (solo tu computadora). Además de servir los archivos, deja que
el editor:
  GET  /canciones                         lista de canciones (carpetas en canciones/)
  POST /nueva?c=nombre                    crea una carpeta de canción
  POST /guardar?c=..&archivo=..           guarda letra.json, estilo.json o letra.txt
  POST /subir?c=..&tipo=cancion|portada   sube el audio o la carátula (cuerpo = el archivo)
  POST /procesar?c=..&paso=..             corre analizar / sincronizar / transcribir en segundo plano
  POST /procesar?c=..&paso=exportar|prueba|canvas&resolucion=..&fps=..&mbps=..&desde=..&hasta=..
                                          renderiza el video (render.py) en segundo plano
  POST /cancelar?c=..                     detiene lo que esté corriendo
  POST /abrir?c=..&archivo=..             muestra el archivo en el Explorador de Windows
  GET  /estado?c=..                       si hay algo corriendo, su avance y las últimas líneas del registro
render.py usa el mismo servidor por dentro.
"""
import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import unicodedata
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
CANCIONES = ROOT / "canciones"
PORT = int(os.environ.get("CANCION_PUERTO", 8765))
GUARDABLES = {"letra.json", "estilo.json", "letra.txt"}
AUDIO = {".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg"}
IMAGEN = {".jpg", ".jpeg", ".png", ".webp"}
def _python_del_entorno():
    """El Python con torch/librosa/Whisper: el que diga CANCION_PYTHON, o el .venv que deja
    Instalar.ps1 dentro del proyecto, o en último caso este mismo."""
    if os.environ.get("CANCION_PYTHON"):
        return Path(os.environ["CANCION_PYTHON"])
    for cand in (ROOT / ".venv" / "Scripts" / "python.exe", ROOT / ".venv" / "bin" / "python",
                 Path.home() / ".venvs" / "cancion" / "Scripts" / "python.exe"):
        if cand.exists():
            return cand
    return Path(sys.executable)


VENV_PY = _python_del_entorno()
PASOS = {
    "analizar": ["analizar.py"],
    "sincronizar": ["sincronizar.py"],
    "transcribir": ["sincronizar.py", "--transcribir"],
}
trabajos = {}  # canción -> Popen


def slug(texto):
    s = unicodedata.normalize("NFD", texto.lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:60]


def carpeta(nombre):
    folder = (CANCIONES / nombre).resolve()
    if not nombre or folder.parent != CANCIONES.resolve():
        return None
    return folder


def reducir_portada(src, dst):
    """La carátula a 1600 px en JPEG: el navegador sufre con imágenes gigantes y en 4K no se nota."""
    import imageio_ffmpeg
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(src),
                    "-vf", "scale='min(1600,iw)':-2:flags=lanczos", "-q:v", "2", str(dst)], check=True)


class _Trozo:
    """Un archivo abierto que solo deja leer n bytes (para copyfile del servidor)."""

    def __init__(self, f, n):
        self.f, self.n = f, n

    def read(self, k=-1):
        if self.n <= 0:
            return b""
        k = self.n if k is None or k < 0 else min(k, self.n)
        d = self.f.read(k)
        self.n -= len(d)
        return d

    def close(self):
        self.f.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        if not self._rango:
            self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    _rango = None

    def send_head(self):
        """Como el original, pero responde a «Range: bytes=a-b» con 206. Sin esto el navegador no
        puede saltar dentro del audio o del video: al dar play arrancaba siempre desde 0."""
        self._rango = None
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path) or m.group(1) == m.group(2) == "":
            return super().send_head()
        tam = os.path.getsize(path)
        if m.group(1) == "":  # «bytes=-N»: los últimos N
            a, b = max(0, tam - int(m.group(2))), tam - 1
        else:
            a = int(m.group(1))
            b = min(int(m.group(2)), tam - 1) if m.group(2) else tam - 1
        if a >= tam or a > b:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{tam}")
            self.end_headers()
            return None
        f = open(path, "rb")
        f.seek(a)
        self._rango = (a, b)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {a}-{b}/{tam}")
        self.send_header("Content-Length", str(b - a + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return _Trozo(f, b - a + 1)

    def responder(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path in ("/", "/herramienta", "/herramienta/"):  # la raíz lleva directo al editor
            self.send_response(302)
            self.send_header("Location", "/herramienta/video.html" + (f"?{url.query}" if url.query else ""))
            self.end_headers()
            return
        if url.path == "/canciones":
            CANCIONES.mkdir(exist_ok=True)
            lista = []
            for d in sorted(CANCIONES.iterdir()):
                if d.is_dir():
                    lista.append({"c": d.name, "analizada": (d / "analisis.json").exists(),
                                  "letra": (d / "letra.json").exists()})
            return self.responder(lista)
        if url.path == "/estado":
            folder = carpeta(q.get("c", [""])[0])
            if not folder:
                return self.responder({"error": "canción inválida"}, 400)
            p = trabajos.get(folder.name)
            log = folder / "proceso.log"
            texto = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
            todas = [ln for ln in texto.replace("\r", "\n").splitlines() if ln.strip()]
            # render.py deja líneas para la máquina: «PROGRESO hechos total cuadros/s», «FASE …», «SALIDA …»
            progreso = fase = salida = None
            for ln in todas:
                if ln.startswith("PROGRESO "):
                    h, tot, vel = ln.split()[1:4]
                    progreso = {"hechos": int(h), "total": int(tot), "vel": float(vel)}
                elif ln.startswith("FASE "):
                    fase = ln[5:].strip()
                elif ln.startswith("SALIDA "):
                    salida = ln[7:].strip()
            lineas = [ln for ln in todas if not ln.startswith(("PROGRESO ", "FASE ", "SALIDA "))
                      and "it/s" not in ln and "iB/s" not in ln and "%|" not in ln]
            if salida:
                salida = {"ruta": salida, "nombre": Path(salida).name}
            return self.responder({"corriendo": bool(p and p.poll() is None),
                                   "codigo": None if not p else p.poll(), "log": lineas[-12:],
                                   "paso": todas[0][1:].strip() if todas and todas[0].startswith("▶") else None,
                                   "progreso": progreso, "fase": fase, "salida": salida})
        return super().do_GET()

    def do_POST(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        nombre = q.get("c", [""])[0]

        if url.path == "/nueva":
            s = slug(nombre)
            if not s:
                return self.responder({"error": "Nombre vacío"}, 400)
            (CANCIONES / s).mkdir(parents=True, exist_ok=True)
            return self.responder({"c": s})

        folder = carpeta(nombre)
        if not folder or not folder.is_dir():
            return self.responder({"error": "Canción inválida"}, 400)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))

        if url.path == "/guardar":
            archivo = q.get("archivo", [""])[0]
            if archivo not in GUARDABLES:
                return self.responder({"error": "Archivo no permitido"}, 400)
            target = folder / archivo
            if target.exists():  # copia de seguridad de la versión anterior
                (folder / f"{archivo}.anterior").write_bytes(target.read_bytes())
            if archivo.endswith(".json"):
                try:
                    data = json.loads(body)
                except ValueError:
                    return self.responder({"error": "JSON inválido"}, 400)
                target.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            else:
                target.write_text(body.decode("utf-8"), encoding="utf-8")
            return self.responder({"ok": True})

        if url.path == "/subir":
            tipo = q.get("tipo", [""])[0]
            ext = Path(q.get("nombre", [""])[0]).suffix.lower()
            if tipo == "cancion" and ext in AUDIO:
                for viejo in folder.glob("cancion.*"):
                    viejo.unlink()
                for derivado in ("voz.wav", "analisis.json"):  # eran de la canción anterior
                    if (folder / derivado).exists():
                        (folder / derivado).unlink()
                (folder / f"cancion{ext}").write_bytes(body)
                self.lanzar(folder, "analizar")
                return self.responder({"ok": True, "archivo": f"cancion{ext}", "procesando": "analizar"})
            if tipo == "portada" and ext in IMAGEN:
                original = folder / f"portada-original{ext}"
                original.write_bytes(body)
                reducir_portada(original, folder / "portada.jpg")
                return self.responder({"ok": True, "archivo": "portada.jpg"})
            return self.responder({"error": f"Tipo de archivo no permitido ({tipo}, {ext})"}, 400)

        if url.path == "/cancelar":
            p = trabajos.get(folder.name)
            if p and p.poll() is None:
                p.cancelar()
            return self.responder({"ok": True})

        if url.path == "/abrir":
            archivo = folder / Path(q.get("archivo", [""])[0]).name
            if sys.platform == "win32":
                if archivo.is_file() and q.get("modo", [""])[0] == "reproducir":
                    os.startfile(str(archivo))  # con el reproductor de video de Windows
                elif archivo.is_file():
                    subprocess.Popen(["explorer", "/select,", str(archivo)])
                else:
                    os.startfile(str(folder))
            return self.responder({"ok": True})

        if url.path == "/procesar":
            paso = q.get("paso", [""])[0]
            if paso in ("exportar", "prueba", "canvas"):
                try:
                    extra = render_args(paso, q)
                except ValueError:
                    return self.responder({"error": "Opciones de exportación inválidas"}, 400)
                ok = self.lanzar(folder, paso, extra)
                return self.responder({"ok": ok} if ok else {"error": "Ya hay un proceso corriendo"}, 200 if ok else 409)
            if paso not in PASOS:
                return self.responder({"error": "Paso desconocido"}, 400)
            if paso != "analizar" and not (folder / "letra.txt").exists() and paso == "sincronizar":
                return self.responder({"error": "Falta la letra (escríbela o usa «Sacar letra del audio»)"}, 400)
            ok = self.lanzar(folder, paso)
            return self.responder({"ok": ok} if ok else {"error": "Ya hay un proceso corriendo"}, 200 if ok else 409)

        self.responder({"error": "Ruta desconocida"}, 404)

    def lanzar(self, folder, paso, extra=None):
        """Corre el paso en el entorno con torch/librosa; después de la letra, vuelve a analizar."""
        p = trabajos.get(folder.name)
        if p and p.poll() is None:
            return False
        here = Path(__file__).resolve().parent
        if extra is not None:
            # El render va con este mismo Python (tiene Playwright) y contra este mismo servidor.
            cmd = [sys.executable, str(here / "render.py"), str(folder), *extra]
            trabajos[folder.name] = Trabajo(paso, [cmd], folder / "proceso.log",
                                            {"CANCION_PUERTO": str(self.server.server_address[1])})
            trabajos[folder.name].start()
            return True
        if not VENV_PY.exists():
            (folder / "proceso.log").write_text(f"No encuentro el Python del entorno en {VENV_PY}\n", encoding="utf-8")
            return False
        cmds = [[str(VENV_PY), str(here / PASOS[paso][0]), str(folder), *PASOS[paso][1:]]]
        if paso in ("sincronizar", "transcribir"):  # para que la letra brille con la voz separada
            cmds.append([str(VENV_PY), str(here / "analizar.py"), str(folder)])
        trabajos[folder.name] = Trabajo(paso, cmds, folder / "proceso.log")
        trabajos[folder.name].start()
        return True


class Trabajo(threading.Thread):
    """Corre los comandos uno tras otro y deja todo en proceso.log. poll() como Popen."""

    def __init__(self, paso, cmds, log, env=None):
        super().__init__(daemon=True)
        self.paso, self.cmds, self.log, self.codigo = paso, cmds, log, None
        self.env, self.proc, self.cancelado = env or {}, None, False

    def run(self):
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONWARNINGS": "ignore",
               "PYTHONUNBUFFERED": "1", **self.env}
        with open(self.log, "w", encoding="utf-8") as log:
            log.write(f"▶ {self.paso}\n")
            log.flush()
            for cmd in self.cmds:
                self.proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, env=env, cwd=str(ROOT))
                code = self.proc.wait()
                if self.cancelado:
                    self.codigo = -1
                    log.write("✗ Cancelado\n")
                    return
                if code:
                    self.codigo = code
                    log.write(f"✗ Falló (código {code})\n")
                    return
            log.write("✓ Terminado\n")
        self.codigo = 0

    def cancelar(self):
        """Detiene el proceso y sus hijos (el navegador del render, Demucs…)."""
        self.cancelado = True
        if self.proc and self.proc.poll() is None:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"], capture_output=True)
            else:
                self.proc.kill()

    def poll(self):
        return None if self.is_alive() else self.codigo


def render_args(paso, q):
    """Opciones de render.py a partir de la petición (solo números, nada de texto libre)."""
    def num(k, tipo, defecto):
        v = q.get(k, [""])[0]
        return tipo(v) if v != "" else defecto
    res, fps, mbps = num("resolucion", int, 2160), num("fps", int, 30), num("mbps", int, 80)
    if res not in (1080, 1440, 2160) or fps not in (24, 25, 30, 50, 60) or not 10 <= mbps <= 200:
        raise ValueError
    extra = ["--resolucion", str(res), "--fps", str(fps), "--mbps", str(mbps)]
    desde, hasta = num("desde", float, None), num("hasta", float, None)
    if desde is not None:
        extra += ["--desde", f"{max(0.0, desde):.3f}"]
    if hasta is not None:
        extra += ["--hasta", f"{hasta:.3f}"]
    if paso == "prueba":
        extra += ["--salida", "prueba.mp4", "--sin-control"]
    if paso == "canvas":  # Canvas de Spotify: siempre 1080x1920 a 30 fps, 8 s; sin «desde», busca el coro
        motion = q.get("motion", ["cine"])[0]
        if motion not in ("cine", "cronografo", "ondas"):
            raise ValueError
        extra = ["--canvas", "--fps", "30", "--motion", motion] + (["--desde", f"{max(0.0, desde):.3f}"] if desde else [])
    return extra


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # En Windows SO_REUSEADDR deja que dos servidores tomen el mismo puerto y las peticiones
    # caen en cualquiera de los dos. Mejor que falle y se use el que ya estaba.
    allow_reuse_address = False


def arrancar(port=PORT):
    """Arranca el servidor en un hilo (para render.py). Si ya hay uno corriendo, lo usa."""
    try:
        srv = Server(("127.0.0.1", port), Handler)
    except OSError:
        return None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    port = PORT
    if "--puerto" in sys.argv:
        port = int(sys.argv[sys.argv.index("--puerto") + 1])
    args = [a for a in sys.argv[1:] if not a.startswith("--") and not a.isdigit()]
    nombre = Path(args[0]).name if args else ""
    url = f"http://localhost:{port}/herramienta/video.html" + (f"?c={nombre}" if nombre else "")
    try:
        srv = Server(("127.0.0.1", port), Handler)
    except OSError:
        # Ya hay algo en ese puerto: casi siempre otra copia de este servidor que quedó abierta
        # (quizá de una versión anterior). Si es la actual, sirve; si no, hay que cerrarla.
        import urllib.request
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/canciones", timeout=3).read()
            print(f"Ya hay un editor abierto en el puerto {port}; uso ese: {url}")
            if "--sin-abrir" not in sys.argv:
                webbrowser.open(url)
        except Exception:
            print(f"El puerto {port} está ocupado por otro programa o por una versión vieja del editor.\n"
                  f"Ciérralo (o reinicia la terminal donde corría) y vuelve a intentar, o usa otro puerto:\n"
                  f"  python herramienta/servir.py --puerto 8780")
        return
    with srv:
        print(f"Editor en {url}  (Ctrl+C para cerrar)", flush=True)
        if "--sin-abrir" not in sys.argv:
            webbrowser.open(url)
        srv.serve_forever()


if __name__ == "__main__":
    main()
