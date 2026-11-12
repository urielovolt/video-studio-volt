"""Analiza la canción una sola vez y guarda todo lo que las ondas necesitan para seguirla.

Uso:
  python herramienta/analizar.py canciones/mi-cancion        -> analisis.json

La carpeta debe traer cancion.wav (o .flac, .mp3, .m4a). Si ya existe voz.wav
(la voz separada que deja sincronizar.py), también se mide cuándo se canta,
para que la letra brille con la voz.

Por qué precalculado y no con el analizador del navegador: render.py dibuja el
video cuadro por cuadro saltando en el tiempo, sin audio sonando. Con los datos
ya medidos, la vista previa y el MP4 salen idénticos.

analisis.json (todo a 60 cuadros por segundo; los arreglos van en base64):
  duracion, tempo, beats[], compases[], golpes[]   tiempos en segundos
  secciones[{inicio, fin, intensidad 0..1}]        estrofa contenida, coro arriba
  bandas   64 bandas de frecuencia (graves -> agudos), uint8 por cuadro
  onda     128 muestras de la forma de onda por cuadro, int8
  energia  rms, graves, medios, agudos, golpe, voz (uint8 por cuadro)
  resumen  picos para dibujar la forma de onda completa en el editor
"""
import base64
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import imageio_ffmpeg
import librosa
import numpy as np

FPS = 60
SR = 44100
HOP = SR // FPS  # 735 muestras por cuadro
N_BANDAS = 64
N_ONDA = 128
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
EXTS = ("wav", "flac", "mp3", "m4a", "aac", "ogg")


def buscar_cancion(folder):
    for ext in EXTS:
        p = folder / f"cancion.{ext}"
        if p.exists():
            return p
    sys.exit(f"No encuentro cancion.wav (ni {', '.join(EXTS[1:])}) en {folder}")


def cargar(path):
    """Decodifica con ffmpeg a WAV estéreo 44.1 kHz: así da igual el formato de entrada."""
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "a.wav"
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(path),
                        "-ac", "2", "-ar", str(SR), str(wav)], check=True)
        y, _ = librosa.load(wav, sr=SR, mono=False)
    return y


def normalizar(x, bajo=5, alto=99.5):
    lo, hi = np.percentile(x, bajo), np.percentile(x, alto)
    return np.clip((x - lo) / max(hi - lo, 1e-9), 0, 1)


def suavizar(x, sube=0.55, baja=0.12):
    """Sube rápido y baja lento, como los vúmetros: la onda pega con el golpe y no tiembla."""
    y = np.empty_like(x)
    acc = x[..., 0] * 0
    for i in range(x.shape[-1]):
        v = x[..., i]
        a = np.where(v > acc, sube, baja)
        acc = acc + a * (v - acc)
        y[..., i] = acc
    return y


def b64(arr, dtype):
    return base64.b64encode(np.ascontiguousarray(arr, dtype=dtype).tobytes()).decode("ascii")


def ajustar(x, n):
    """Corta o rellena al número exacto de cuadros."""
    if x.shape[-1] >= n:
        return x[..., :n]
    pad = [(0, 0)] * (x.ndim - 1) + [(0, n - x.shape[-1])]
    return np.pad(x, pad, mode="edge")


