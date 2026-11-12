// Motor visual: dibuja un cuadro del video a partir de un instante t.
//
// Todo sale de analisis.json (ondas), letra.json (tiempos) y estilo (colores, tipo
// de onda...). No hay animaciones "en vivo": cada cuadro es una función pura de t,
// así render.py puede saltar a cualquier segundo y sale igual que en la vista previa.
//
//   const m = new Motor(canvas, escala);
//   await m.cargar(analisis, letra, estilo, imagen);
//   m.dibujar(t);

(function () {
  const W = 1920, H = 1080;
  const SALIDA = 0.22;  // segundos que tarda un verso en irse

  const ESTILO_BASE = {
    titulo: '', artista: '',
    onda: 'barras',            // barras | linea | circulo | olas
    fondo1: '#07060d', fondo2: '#1d1838', acento: '#ff5fa2', acento2: '#7c6cff', texto: '#ffffff',
    fuente: 'Unbounded', mayusculas: false,
    tamLetra: 74, letraY: 0.40, ondaY: 0.76,
    modoLetra: 'karaoke',      // karaoke | verso
    retener: 1.2,              // segundos que se queda el verso después de cantarlo
    sensibilidad: 1.0, brillo: 1.0, golpe: 1.0,
    particulas: 120, grano: 0.2, vineta: 0.6,  // grano alto = ruido que los codificadores (y YouTube) embarran
    imagen: '', oscurecer: 0.6,
    mostrarTitulo: true, fundidoFinal: 2.0,
    // Portada estilo Spotify: la carátula con sombra y, de fondo, ella misma desenfocada
    // con un degradado de su color.
    portada: '', portadaPos: 'izquierda',   // izquierda | centro | no
    portadaTam: 600, fondoPortada: 0.6,     // cuánto se ve la portada desenfocada atrás (0–1)
    mostrarInfo: true, leyenda: '',         // título, artista y leyenda fijos bajo la portada
  };

  const PESOS = { 'Unbounded': 700, 'Playfair Display': 700, 'Montserrat': 800, 'Bebas Neue': 400,
    'Cormorant Garamond': 600, 'Space Grotesk': 700, 'Caveat': 700, 'Inter': 700 };

  function dec(b64, signed) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return signed ? new Int8Array(u.buffer) : u;
  }

  function rng(seed) { // mulberry32: mismo resultado en cada corrida
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const easeOut = x => 1 - Math.pow(1 - clamp(x), 3);
  const easeInOut = x => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

  function hsl2hex(h, s, l) {
    const f = n => {
      const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }

  // Colores sacados de la portada: el tono que más ocupa (fondo) y el más vivo (acento).
  function paleta(img) {
    const n = 64, c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data, cubos = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
      if (l < 0.06 || l > 0.97) continue;
      const key = s < 0.12 ? 'gris' : Math.floor(h / 24);
      const b = cubos.get(key) || { n: 0, h: 0, s: 0, l: 0, sx: 0, sy: 0 };
      b.n++; b.s += s; b.l += l;
      b.sx += Math.cos(h * Math.PI / 180) * s; b.sy += Math.sin(h * Math.PI / 180) * s;
      cubos.set(key, b);
    }
    const lista = [...cubos.entries()].map(([k, b]) => ({
      k, n: b.n, s: b.s / b.n, l: b.l / b.n,
      h: ((Math.atan2(b.sy, b.sx) * 180 / Math.PI) + 360) % 360,
    }));
    const colores = lista.filter(x => x.k !== 'gris');
    if (!colores.length) return null;
    const dom = colores.reduce((a, b) => (b.n * (0.3 + b.s) > a.n * (0.3 + a.s) ? b : a));
    const vivos = colores.filter(x => x.n > n * n * 0.01);
    const viv = (vivos.length ? vivos : colores).reduce((a, b) => (b.s * Math.sqrt(b.n) > a.s * Math.sqrt(a.n) ? b : a));
    return {
      fondo1: hsl2hex(dom.h, Math.min(0.35, dom.s), 0.07),
      fondo2: hsl2hex(dom.h, Math.min(0.45, dom.s + 0.1), 0.28),
      acento: hsl2hex(viv.h, Math.max(0.55, viv.s), 0.62),
      acento2: hsl2hex(dom.h, Math.max(0.4, dom.s), 0.72),
      texto: hsl2hex(dom.h, 0.35, 0.96),
    };
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }

  // Última posición de arr con arr[i] <= t (arr ordenado), o -1.
  function antes(arr, t) {
    let lo = 0, hi = arr.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  }

  class Motor {
    constructor(canvas, escala = 1) {
      this.canvas = canvas;
      this.escala = escala;
      canvas.width = Math.round(W * escala);
      canvas.height = Math.round(H * escala);
      this.ctx = canvas.getContext('2d');
      this.layouts = new Map();
    }

    ponerEscala(escala) {
      this.escala = escala;
      this.canvas.width = Math.round(W * escala);
      this.canvas.height = Math.round(H * escala);
    }

    async cargar(analisis, letra, estilo, imagen) {
      const a = analisis;
      this.a = a;
      this.fps = a.fps;
      this.n = a.cuadros;
      this.duracion = a.duracion;
      this.nb = a.bandas.n;
      this.bandas = dec(a.bandas.datos);
      this.no = a.onda.n;
      this.ondaDatos = dec(a.onda.datos, true);
      this.e = {};
      for (const k in a.energia) this.e[k] = dec(a.energia[k]);
      this.beats = a.beats;
      this.compases = a.compases.length ? a.compases : a.beats.filter((_, i) => i % 4 === 0);
      this.secciones = a.secciones;
      this.bufB = new Float32Array(this.nb);
      this.bufO = new Float32Array(this.no);
      // Distancia recorrida: la integral de la energía. Los diseños que «viajan» (estrellas,
      // burbujas, galaxia) avanzan más rápido cuando la canción sube, y sigue siendo función de t.
      this.recorrido = new Float32Array(this.n);
      for (let i = 1; i < this.n; i++) this.recorrido[i] = this.recorrido[i - 1] + (0.25 + 1.5 * this.e.rms[i] / 255) / this.fps;
      this.imagen = imagen || null;
      this.ponerLetra(letra);
      this.ponerEstilo(estilo);
      this.prepararTexturas();
    }

    // La portada y su versión desenfocada para el fondo (se calcula una vez).
    ponerPortada(img) {
      this.portada = img || null;
      this.portadaBlur = null;
      if (!img) return;
      const c = document.createElement('canvas');
      c.width = 480; c.height = 270;
      const g = c.getContext('2d');
      const k = Math.max(c.width / img.width, c.height / img.height) * 1.25;
      g.filter = 'blur(18px) saturate(1.3)';
      g.drawImage(img, (c.width - img.width * k) / 2, (c.height - img.height * k) / 2, img.width * k, img.height * k);
      this.portadaBlur = c;
    }

    // Dónde va cada cosa según la portada: carátula, columna de letra y franja de ondas.
    marco() {
      const s = this.s;
      if (!this.portada || s.portadaPos === 'no') return { tx: W / 2, tw: W * 0.8, x0: 150, x1: W - 150 };
      const tam = s.portadaTam;
      if (s.portadaPos === 'centro') {
        return { portada: { cx: W / 2, cy: H * 0.42, tam }, tx: W / 2, tw: W * 0.8, x0: 150, x1: W - 150 };
      }
      const cx = 140 + tam / 2, x0 = cx + tam / 2 + 90, x1 = W - 110;
      // Con título y artista debajo, la carátula sube para dejarles lugar.
      const cy = s.mostrarInfo && s.titulo ? Math.min(H * 0.47, (H - 230) / 2 + 20) : H * 0.47;
      return { portada: { cx, cy, tam }, tx: (x0 + x1) / 2, tw: x1 - x0, x0, x1 };
    }

    ponerLetra(letra) {
      this.lineas = (letra && letra.lineas) ? letra.lineas : [];
      this.layouts.clear();
    }

    ponerEstilo(estilo) {
      this.s = Object.assign({}, ESTILO_BASE, estilo || {});
      this.layouts.clear();
    }

    prepararTexturas() {
      const r = rng(7);
      this.granos = [0, 1, 2, 3].map(() => {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const g = c.getContext('2d'), img = g.createImageData(256, 256);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = r() * 255;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        return this.ctx.createPattern(c, 'repeat');
      });
      const pr = rng(11);
      this.puntos = Array.from({ length: 400 }, () => ({
        x: pr() * W, y: pr() * H, vx: (pr() - 0.5) * 16, vy: -4 - pr() * 18,
        r: 0.8 + pr() * 2.6, ph: pr() * Math.PI * 2, tw: 0.5 + pr() * 2,
      }));
    }

    // ---------- Lectura del análisis ----------

    cuadro(t) {
      const f = clamp(t * this.fps, 0, this.n - 1);
      const i = Math.floor(f);
      return [i, Math.min(i + 1, this.n - 1), f - i];
    }

    energia(nombre, t) {
      const arr = this.e[nombre];
      if (!arr) return 0;
      const [i, j, fr] = this.cuadro(t);
      return (arr[i] * (1 - fr) + arr[j] * fr) / 255;
    }

    bandasEn(t, out = this.bufB) {
      const [i, j, fr] = this.cuadro(t), nb = this.nb, B = this.bandas;
      for (let k = 0; k < nb; k++) out[k] = (B[i * nb + k] * (1 - fr) + B[j * nb + k] * fr) / 255;
      return out;
    }

    ondaEn(t, out = this.bufO) {
      const [i, j, fr] = this.cuadro(t), no = this.no, O = this.ondaDatos;
      for (let k = 0; k < no; k++) out[k] = (O[i * no + k] * (1 - fr) + O[j * no + k] * fr) / 127;
      return out;
    }

    avance(t) {
      const [i, j, fr] = this.cuadro(t);
      return this.recorrido[i] * (1 - fr) + this.recorrido[j] * fr + Math.max(0, t - this.duracion) * 0.25;
    }

    intensidad(t) {
      // Intensidad de la sección, con cruce suave de 1.5 s entre secciones.
      const S = this.secciones;
      if (!S.length) return 0.5;
      let k = S.findIndex(s => t < s.fin);
      if (k < 0) k = S.length - 1;
      const s = S[k];
      let v = s.intensidad;
      const X = 0.75;
      if (k > 0 && t - s.inicio < X) {
        const m = (t - s.inicio + X) / (2 * X);
        v = S[k - 1].intensidad + (v - S[k - 1].intensidad) * easeInOut(m);
      } else if (k < S.length - 1 && s.fin - t < X) {
        const m = (t - (s.fin - X)) / (2 * X);
        v = v + (S[k + 1].intensidad - v) * easeInOut(m);
      }
      return v;
    }

    destello(lista, t, caida) {
      const k = antes(lista, t);
      return k < 0 ? 0 : Math.exp(-(t - lista[k]) / caida);
    }

    // ---------- Cuadro completo ----------

    dibujar(t) {
      const c = this.ctx, s = this.s;
      c.setTransform(this.escala, 0, 0, this.escala, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.shadowBlur = 0;

      const ctxT = {
        t, s,
        rms: this.energia('rms', t), graves: this.energia('graves', t), medios: this.energia('medios', t),
        agudos: this.energia('agudos', t), voz: this.energia('voz', t),
        int: this.intensidad(t),
        beat: this.destello(this.beats, t, 0.16) * s.golpe,
        compas: this.destello(this.compases, t, 0.4) * s.golpe,
      };

      this.m = this.marco();
      this.fondo(ctxT);
      if (s.particulas > 0) this.polvo(ctxT);
      const D = Motor.DISENOS || {};
      (D[s.onda] || D.barras || { dibujar: this.barras }).dibujar.call(this, ctxT);
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.shadowBlur = 0;
      this.caratula(ctxT);
      this.titulo(ctxT);
      this.letra(ctxT);
      this.acabado(ctxT);
    }

    fondo({ t, s, int, compas, graves, rms }) {
      const c = this.ctx;
      c.fillStyle = s.fondo1;
      c.fillRect(0, 0, W, H);
      if (this.imagen) {
        const im = this.imagen, z = 1.06 + 0.07 * (t / this.duracion) + 0.012 * graves;
        const k = Math.max(W / im.width, H / im.height) * z;
        const w = im.width * k, h = im.height * k;
        c.drawImage(im, (W - w) / 2, (H - h) / 2, w, h);
        c.fillStyle = hexA(s.fondo1, s.oscurecer);
        c.fillRect(0, 0, W, H);
      }
      const P = this.m.portada;
      if (P && this.portadaBlur && s.fondoPortada > 0) {
        // Como Spotify: la carátula desenfocada llena el fondo y un degradado de su color la oscurece.
        c.globalAlpha = s.fondoPortada;
        const z = 1.08 + 0.04 * Math.sin(t * 0.05);
        c.drawImage(this.portadaBlur, -W * (z - 1) / 2, -H * (z - 1) / 2, W * z, H * z);
        c.globalAlpha = 1;
        const lg = c.createLinearGradient(0, 0, W, H);
        lg.addColorStop(0, hexA(s.fondo2, 0.15));
        lg.addColorStop(0.5, hexA(s.fondo1, 0.42));
        lg.addColorStop(1, hexA(s.fondo1, 0.8));
        c.fillStyle = lg;
        c.fillRect(0, 0, W, H);
        const halo = c.createRadialGradient(P.cx, P.cy, P.tam * 0.2, P.cx, P.cy, P.tam * 1.15);
        halo.addColorStop(0, hexA(s.acento2, 0.22 + 0.18 * rms + 0.1 * compas));
        halo.addColorStop(1, hexA(s.acento2, 0));
        c.fillStyle = halo;
        c.fillRect(0, 0, W, H);
        return;
      }
      const g = c.createRadialGradient(W / 2, H * 0.48, 0, W / 2, H * 0.48, W * 0.75);
      g.addColorStop(0, hexA(s.fondo2, (this.imagen ? 0.55 : 1) * (0.55 + 0.45 * int)));
      g.addColorStop(1, hexA(s.fondo2, 0));
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      // El coro "abre" el fondo con el acento; el primer tiempo del compás lo hace latir.
      const a = (0.03 + 0.09 * int * rms + 0.07 * compas) * s.brillo;
      const g2 = c.createRadialGradient(W / 2, H * s.ondaY, 0, W / 2, H * s.ondaY, W * 0.6);
      g2.addColorStop(0, hexA(s.acento, a));
      g2.addColorStop(1, hexA(s.acento, 0));
      c.fillStyle = g2;
      c.fillRect(0, 0, W, H);
    }

    caratula({ s, graves, beat }) {
      const P = this.m.portada;
      if (!P) return;
      const c = this.ctx, im = this.portada;
      const tam = P.tam * (1 + 0.012 * graves + 0.008 * beat), x = P.cx - tam / 2, y = P.cy - tam / 2, r = 12;
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.6)';
      c.shadowBlur = 70 * this.escala;
      c.shadowOffsetY = 24 * this.escala;
      c.fillStyle = s.fondo1;
      c.beginPath();
      c.roundRect(x, y, tam, tam, r);
      c.fill();
      c.restore();
      c.save();
      c.beginPath();
      c.roundRect(x, y, tam, tam, r);
      c.clip();
      const k = tam / Math.min(im.width, im.height);
      c.drawImage(im, P.cx - im.width * k / 2, P.cy - im.height * k / 2, im.width * k, im.height * k);
      c.restore();
      if (s.mostrarInfo && s.titulo) this.info(P);
    }

    // Título, artista y leyenda bajo la carátula, alineados a su orilla (como «reproduciendo ahora»).
    info(P) {
      const c = this.ctx, s = this.s;
      const izq = s.portadaPos === 'izquierda';
      const x = izq ? P.cx - P.tam / 2 : P.cx;
      const y = P.cy + P.tam / 2 + 62;
      const ancho = P.tam;
      c.save();
      c.textAlign = izq ? 'left' : 'center';
      c.textBaseline = 'alphabetic';
      c.shadowColor = 'rgba(0,0,0,0.5)';
      c.shadowBlur = 14 * this.escala;
      c.fillStyle = s.texto;
      let px = 46;
      c.font = this.fuente(px);
      while (c.measureText(s.titulo).width > ancho && px > 24) c.font = this.fuente(--px);
      c.fillText(s.titulo, x, y);
      if (s.artista) {
        c.globalAlpha = 0.85;
        c.font = `500 30px "${s.fuente}", system-ui, sans-serif`;
        c.fillText(s.artista, x, y + 46);
      }
      if (s.leyenda) {
        c.globalAlpha = 0.9;
        c.fillStyle = s.acento;
        c.font = `600 19px "${s.fuente}", system-ui, sans-serif`;
        c.letterSpacing = '3px';
        c.fillText(s.leyenda.toUpperCase(), x, y + 86);
        c.letterSpacing = '0px';
      }
      c.restore();
    }

    polvo({ t, s, agudos, medios, int }) {
      const c = this.ctx, n = Math.min(s.particulas | 0, this.puntos.length);
      c.fillStyle = s.texto;
      for (let i = 0; i < n; i++) {
        const p = this.puntos[i];
        const x = ((p.x + p.vx * t + Math.sin(t * 0.3 + p.ph) * 24) % W + W) % W;
        const y = ((p.y + p.vy * t * (0.7 + 0.6 * int)) % H + H) % H;
        const tw = 0.5 + 0.5 * Math.sin(t * p.tw + p.ph);
        c.globalAlpha = (0.08 + 0.35 * medios) * tw;
        c.beginPath();
        c.arc(x, y, p.r * (1 + agudos * 1.3), 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
    }

    resplandor(color, fuerza) {
      const c = this.ctx;
      c.shadowColor = color;
      c.shadowBlur = fuerza * this.s.brillo * this.escala;
    }

    barras({ s, graves, int, beat }) {
      const c = this.ctx, b = this.bandasEn(this._t = arguments[0].t);
      const nb = this.nb, total = nb * 2, x0 = this.m.x0, ancho = this.m.x1 - this.m.x0;
      const paso = ancho / total, bw = paso * 0.62, y = H * s.ondaY;
      const maxH = 230 * s.sensibilidad * (0.7 + 0.4 * int);
      const g = c.createLinearGradient(0, y - maxH, 0, y);
      g.addColorStop(0, s.acento2);
      g.addColorStop(1, s.acento);
      c.fillStyle = g;
      this.resplandor(s.acento, 14 + 26 * graves + 20 * beat);
      const alturas = new Float32Array(total);
      for (let k = 0; k < total; k++) {
        const band = k < nb ? nb - 1 - k : k - nb; // graves al centro, agudos a las orillas
        alturas[k] = 5 + Math.pow(b[band], 1.5) * maxH;
      }
      c.beginPath();
      for (let k = 0; k < total; k++) {
        const x = x0 + k * paso + (paso - bw) / 2;
        c.roundRect(x, y - alturas[k], bw, alturas[k], bw / 2);
      }
      c.fill();
      c.shadowBlur = 0;
      // Reflejo abajo, más tenue.
      c.globalAlpha = 0.22;
      c.beginPath();
      for (let k = 0; k < total; k++) {
        const x = x0 + k * paso + (paso - bw) / 2;
        c.roundRect(x, y + 6, bw, alturas[k] * 0.45, bw / 2);
      }
      c.fillStyle = s.acento;
      c.fill();
      c.globalAlpha = 1;
    }

    linea({ t, s, rms, graves, beat }) {
      const c = this.ctx, y0 = H * s.ondaY, x0 = this.m.x0 - 60, x1 = this.m.x1 + 60;
      const A = 320 * s.sensibilidad * (0.5 + 0.9 * rms);
      const capas = [[0, 1, 4.5, s.acento], [-2 / this.fps, 0.5, 3, s.acento2], [-5 / this.fps, 0.22, 2, s.acento2]];
      for (const [dt, alpha, ancho, color] of capas.reverse()) {
        const o = this.ondaEn(t + dt, new Float32Array(this.no));
        for (const signo of [1, -1]) {
          c.globalAlpha = alpha * (signo < 0 ? 0.3 : 1);
          c.strokeStyle = color;
          c.lineWidth = ancho * (1 + 0.5 * graves);
          c.lineJoin = c.lineCap = 'round';
          this.resplandor(color, signo > 0 ? 16 + 30 * beat : 0);
          c.beginPath();
          let px = x0, py = y0;
          for (let k = 0; k < this.no; k++) {
            const u = k / (this.no - 1);
            const taper = Math.sin(Math.PI * u); // las puntas regresan al centro
            const x = x0 + (x1 - x0) * u, y = y0 - signo * o[k] * A * taper;
            if (k === 0) c.moveTo(x, y); else c.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
            px = x; py = y;
          }
          c.lineTo(px, py);
          c.stroke();
        }
      }
      c.shadowBlur = 0;
      c.globalAlpha = 1;
    }

    circulo({ t, s, graves, beat, int }) {
      const c = this.ctx, b = this.bandasEn(t), nb = this.nb, total = nb * 2;
      const P = this.m.portada;  // con portada, los rayos salen de detrás de la carátula
      const cx = P ? P.cx : W / 2, cy = P ? P.cy : H * s.ondaY;
      const R = (P ? P.tam * 0.56 : 170) * (1 + 0.09 * graves + 0.05 * beat);
      const largo = 160 * s.sensibilidad * (0.75 + 0.4 * int);
      const giro = t * 0.04;
      c.lineCap = 'round';
      c.lineWidth = (2 * Math.PI * R / total) * 0.55;
      this.resplandor(s.acento, 14 + 24 * graves + 18 * beat);
      for (let k = 0; k < total; k++) {
        const band = k < nb ? k : total - 1 - k; // espejo: graves arriba, agudos abajo
        const v = Math.pow(b[band], 1.4);
        const ang = giro + (k / total) * Math.PI * 2 - Math.PI / 2;
        const l = 6 + v * largo;
        c.strokeStyle = k % 2 ? s.acento2 : s.acento;
        c.beginPath();
        c.moveTo(cx + Math.cos(ang) * (R + 8), cy + Math.sin(ang) * (R + 8));
        c.lineTo(cx + Math.cos(ang) * (R + 8 + l), cy + Math.sin(ang) * (R + 8 + l));
        c.stroke();
      }
      c.shadowBlur = 0;
      if (P) return;  // el centro lo tapa la carátula
      c.save();
      c.beginPath();
      c.arc(cx, cy, R, 0, Math.PI * 2);
      c.clip();
      if (this.imagen) {
        const im = this.imagen, k = (2 * R) / Math.min(im.width, im.height);
        c.translate(cx, cy);
        c.rotate(giro * 2);
        c.drawImage(im, -im.width * k / 2, -im.height * k / 2, im.width * k, im.height * k);
      } else {
        const g = c.createRadialGradient(cx, cy, 0, cx, cy, R);
        g.addColorStop(0, s.fondo2);
        g.addColorStop(1, s.fondo1);
        c.fillStyle = g;
        c.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      }
      c.restore();
      c.strokeStyle = s.acento;
      c.lineWidth = 3;
      c.globalAlpha = 0.6 + 0.4 * beat;
      c.beginPath();
      c.arc(cx, cy, R, 0, Math.PI * 2);
      c.stroke();
      c.globalAlpha = 1;
    }

    olas({ t, s, int, beat }) {
      const c = this.ctx, nb = this.nb, y0 = H * s.ondaY;
      const capas = [[0.36, 0.22, s.acento2], [0.18, 0.38, s.acento2], [0, 0.75, s.acento]];
      for (const [retraso, alpha, color] of capas) {
        const b = this.bandasEn(t - retraso, new Float32Array(nb));
        const amp = 240 * s.sensibilidad * (0.65 + 0.45 * int) * (1 - retraso);
        const pts = [];
        const N = 48;
        for (let k = 0; k <= N; k++) {
          const u = k / N;
          const band = Math.min(nb - 1, Math.floor(Math.abs(u - 0.5) * 2 * (nb - 1))); // graves al centro
          const deriva = Math.sin(u * 9 + t * 0.6 + retraso * 7) * 10;
          pts.push([u * W, y0 - Math.pow(b[band], 1.3) * amp * Math.sin(Math.PI * (0.08 + 0.84 * u)) - deriva]);
        }
        const g = c.createLinearGradient(0, y0 - amp, 0, H);
        g.addColorStop(0, hexA(color, alpha));
        g.addColorStop(1, hexA(color, 0));
        c.fillStyle = g;
        this.resplandor(color, retraso === 0 ? 10 + 18 * beat : 0);
        c.beginPath();
        c.moveTo(0, H);
        c.lineTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) {
          const [px, py] = pts[k - 1], [x, y] = pts[k];
          c.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        }
        c.lineTo(W, pts[pts.length - 1][1]);
        c.lineTo(W, H);
        c.closePath();
        c.fill();
        if (retraso === 0) {
          c.strokeStyle = hexA(color, 0.9);
          c.lineWidth = 3;
          c.stroke();
        }
      }
      c.shadowBlur = 0;
    }

    // ---------- Texto ----------

    fuente(px) {
      const f = this.s.fuente;
      return `${PESOS[f] || 700} ${px}px "${f}", system-ui, sans-serif`;
    }

    // Reparte las palabras del verso en renglones centrados (se calcula una vez por verso).
    acomodo(k) {
      const ln = this.lineas[k], s = this.s, cx = this.m.tx, maxW = this.m.tw;
      const key = `${k}|${ln.texto}|${s.fuente}|${s.tamLetra}|${s.mayusculas}|${cx}|${maxW}`;
      let L = this.layouts.get(key);
      if (L) return L;
      const c = this.ctx, px = s.tamLetra;
      c.font = this.fuente(px);
      const palabras = (ln.palabras && ln.palabras.length ? ln.palabras : ln.texto.split(/\s+/).map(t => ({ t })))
        .map((p, i) => ({ ...p, txt: s.mayusculas ? p.t.toUpperCase() : p.t, idx: i }));
      const esp = c.measureText(' ').width;
      for (const p of palabras) p.w = c.measureText(p.txt).width;
      const partir = maxW => {
        const rs = [[]];
        let ancho = 0;
        for (const p of palabras) {
          if (ancho > 0 && ancho + esp + p.w > maxW) { rs.push([]); ancho = 0; }
          rs[rs.length - 1].push(p);
          ancho += (ancho > 0 ? esp : 0) + p.w;
        }
        return rs;
      };
      // Renglones parejos: con el mismo número de renglones, el ancho más angosto posible
      // (evita una palabra sola colgando abajo).
      let renglones = partir(maxW);
      if (renglones.length > 1) {
        const total = palabras.reduce((a, p) => a + p.w + esp, 0);
        for (let m = total / renglones.length; m < maxW; m += 20) {
          const r = partir(m);
          if (r.length === renglones.length) { renglones = r; break; }
        }
      }
      const alto = px * 1.22;
      L = { px, alto: alto * renglones.length, renglones: renglones.map((r, j) => {
        const w = r.reduce((a, p) => a + p.w, 0) + esp * (r.length - 1);
        let x = cx - w / 2;
        for (const p of r) { p.x = x; x += p.w + esp; }
        return { y: j * alto, palabras: r };
      }) };
      this.layouts.set(key, L);
      return L;
    }

    // Cuándo empieza a irse el verso k. Nunca antes de que se termine de cantar (salvo que el
    // siguiente ya esté entrando), y se va justo cuando entra el siguiente: en rap los versos
    // van pegados y, si conviven en el mismo lugar, se ve un parpadeo de dos textos encimados.
    salida(k) {
      const ln = this.lineas[k], sig = this.lineas[k + 1];
      let sale = ln.fin + this.s.retener;
      if (sig) sale = Math.min(sale, sig.inicio - 0.1);
      const tope = sig ? Math.min(ln.fin, sig.inicio) : ln.fin;
      return Math.max(sale, tope - 0.12, ln.inicio + 0.4);
    }

    ventana(k) {
      const ln = this.lineas[k];
      let entra = ln.inicio - 0.35;
      // Si el anterior sigue en pantalla, el nuevo espera a que casi se haya ido.
      if (k > 0) entra = Math.max(entra, this.salida(k - 1) + SALIDA * 0.6);
      return [Math.min(entra, ln.inicio + 0.05), this.salida(k)];
    }

    letra({ t, s, voz }) {
      const c = this.ctx;
      for (let k = 0; k < this.lineas.length; k++) {
        const [entra, sale] = this.ventana(k);
        if (t < entra || t > sale + SALIDA) continue;
        const ln = this.lineas[k], L = this.acomodo(k);
        const y0 = H * s.letraY - L.alto / 2 + L.px * 0.8;
        const fuera = easeOut((t - sale) / SALIDA);
        c.font = this.fuente(L.px);
        c.textBaseline = 'alphabetic';
        let n = 0;
        for (const r of L.renglones) for (const p of r.palabras) {
          const e = easeOut((t - entra - Math.min(n++ * 0.025, 0.25)) / 0.35);
          const alpha = e * (1 - fuera);
          if (alpha <= 0.002) continue;
          const y = y0 + r.y + 26 * (1 - e) - 34 * fuera;
          // Progreso de la palabra cantada: 0 antes de su inicio, 1 al terminarla.
          let prog = 1;
          if (s.modoLetra === 'karaoke' && p.i != null) prog = clamp((t - p.i) / Math.max(p.f - p.i, 0.08));
          c.shadowColor = 'rgba(0,0,0,0.55)';
          c.shadowBlur = 18 * this.escala;
          c.globalAlpha = alpha;
          c.fillStyle = s.modoLetra === 'karaoke' ? hexA(s.texto, 0.38) : s.texto;
          if (prog < 1 || s.modoLetra !== 'karaoke') c.fillText(p.txt, p.x, y);
          if (s.modoLetra === 'karaoke' && prog > 0) {
            c.save();
            if (prog < 1) { c.beginPath(); c.rect(p.x - 4, y - L.px * 1.2, (p.w + 8) * prog, L.px * 1.8); c.clip(); }
            c.fillStyle = s.texto;
            c.shadowColor = s.acento;
            c.shadowBlur = (10 + 34 * voz) * s.brillo * this.escala;
            c.fillText(p.txt, p.x, y);
            c.restore();
          }
        }
      }
      c.shadowBlur = 0;
      c.globalAlpha = 1;
    }

    titulo({ t, s }) {
      if (!s.mostrarTitulo || !s.titulo) return;
      const primera = this.lineas.length ? this.lineas[0].inicio : 8;
      const fin = Math.min(7, primera - 0.6);
      if (fin < 2 || t > fin + 0.1) return;
      const a = easeOut((t - 0.3) / 0.9) * (1 - easeOut((t - (fin - 0.8)) / 0.8));
      if (a <= 0) return;
      const c = this.ctx;
      c.globalAlpha = a;
      c.textAlign = 'center';
      c.fillStyle = s.texto;
      c.shadowColor = s.acento;
      c.shadowBlur = 30 * s.brillo * this.escala;
      c.font = this.fuente(104);
      c.fillText(s.mayusculas ? s.titulo.toUpperCase() : s.titulo, this.m.tx, H * s.letraY + 10 - 12 * (1 - a));
      c.shadowBlur = 0;
      if (s.artista) {
        c.globalAlpha = a * 0.75;
        c.font = `500 34px "${s.fuente}", system-ui, sans-serif`;
        c.letterSpacing = '6px';
        c.fillText(s.artista.toUpperCase(), this.m.tx, H * s.letraY + 80);
        c.letterSpacing = '0px';
      }
      c.textAlign = 'left';
      c.globalAlpha = 1;
    }

    acabado({ t, s }) {
      const c = this.ctx;
      if (s.vineta > 0) {
        const g = c.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.72);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, `rgba(0,0,0,${0.85 * s.vineta})`);
        c.fillStyle = g;
        c.fillRect(0, 0, W, H);
      }
      if (s.grano > 0) {
        const f = Math.floor(t * this.fps);
        const r = rng(f + 1);
        c.save();
        c.globalCompositeOperation = 'overlay';
        c.globalAlpha = 0.16 * s.grano;
        c.translate(-r() * 256, -r() * 256);
        c.fillStyle = this.granos[f % 4];
        c.fillRect(0, 0, W + 256, H + 256);
        c.restore();
      }
      // Entrada desde negro y fundido al final.
      const negro = Math.max(1 - t / 0.6, s.fundidoFinal > 0 ? clamp((t - (this.duracion - s.fundidoFinal)) / s.fundidoFinal) : 0);
      if (negro > 0) {
        c.fillStyle = `rgba(0,0,0,${clamp(negro)})`;
        c.fillRect(0, 0, W, H);
      }
    }
  }

  Motor.W = W;
  Motor.H = H;
  Motor.ESTILO_BASE = ESTILO_BASE;
  Motor.PESOS = PESOS;
  Motor.paleta = paleta;
  Motor.util = { hexA, rng, clamp, antes, easeOut };
  window.Motor = Motor;
})();
