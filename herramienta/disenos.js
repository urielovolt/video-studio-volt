// Catálogo de diseños de onda. Cada uno dibuja un cuadro como función pura del tiempo t
// (nada de simulaciones paso a paso), para que render.py pueda saltar a cualquier segundo.
//
// Ideas tomadas (no código) de proyectos abiertos:
//   partículas: tsParticles / particles.js (MIT) — aquí cada chispa sale de un golpe detectado
//               y su posición se calcula con física cerrada desde ese instante.
//   fuego:      el «Doom fire» clásico — aquí son lenguas con ruido + brasas cíclicas.
//   crestas:    la portada de Unknown Pleasures (Joy Division) y sus visualizadores.
//   neón, anillos, galaxia, hiperespacio: efectos típicos de Milkdrop/butterchurn (MIT).
//
// Cada diseño: { nombre, grupo, acomodo: {ondaY, letraY}, centro: bool, dibujar(o) }
// - centro: se dibuja alrededor de la carátula si hay portada (o del centro si no).
// - dibujar se llama con this = el Motor; o = {t, s, rms, graves, medios, agudos, voz, int, beat, compas}.

(function () {
  const { W, H } = Motor;
  const U = Motor.util;
  const { hexA, rng, clamp, antes } = U;
  const TAU = Math.PI * 2;

  // Banda (0 = graves) para una posición u en [0,1] con los graves al centro.
  const bandaEspejo = (u, nb) => Math.min(nb - 1, Math.floor(Math.abs(u - 0.5) * 2 * (nb - 1)));

  function centro(m, s) {
    const P = m.m.portada;
    return P ? { cx: P.cx, cy: P.cy, r: P.tam * 0.5, P } : { cx: W / 2, cy: H * s.ondaY, r: 150, P: null };
  }

  // Curva suave que pasa cerca de los puntos (puntos medios + cuadráticas).
  function curva(c, pts, cerrar) {
    const n = pts.length;
    if (cerrar) {
      const m0 = [(pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2];
      c.moveTo(m0[0], m0[1]);
      for (let k = 0; k < n; k++) {
        const p = pts[k], q = pts[(k + 1) % n];
        c.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      }
      c.closePath();
    } else {
      c.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < n - 1; k++) {
        const p = pts[k], q = pts[k + 1];
        c.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      }
      c.lineTo(pts[n - 1][0], pts[n - 1][1]);
    }
  }

  const DISENOS = {
    barras:  { nombre: 'Barras', grupo: 'Clásicos', acomodo: { ondaY: 0.76, letraY: 0.40 }, dibujar(o) { this.barras(o); } },
    linea:   { nombre: 'Osciloscopio', grupo: 'Clásicos', acomodo: { ondaY: 0.66, letraY: 0.34 }, dibujar(o) { this.linea(o); } },
    circulo: { nombre: 'Círculo', grupo: 'Clásicos', centro: true, acomodo: { ondaY: 0.42, letraY: 0.86 }, dibujar(o) { this.circulo(o); } },
    olas:    { nombre: 'Olas', grupo: 'Clásicos', acomodo: { ondaY: 0.82, letraY: 0.42 }, dibujar(o) { this.olas(o); } },

    // ---------- Partículas: cada golpe de la canción lanza una ráfaga de chispas ----------
    particulas: {
      nombre: 'Partículas', grupo: 'Energía', acomodo: { ondaY: 0.80, letraY: 0.38 },
      dibujar({ t, s, int }) {
        const c = this.ctx, G = this.a.golpes, x0 = this.m.x0, x1 = this.m.x1, y0 = H * s.ondaY;
        const vida = 2.4;
        c.globalCompositeOperation = 'lighter';
        for (let k = antes(G, t); k >= 0 && t - G[k] < vida; k--) {
          const dt = t - G[k], r = rng(k * 7919 + 13);
          const fuerza = this.energia('golpe', G[k]);
          const n = 18 + Math.floor(fuerza * 44 * (0.6 + 0.6 * int));
          const arrastre = (1 - Math.exp(-dt * 1.8)) / 1.8; // frenado del aire, integrado
          const vivo = 1 - dt / vida;
          for (let i = 0; i < n; i++) {
            const x = x0 + (x1 - x0) * r();
            const ang = -Math.PI / 2 + (r() - 0.5) * 1.9;
            const v = (140 + r() * 420) * (0.4 + fuerza) * s.sensibilidad;
            const px = x + Math.cos(ang) * v * arrastre;
            const py = y0 + Math.sin(ang) * v * arrastre + 70 * dt * dt;
            const tam = (1.8 + r() * 3.6) * (0.9 + fuerza);
            c.globalAlpha = vivo * vivo;
            c.fillStyle = r() < 0.5 ? s.acento : s.acento2;
            c.beginPath();
            c.arc(px, py, tam, 0, TAU);
            c.fill();
          }
        }
        // Una línea de puntos que respira con el espectro: de ahí salen las chispas.
        const b = this.bandasEn(t), N = 90;
        c.fillStyle = s.acento;
        for (let i = 0; i < N; i++) {
          const u = i / (N - 1), v = b[bandaEspejo(u, this.nb)];
          c.globalAlpha = 0.35 + 0.65 * v;
          c.beginPath();
          c.arc(x0 + (x1 - x0) * u, y0 - v * 60 * s.sensibilidad, 1.5 + v * 3, 0, TAU);
          c.fill();
        }
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
      },
    },

    // ---------- Fuego: lenguas por banda y brasas que suben ----------
    fuego: {
      nombre: 'Fuego', grupo: 'Energía', acomodo: { ondaY: 0.94, letraY: 0.36 },
      dibujar({ t, s, int }) {
        const c = this.ctx, b = this.bandasEn(t), x0 = this.m.x0 - 40, x1 = this.m.x1 + 40, base = H * s.ondaY;
        const cols = 34, w = (x1 - x0) / cols;
        c.globalCompositeOperation = 'lighter';
        for (let col = 0; col < cols; col++) {
          const v = Math.pow(b[bandaEspejo((col + 0.5) / cols, this.nb)], 1.25);
          const h = 40 + v * 330 * s.sensibilidad * (0.7 + 0.45 * int);
          const xc = x0 + (col + 0.5) * w;
          const g = c.createLinearGradient(0, base, 0, base - h);
          g.addColorStop(0, 'rgba(255,244,210,0.85)');
          g.addColorStop(0.22, 'rgba(255,176,48,0.7)');
          g.addColorStop(0.6, 'rgba(232,64,20,0.42)');
          g.addColorStop(1, 'rgba(120,20,10,0)');
          c.fillStyle = g;
          const izq = [], der = [], P = 9;
          for (let j = 0; j <= P; j++) {
            const f = j / P, y = base - h * f;
            const vaiven = (Math.sin(t * 9 + col * 1.7 + j * 0.9) * 0.4 + Math.sin(t * 5.3 + col * 2.3 + j * 0.4) * 0.25) * w * f;
            const ancho = w * 0.95 * (1 - Math.pow(f, 1.4));
            izq.push([xc + vaiven - ancho, y]);
            der.push([xc + vaiven + ancho, y]);
          }
          c.beginPath();
          curva(c, izq.concat(der.reverse()), true);
          c.fill();
        }
        // Brasas: cada una sube en un ciclo propio; brilla más donde la banda está fuerte.
        if (!this._brasas) {
          const r = rng(99);
          this._brasas = Array.from({ length: 140 }, () => ({ u: r(), per: 1.3 + r() * 1.8, off: r(), alto: 220 + r() * 420, tam: 1 + r() * 2.4, ph: r() * TAU }));
        }
        for (const e of this._brasas) {
          const f = ((t / e.per + e.off) % 1);
          const v = b[bandaEspejo(e.u, this.nb)];
          const x = x0 + (x1 - x0) * e.u + Math.sin(t * 2 + e.ph) * 18 * f;
          const y = base - 30 - f * e.alto * (0.6 + v);
          c.globalAlpha = (1 - f) * (0.25 + 0.75 * v);
          c.fillStyle = f < 0.4 ? '#ffd27a' : '#ff7a2a';
          c.beginPath();
          c.arc(x, y, e.tam, 0, TAU);
          c.fill();
        }
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
      },
    },

    // ---------- Puntos LED: ecualizador de matriz con picos que caen ----------
    puntos: {
      nombre: 'Matriz LED', grupo: 'Retro', acomodo: { ondaY: 0.88, letraY: 0.30 },
      dibujar({ t, s }) {
        const c = this.ctx, x0 = this.m.x0, x1 = this.m.x1, y0 = H * s.ondaY;
        const cols = 36, filas = 15, paso = (x1 - x0) / cols, rad = paso * 0.3;
        const b = this.bandasEn(t, new Float32Array(this.nb));
        const pasado = [0.12, 0.24, 0.36, 0.48].map(d => this.bandasEn(t - d, new Float32Array(this.nb)));
        const encendidos = Array.from({ length: filas }, () => []), apagados = [], picos = [];
        for (let col = 0; col < cols; col++) {
          const bi = bandaEspejo((col + 0.5) / cols, this.nb);
          const v = Math.min(1, b[bi] * s.sensibilidad);
          const pico = Math.min(1, Math.max(v, ...pasado.map((p, k) => p[bi] * s.sensibilidad * (1 - 0.08 * (k + 1)))));
          const lit = Math.round(v * filas), pk = Math.min(filas - 1, Math.round(pico * filas));
          const x = x0 + (col + 0.5) * paso;
          for (let f = 0; f < filas; f++) (f < lit ? encendidos[f] : apagados).push([x, y0 - f * paso]);
          if (pk >= lit) picos.push([x, y0 - pk * paso]);
        }
        const pinta = (lista, color, a, glow) => {
          if (!lista.length) return;
          c.globalAlpha = a;
          c.fillStyle = color;
          this.resplandor(color, glow);
          c.beginPath();
          for (const [x, y] of lista) { c.moveTo(x + rad, y); c.arc(x, y, rad, 0, TAU); }
          c.fill();
        };
        pinta(apagados, s.texto, 0.07, 0);
        for (let f = 0; f < filas; f++) pinta(encendidos[f], f / filas > 0.66 ? s.acento2 : s.acento, 0.95, 10);
        pinta(picos, s.texto, 0.9, 8);
        c.shadowBlur = 0;
        c.globalAlpha = 1;
      },
    },

    // ---------- Crestas: líneas apiladas con el espectro de los últimos instantes ----------
    crestas: {
      nombre: 'Crestas', grupo: 'Retro', acomodo: { ondaY: 0.86, letraY: 0.28 },
      dibujar({ t, s }) {
        const c = this.ctx, x0 = this.m.x0, x1 = this.m.x1, y0 = H * s.ondaY;
        const L = 22, alto = 380, paso = alto / L, N = 70, buf = new Float32Array(this.nb);
        c.lineJoin = 'round';
        for (let k = L - 1; k >= 0; k--) { // de atrás (más viejo, arriba) hacia adelante
          const b = this.bandasEn(t - k * 0.055, buf), y = y0 - k * paso;
          const pts = [];
          for (let i = 0; i < N; i++) {
            const u = i / (N - 1), env = Math.exp(-Math.pow((u - 0.5) / 0.2, 2));
            const ruido = Math.sin(u * 47 + k * 3.1) * 0.5 + Math.sin(u * 23 - k * 1.7) * 0.5;
            const v = Math.pow(b[bandaEspejo(u, this.nb)], 1.4);
            pts.push([x0 + (x1 - x0) * u, y - env * (v * 150 * s.sensibilidad + 6 + ruido * 5)]);
          }
          c.beginPath();
          curva(c, pts, false);
          c.lineTo(x1, y + paso * 2);
          c.lineTo(x0, y + paso * 2);
          c.closePath();
          c.fillStyle = hexA(s.fondo1, 0.94);
          c.fill();
          c.beginPath();
          curva(c, pts, false);
          c.strokeStyle = k === 0 ? s.acento : s.texto;
          c.globalAlpha = 1 - (k / L) * 0.65;
          c.lineWidth = k === 0 ? 3 : 2;
          c.stroke();
        }
        c.globalAlpha = 1;
      },
    },

    // ---------- Aurora: cortinas de luz que ondulan con los medios ----------
    aurora: {
      nombre: 'Aurora', grupo: 'Atmósfera', acomodo: { ondaY: 0.70, letraY: 0.30 },
      dibujar({ t, s, medios, graves, int }) {
        const c = this.ctx, y0 = H * s.ondaY, b = this.bandasEn(t);
        c.globalCompositeOperation = 'lighter';
        for (let k = 0; k < 4; k++) {
          const A = (50 + 170 * medios * (0.6 + 0.6 * int)) * s.sensibilidad;
          const grueso = 140 + 220 * graves;
          const base = y0 - 45 * k;
          const pts = [];
          for (let x = -40; x <= W + 40; x += 40) {
            const u = clamp(x / W);
            pts.push([x, base + Math.sin(x * 0.0042 + t * 0.45 + k * 1.3) * A * 0.65
              + Math.sin(x * 0.011 - t * 0.8 + k * 2.1) * A * 0.3 - b[bandaEspejo(u, this.nb)] * 90 * s.sensibilidad]);
          }
          const color = k % 2 ? s.acento : s.acento2;
          const g = c.createLinearGradient(0, base - A - grueso, 0, base + A);
          g.addColorStop(0, hexA(color, 0));
          g.addColorStop(0.7, hexA(color, 0.28));
          g.addColorStop(1, hexA(color, 0));
          c.fillStyle = g;
          c.beginPath();
          curva(c, pts, false);
          for (let i = pts.length - 1; i >= 0; i--) c.lineTo(pts[i][0], pts[i][1] - grueso);
          c.closePath();
          c.fill();
        }
        c.globalCompositeOperation = 'source-over';
      },
    },

    // ---------- Anillos: cada tiempo del ritmo suelta una onda expansiva ----------
    anillos: {
      nombre: 'Ondas expansivas', grupo: 'Ritmo', centro: true, acomodo: { ondaY: 0.45, letraY: 0.86 },
      dibujar({ t, s, graves, beat }) {
        const c = this.ctx, { cx, cy, r } = centro(this, s), B = this.beats, Cm = new Set(this.compases);
        const vida = 3.2;
        for (let k = antes(B, t); k >= 0 && t - B[k] < vida; k--) {
          const dt = t - B[k], f = dt / vida, fuerte = Cm.has(B[k]);
          const e = this.energia('graves', B[k]);
          c.globalAlpha = Math.pow(1 - f, 2) * (0.3 + 0.7 * e);
          c.strokeStyle = fuerte ? s.acento : s.acento2;
          c.lineWidth = (fuerte ? 5 : 2.5) * (1 - f) + 1;
          c.beginPath();
          c.arc(cx, cy, r + 10 + dt * 300 * s.sensibilidad, 0, TAU);
          c.stroke();
        }
        c.globalAlpha = 1;
        this.resplandor(s.acento, 20 + 30 * beat);
        c.strokeStyle = s.acento;
        c.lineWidth = 4;
        c.beginPath();
        c.arc(cx, cy, r + 12 + graves * 24, 0, TAU);
        c.stroke();
        c.shadowBlur = 0;
      },
    },

    // ---------- Galaxia: brazos de estrellas que giran más rápido con la energía ----------
    galaxia: {
      nombre: 'Galaxia', grupo: 'Atmósfera', centro: true, acomodo: { ondaY: 0.45, letraY: 0.86 },
      dibujar({ t, s }) {
        const c = this.ctx, { cx, cy, r } = centro(this, s), b = this.bandasEn(t), N = 420;
        if (!this._galaxia) { const q = rng(5); this._galaxia = Array.from({ length: N }, () => [q(), q(), q()]); }
        const giro = this.avance(t) * 0.35;
        c.globalCompositeOperation = 'lighter';
        for (let i = 0; i < N; i++) {
          const [a, j, z] = this._galaxia[i], brazo = i % 3, f = i / N;
          const v = b[Math.floor(f * (this.nb - 1))];
          const rad = r * 0.7 + f * 520 + (j - 0.5) * 40 + v * 70 * s.sensibilidad;
          const ang = brazo * TAU / 3 + f * 5.2 + giro + (a - 0.5) * 0.35;
          c.globalAlpha = (0.2 + 0.8 * v) * (1 - f * 0.5);
          c.fillStyle = z < 0.5 ? s.acento : (z < 0.8 ? s.acento2 : s.texto);
          c.beginPath();
          c.arc(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad * 0.62, 1 + v * 3.5 + z, 0, TAU);
          c.fill();
        }
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
      },
    },

    // ---------- Hiperespacio: estrellas que vienen hacia ti; la velocidad es la energía ----------
    hiperespacio: {
      nombre: 'Hiperespacio', grupo: 'Atmósfera', centro: true, acomodo: { ondaY: 0.50, letraY: 0.84 },
      dibujar({ t, s, rms }) {
        const c = this.ctx, { cx, cy } = centro(this, s), N = 300;
        if (!this._estrellas) { const q = rng(21); this._estrellas = Array.from({ length: N }, () => [q() * TAU, 0.6 + q() * 0.8, q()]); }
        const d = this.avance(t) * 0.9;
        c.lineCap = 'round';
        for (const [ang, vel, off] of this._estrellas) {
          const z = 1 - ((d * vel + off) % 1);
          const proy = zz => 30 + (1 / (zz + 0.06) - 1) * 70;
          const r1 = proy(z), r0 = proy(Math.min(1, z + 0.015 + 0.05 * rms * s.sensibilidad));
          if (r1 > W) continue;
          c.globalAlpha = Math.min(1, (1 - z) * 1.4);
          c.strokeStyle = off < 0.25 ? s.acento : s.texto;
          c.lineWidth = 1 + (1 - z) * 2.5;
          c.beginPath();
          c.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
          c.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
          c.stroke();
        }
        c.globalAlpha = 1;
      },
    },

    // ---------- Burbujas: suben y se inflan con su banda ----------
    burbujas: {
      nombre: 'Burbujas', grupo: 'Atmósfera', acomodo: { ondaY: 0.80, letraY: 0.40 },
      dibujar({ t, s }) {
        const c = this.ctx, b = this.bandasEn(t), N = 70, x0 = this.m.x0, x1 = this.m.x1;
        if (!this._burbujas) { const q = rng(33); this._burbujas = Array.from({ length: N }, () => [q(), q(), 0.6 + q() * 0.9, q()]); }
        const d = this.avance(t);
        for (const [u, off, vel, tam] of this._burbujas) {
          const f = (d * 0.12 * vel + off) % 1;
          const v = b[bandaEspejo(u, this.nb)];
          const x = x0 + (x1 - x0) * u + Math.sin(f * 9 + u * 20) * 22;
          const y = H + 60 - f * (H + 120);
          const rad = 5 + tam * 12 + v * 34 * s.sensibilidad;
          c.globalAlpha = Math.sin(Math.PI * f) * (0.25 + 0.6 * v);
          c.strokeStyle = s.acento2;
          c.lineWidth = 2;
          c.beginPath();
          c.arc(x, y, rad, 0, TAU);
          c.stroke();
          c.fillStyle = s.texto;
          c.beginPath();
          c.arc(x - rad * 0.35, y - rad * 0.35, rad * 0.18, 0, TAU);
          c.fill();
        }
        c.globalAlpha = 1;
      },
    },

    // ---------- Neón: una forma orgánica cerrada que late con el espectro ----------
    neon: {
      nombre: 'Neón', grupo: 'Energía', centro: true, acomodo: { ondaY: 0.45, letraY: 0.86 },
      dibujar({ t, s, beat }) {
        const c = this.ctx, { cx, cy, r } = centro(this, s), N = 96;
        const capas = [[0.2, s.acento2, 0.35], [0.1, s.acento2, 0.6], [0, s.acento, 1]];
        c.globalCompositeOperation = 'lighter';
        c.lineJoin = 'round';
        for (const [retraso, color, a] of capas) {
          const b = this.bandasEn(t - retraso, new Float32Array(this.nb)), pts = [];
          for (let i = 0; i < N; i++) {
            const u = i / N, ang = u * TAU - Math.PI / 2 + t * 0.1;
            const band = Math.min(this.nb - 1, Math.floor((u < 0.5 ? u : 1 - u) * 2 * (this.nb - 1)));
            const rad = r * 1.08 + 20 + Math.pow(b[band], 1.3) * 170 * s.sensibilidad;
            pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
          }
          c.globalAlpha = a;
          c.strokeStyle = color;
          c.lineWidth = retraso === 0 ? 4 : 3;
          this.resplandor(color, 18 + 30 * beat);
          c.beginPath();
          curva(c, pts, true);
          c.stroke();
        }
        c.shadowBlur = 0;
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
      },
    },

    // ---------- Pulso: un monitor cardiaco que corre con los golpes ----------
    pulso: {
      nombre: 'Pulso', grupo: 'Ritmo', acomodo: { ondaY: 0.74, letraY: 0.36 },
      dibujar({ t, s }) {
        const c = this.ctx, x0 = this.m.x0, x1 = this.m.x1, y0 = H * s.ondaY, ventana = 4, N = 260;
        const pts = [];
        for (let i = 0; i < N; i++) {
          const u = i / (N - 1), tt = t - (1 - u) * ventana;
          const g = this.energia('golpe', tt), e = this.energia('rms', tt);
          const latido = Math.sin(tt * 60) * g * g; // zigzag rápido sobre cada golpe
          pts.push([x0 + (x1 - x0) * u, y0 - (latido * 190 + e * 40) * s.sensibilidad]);
        }
        const g = c.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, hexA(s.acento, 0));
        g.addColorStop(0.75, hexA(s.acento, 0.8));
        g.addColorStop(1, s.acento);
        c.strokeStyle = g;
        c.lineWidth = 3.5;
        c.lineJoin = 'round';
        this.resplandor(s.acento, 16);
        c.beginPath();
        curva(c, pts, false);
        c.stroke();
        const [lx, ly] = pts[N - 1];
        c.fillStyle = s.texto;
        this.resplandor(s.texto, 24);
        c.beginPath();
        c.arc(lx, ly, 6, 0, TAU);
        c.fill();
        c.shadowBlur = 0;
      },
    },
  };

  Motor.DISENOS = DISENOS;
})();