def cortes_novedad(X, n_cortes, separacion):
    """Dónde cambia la canción: picos de novedad sobre la matriz de autosimilitud (Foote).

    Se hace a mano con numpy en lugar de librosa.segment.agglomerative porque esa
    usa scikit-learn, y el Control de aplicaciones de Windows bloquea sus DLL.
    """
    n = X.shape[1]
    if n < 4 or n_cortes < 1:
        return []
    Z = X / (np.linalg.norm(X, axis=0, keepdims=True) + 1e-9)
    S = Z.T @ Z
    L = max(2, min(8, n // 4))
    sign = np.sign(np.arange(-L, L) + 0.5)
    kernel = np.outer(sign, sign) * np.exp(-((np.arange(-L, L) + 0.5) / L) ** 2)[:, None] \
        * np.exp(-((np.arange(-L, L) + 0.5) / L) ** 2)[None, :]
    Sp = np.pad(S, L, mode="edge")
    nov = np.array([(Sp[i:i + 2 * L, i:i + 2 * L] * kernel).sum() for i in range(n)])
    nov[:2] = nov[-2:] = 0
    cortes = []
    for i in np.argsort(nov)[::-1]:
        if nov[i] <= 0 or len(cortes) >= n_cortes:
            break
        if all(abs(i - c) >= separacion for c in cortes):
            cortes.append(int(i))
    return sorted(cortes)


def secciones(mono, rms, n_cuadros):
    """Parte la canción en bloques parecidos (estrofa, coro, puente...) y les da una intensidad.

    Los cortes salen de comparar armonía y timbre por compás; la intensidad es la
    energía media del bloque comparada con el resto: el bloque más fuerte vale 1.
    """
    dur = len(mono) / SR
    hop = 512
    chroma = librosa.feature.chroma_cqt(y=mono, sr=SR, hop_length=hop)
    mfcc = librosa.feature.mfcc(y=mono, sr=SR, hop_length=hop, n_mfcc=13)
    feats = np.vstack([librosa.util.normalize(chroma, axis=1), librosa.util.normalize(mfcc, axis=1)])
    # Promedio por ventanas de ~2 s para que los cortes no caigan a media frase.
    win = max(1, int(2.0 * SR / hop))
    pooled = np.stack([feats[:, i:i + win].mean(1) for i in range(0, feats.shape[1], win)], 1)
    k = int(np.clip(round(dur / 16), 2, 14))
    paso = win * hop / SR  # segundos por ventana
    bounds = cortes_novedad(pooled, k - 1, int(np.ceil(8.0 / paso)))
    times = sorted(set([0.0] + [b * paso for b in bounds] + [dur]))
    out = []
    for a, b in zip(times[:-1], times[1:]):
        if b - a < 1.0:
            continue
        i, j = int(a * FPS), max(int(a * FPS) + 1, int(b * FPS))
        out.append({"inicio": round(a, 3), "fin": round(b, 3), "e": float(rms[i:min(j, n_cuadros)].mean())})
    es = np.array([s["e"] for s in out])
    lo, hi = es.min(), es.max()
    for s in out:
        s["intensidad"] = round(float((s.pop("e") - lo) / max(hi - lo, 1e-9)), 3)
    if out:
        out[0]["inicio"], out[-1]["fin"] = 0.0, round(dur, 3)
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    folder = Path(sys.argv[1]).resolve()
    path = buscar_cancion(folder)
    print(f"Leyendo {path.name}…", flush=True)
    y = cargar(path)
    mono = librosa.to_mono(y)
    dur = len(mono) / SR
    n = int(np.ceil(dur * FPS))

    print("Espectro…", flush=True)
    S = np.abs(librosa.stft(mono, n_fft=4096, hop_length=HOP, center=True)) ** 2
    mel = librosa.feature.melspectrogram(S=S, sr=SR, n_mels=N_BANDAS, fmin=30, fmax=16000)
    db = librosa.power_to_db(mel, ref=np.max)
    # Cada banda contra sí misma (si no, los agudos casi no se mueven), pero con un
    # poco del nivel general para que una parte suave se vea suave.
    por_banda = np.stack([normalizar(b) for b in db])
    general = normalizar(db.mean(0))
    bandas = suavizar(ajustar(por_banda * (0.55 + 0.45 * general), n))

    def rango(f0, f1):
        freqs = librosa.mel_frequencies(n_mels=N_BANDAS, fmin=30, fmax=16000)
        sel = (freqs >= f0) & (freqs < f1)
        return suavizar(ajustar(normalizar(db[sel].mean(0), 5, 99), n))

    graves, medios, agudos = rango(30, 160), rango(160, 2000), rango(2000, 16000)
    rms = librosa.feature.rms(y=mono, frame_length=2048, hop_length=HOP)[0]
    rms = suavizar(ajustar(normalizar(rms, 2, 99.5), n), 0.5, 0.08)

    print("Ritmo…", flush=True)
    env = librosa.onset.onset_strength(y=mono, sr=SR, hop_length=HOP)
    golpe = ajustar(normalizar(env, 50, 99.5), n)
    golpe = suavizar(golpe, 0.9, 0.18)
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=SR, hop_length=HOP, units="time")
    tempo, beats = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=HOP, units="time")
    tempo = float(np.atleast_1d(tempo)[0])
    # Primer tiempo del compás: el de cada grupo de 4 con más graves.
    compases = []
    if len(beats) >= 4:
        fuerza = [graves[min(int(b * FPS), n - 1)] for b in beats]
        fase = int(np.argmax([np.mean(fuerza[k::4]) for k in range(4)]))
        compases = [round(float(b), 3) for b in beats[fase::4]]

    print("Forma de onda…", flush=True)
    peak = np.abs(mono).max() or 1.0
    span = 2048
    padded = np.pad(mono, (span, span))
    idx = (np.arange(n) * HOP + span)[:, None] + np.linspace(-span // 2, span // 2, N_ONDA).astype(int)[None, :]
    # Un suavizado ligero antes de diezmar: sin él la línea sale con picos de agudos.
    smooth = np.convolve(padded, np.ones(9) / 9, mode="same")
    # Contra el percentil 99.5 y no contra el pico: si no, un solo golpe fuerte aplana toda la línea.
    ref = np.percentile(np.abs(smooth), 99.5) or peak
    onda = np.clip(smooth[idx] / ref * 110, -127, 127)

    print("Secciones…", flush=True)
    secs = secciones(mono, rms, n)

    voz = np.zeros(n)
    voz_path = folder / "voz.wav"
    if voz_path.exists():
        print("Voz separada…", flush=True)
        v, _ = librosa.load(voz_path, sr=SR, mono=True)
        vr = librosa.feature.rms(y=v, frame_length=2048, hop_length=HOP)[0]
        voz = suavizar(ajustar(normalizar(vr, 10, 99), n), 0.4, 0.06)

    bins = 3000
    resumen = [round(float(np.abs(c).max() / peak), 3) for c in np.array_split(mono, bins)]

    data = {
        "version": 1,
        "fps": FPS,
        "duracion": round(dur, 3),
        "archivo": path.name,
        "tempo": round(tempo, 2),
        "beats": [round(float(b), 3) for b in beats],
        "compases": compases,
        "golpes": [round(float(o), 3) for o in onsets],
        "secciones": secs,
        "cuadros": n,
        "bandas": {"n": N_BANDAS, "datos": b64(bandas.T * 255, np.uint8)},
        "onda": {"n": N_ONDA, "datos": b64(onda, np.int8)},
        "energia": {k: b64(v * 255, np.uint8) for k, v in
                    {"rms": rms, "graves": graves, "medios": medios, "agudos": agudos,
                     "golpe": golpe, "voz": voz}.items()},
        "resumen": resumen,
    }
    out = folder / "analisis.json"
    out.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"Listo: {out} ({dur:.1f} s, {tempo:.0f} BPM, {len(beats)} beats, {len(secs)} secciones)")
    for s in secs:
        barra = "█" * int(s["intensidad"] * 20)
        print(f"  {s['inicio']:7.2f} – {s['fin']:7.2f}  {barra}")


if __name__ == "__main__":
    main()
