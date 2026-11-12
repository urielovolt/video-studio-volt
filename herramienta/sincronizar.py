"""Pone cada verso (y cada palabra) de la letra en el segundo en que se canta.

Uso:
  python herramienta/sincronizar.py canciones/mi-cancion
  python herramienta/sincronizar.py canciones/mi-cancion --modelo small     (más rápido, menos fino)
  python herramienta/sincronizar.py canciones/mi-cancion --sin-separar      (si la voz ya va limpia)
  python herramienta/sincronizar.py canciones/mi-cancion --forzar           (rehace también lo ajustado a mano)
  python herramienta/sincronizar.py canciones/mi-cancion --manual           (sin IA: versos repartidos parejo,
                                                                             para marcarlos tú en el editor)
  python herramienta/sincronizar.py canciones/mi-cancion --transcribir      (sin letra: la IA la saca del audio)

Con --transcribir (o si no hay letra.txt) Whisper escucha la canción y escribe la
letra él solo: deja letra.txt como BORRADOR y letra.json con sus tiempos. En canto
se equivoca bastante más que en voz hablada (palabras estiradas, música encima),
así que el flujo es: transcribir -> corregir letra.txt a mano -> correr sin
--transcribir para alinear la letra ya correcta. Si ya había letra.txt no se
toca: el borrador queda en letra-transcrita.txt.
Separar la voz a veces ayuda y a veces empeora la transcripción; si sale mal,
prueba con --sin-separar (con la mezcla completa).

Lee letra.txt (un verso por línea). Una línea vacía separa estrofas; una línea
entre corchetes como [Coro] es solo una etiqueta: no se canta, se anota.

1. Separa la voz de la música con Demucs (queda en voz.wav y no se vuelve a hacer).
   Con la voz sola la alineación acierta mucho más que con la mezcla completa.
2. stable-ts alinea TU letra con esa voz: no intenta adivinar qué dices, solo
   busca dónde cae cada palabra que ya le diste.
3. Escribe letra.json. Los versos que ajustaste a mano en el editor (manual: true)
   se respetan, salvo con --forzar.

Todo corre en CPU. Para una canción de 4 min: Demucs ~3–6 min, alinear ~3–10 min.
Después conviene correr analizar.py otra vez para que mida la voz separada.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from analizar import buscar_cancion  # noqa: E402


def leer_letra(folder):
    path = folder / "letra.txt"
    if not path.exists():
        sys.exit(f"Falta {path} (un verso por línea).")
    lineas, estrofa, etiqueta = [], 0, None
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        s = raw.strip()
        if not s:
            if lineas and lineas[-1]["estrofa"] == estrofa:
                estrofa += 1
            continue
        m = re.fullmatch(r"\[(.+)\]", s)
        if m:
            etiqueta = m.group(1).strip()
            if lineas and lineas[-1]["estrofa"] == estrofa:
                estrofa += 1
            continue
        lineas.append({"texto": s, "estrofa": estrofa, "etiqueta": etiqueta})
        etiqueta = None
    if not lineas:
        sys.exit("letra.txt no tiene versos.")
    return lineas


def norm(s):
    s = unicodedata.normalize("NFD", s.lower())
    return "".join(c for c in s if c.isalnum() and unicodedata.category(c) != "Mn")


def a16k(path):
    """Audio a 16 kHz mono como arreglo: así stable-ts no necesita un ffmpeg en el PATH."""
    import librosa
    y, _ = librosa.load(str(path), sr=16000, mono=True)
    return y


def separar_voz(folder, song):
    out = folder / "voz.wav"
    if out.exists():
        print("Voz separada: uso voz.wav que ya estaba.")
        return out
    print("Separando la voz con Demucs (CPU, unos minutos)…", flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([sys.executable, "-m", "demucs", "--two-stems", "vocals", "-n", "htdemucs",
                        "-o", tmp, str(song)], check=True)
        found = list(Path(tmp).rglob("vocals.wav"))
        if not found:
            sys.exit("Demucs no dejó vocals.wav.")
        shutil.move(str(found[0]), out)
    return out


def repartir_parejo(lineas, dur, inicio=None, fin=None):
    """Sin alineación: versos uno tras otro a lo largo de la canción, para ajustarlos a mano."""
    a = inicio if inicio is not None else min(8.0, dur * 0.05)
    b = fin if fin is not None else dur - min(6.0, dur * 0.05)
    paso = (b - a) / len(lineas)
    for i, ln in enumerate(lineas):
        ln["inicio"], ln["fin"] = round(a + i * paso, 3), round(a + (i + 0.9) * paso, 3)
        repartir_palabras(ln)


def repartir_palabras(ln):
    words = ln["texto"].split()
    total = sum(len(w) for w in words) or 1
    t, d = ln["inicio"], ln["fin"] - ln["inicio"]
    ln["palabras"] = []
    for w in words:
        span = d * len(w) / total
        ln["palabras"].append({"t": w, "i": round(t, 3), "f": round(t + span, 3)})
        t += span


def asignar(lineas, words):
    """Pasa los tiempos de las palabras alineadas a las palabras de cada verso.

    Se compara letra por letra (sin acentos ni signos), así no importa cómo haya
    partido stable-ts las palabras ni la puntuación.
    """
    stream = []  # (caracter, inicio, fin)
    for w in words:
        for c in norm(w["word"]):
            stream.append((c, w["start"], w["end"]))
    pos = 0
    for ln in lineas:
        ln["palabras"] = []
        for w in ln["texto"].split():
            key = norm(w)
            if not key:
                ln["palabras"].append({"t": w, "i": None, "f": None})
                continue
            # Busca la palabra a partir de donde va (tolera letras que el alineador perdió).
            j = pos
            while j < len(stream) and stream[j][0] != key[0]:
                j += 1
            if j >= len(stream):
                ln["palabras"].append({"t": w, "i": None, "f": None})
                continue
            k = min(j + len(key), len(stream)) - 1
            ln["palabras"].append({"t": w, "i": round(stream[j][1], 3), "f": round(stream[k][2], 3)})
            pos = k + 1
        rellenar(ln)


def rellenar(ln):
    """Palabras sin tiempo (signos sueltos o fallos): se reparten entre sus vecinas."""
    ws = ln["palabras"]
    known = [i for i, w in enumerate(ws) if w["i"] is not None]
    if not known:
        return
    for i, w in enumerate(ws):
        if w["i"] is None:
            prev = max([k for k in known if k < i], default=None)
            nxt = min([k for k in known if k > i], default=None)
            a = ws[prev]["f"] if prev is not None else ws[nxt]["i"]
            b = ws[nxt]["i"] if nxt is not None else ws[prev]["f"]
            w["i"] = w["f"] = round((a + b) / 2, 3)
    ln["inicio"] = ws[0]["i"]
    ln["fin"] = max(w["f"] for w in ws)


def transcribir(folder, song, args):
    """Sin letra: Whisper la escucha y la escribe. Cada segmento que detecta queda como un verso."""
    audio = song if args.sin_separar else separar_voz(folder, song)
    import stable_whisper
    print(f"Cargando Whisper «{args.modelo}»…", flush=True)
    model = stable_whisper.load_model(args.modelo, device="cpu")
    print("Escuchando la canción para sacar la letra (en CPU tarda varios minutos)…", flush=True)
    result = model.transcribe(a16k(audio), language=args.idioma, vad=False, word_timestamps=True,
                              condition_on_previous_text=False, temperature=0.0,
                              initial_prompt="Letra de una canción en español.")
    # Versos: cortes en silencios y en frases largas, como se canta.
    result.split_by_gap(0.6).split_by_length(max_words=10)
    lineas, prev_end, estrofa = [], None, 0
    for s in result.segments:
        texto = s.text.strip()
        if not texto or not s.words:
            continue
        if prev_end is not None and s.start - prev_end > 3.0:
            estrofa += 1  # una pausa larga: estrofa nueva
        ln = {"texto": texto, "estrofa": estrofa, "etiqueta": None, "inicio": round(s.start, 3),
              "fin": round(s.end, 3),
              "palabras": [{"t": w.word.strip(), "i": round(w.start, 3), "f": round(w.end, 3)}
                           for w in s.words if w.word.strip()]}
        lineas.append(ln)
        prev_end = s.end
    if not lineas:
        sys.exit("Whisper no encontró voz. Prueba con --sin-separar o con --modelo large-v3.")
    txt, cur = [], 0
    for ln in lineas:
        if ln["estrofa"] != cur:
            txt.append("")
            cur = ln["estrofa"]
        txt.append(ln["texto"])
    ya_habia = (folder / "letra.txt").exists()  # no pisar la letra ni los tiempos que ya tenías
    dest = folder / ("letra-transcrita.txt" if ya_habia else "letra.txt")
    dest.write_text("\n".join(txt) + "\n", encoding="utf-8")
    (folder / ("letra-transcrita.json" if ya_habia else "letra.json")).write_text(json.dumps({"fuente": f"transcrita {args.modelo}", "lineas": lineas},
                                                  ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nBorrador de la letra en {dest} ({len(lineas)} versos):\n")
    print("\n".join(txt))
    print("\nRevísala: en canto Whisper confunde palabras. Corrige el archivo y corre otra vez "
          "sin --transcribir para alinear la letra correcta.")


def recortar_largas(lineas, maximo=2.5):
    """Arregla versos que el alineador estiró sobre un instrumental.

    Una palabra de más de 2.5 s, o un salto de más de 3 s dentro de un verso, casi siempre es
    el final de una frase justo antes de un solo: se queda colgada hasta que vuelve la voz.
    Sin esto, el verso se quedaría en pantalla durante todo el instrumental."""
    for ln in lineas:
        ws = [w for w in ln.get("palabras", []) if w["i"] is not None]
        for w in ws:
            if w["f"] - w["i"] > maximo:
                w["f"] = round(w["i"] + 0.8, 3)
        # Un hueco de más de 3 s a media frase: el alineador mandó el final del verso
        # al otro lado del instrumental. Esas palabras se pegan a las anteriores.
        for k in range(1, len(ws)):
            if ws[k]["i"] - ws[k - 1]["f"] > 3.0:
                t = ws[k - 1]["f"]
                for w in ws[k:]:
                    d = min(max(w["f"] - w["i"], 0.25), 0.8)
                    w["i"], w["f"] = round(t, 3), round(t + d, 3)
                    t += d
                break
        if ln.get("palabras"):
            ln["fin"] = max(w["f"] for w in ln["palabras"] if w["f"] is not None)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("carpeta")
    ap.add_argument("--modelo", default="medium", help="tiny, base, small, medium, large-v3")
    ap.add_argument("--idioma", default="es")
    ap.add_argument("--sin-separar", action="store_true")
    ap.add_argument("--forzar", action="store_true")
    ap.add_argument("--manual", action="store_true")
    ap.add_argument("--transcribir", action="store_true")
    args = ap.parse_args()

    folder = Path(args.carpeta).resolve()
    song = buscar_cancion(folder)
    if args.transcribir or not (folder / "letra.txt").exists():
        transcribir(folder, song, args)
        return
    lineas = leer_letra(folder)
    out = folder / "letra.json"
    prev = json.loads(out.read_text(encoding="utf-8")) if out.exists() else None

    import librosa
    dur = librosa.get_duration(path=str(song)) if song.suffix.lower() in (".wav", ".flac", ".mp3", ".ogg") else None

    if args.manual:
        if dur is None:
            dur = json.loads((folder / "analisis.json").read_text(encoding="utf-8"))["duracion"]
        repartir_parejo(lineas, dur)
        fuente = "parejo"
    else:
        audio = song if args.sin_separar else separar_voz(folder, song)
        import stable_whisper
        print(f"Cargando Whisper «{args.modelo}»…", flush=True)
        model = stable_whisper.load_model(args.modelo, device="cpu")
        texto = "\n".join(ln["texto"] for ln in lineas)
        print("Alineando la letra con la voz…", flush=True)
        result = model.align(a16k(audio), texto, language=args.idioma, original_split=True,
                             vad=False, regroup=False)
        words = [{"word": w.word, "start": w.start, "end": w.end} for s in result.segments for w in s.words]
        asignar(lineas, words)
        perdidos = 0
        for n, ln in enumerate(lineas):
            if "inicio" not in ln:  # el verso entero se perdió: lo pone justo después del anterior
                a = lineas[n - 1]["fin"] + 0.2 if n else 0.0
                ln["inicio"], ln["fin"] = a, a + 2.5
                repartir_palabras(ln)
                perdidos += 1
        if perdidos:
            print(f"Aviso: {perdidos} verso(s) no se encontraron en la voz; quedaron provisionales.")
        fuente = f"stable-ts {args.modelo}"

    if prev and not args.forzar:
        manual = {(p["texto"], n): p for n, p in enumerate(prev.get("lineas", [])) if p.get("manual")}
        kept = 0
        for n, ln in enumerate(lineas):
            if (ln["texto"], n) in manual:
                lineas[n] = manual[(ln["texto"], n)]
                kept += 1
        if kept:
            print(f"Respeté {kept} verso(s) ajustados a mano (usa --forzar para rehacerlos).")

    recortar_largas(lineas)
    for ln in lineas:
        ln["inicio"], ln["fin"] = round(ln["inicio"], 3), round(max(ln["fin"], ln["inicio"] + 0.3), 3)
    out.write_text(json.dumps({"fuente": fuente, "lineas": lineas}, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    print(f"Listo: {out} ({len(lineas)} versos)")
    for ln in lineas:
        print(f"  {ln['inicio']:7.2f} – {ln['fin']:7.2f}  {ln['texto']}")
    if not args.manual and not args.sin_separar:
        print("\nSiguiente: vuelve a correr analizar.py para que mida la voz separada.")


if __name__ == "__main__":
    main()
