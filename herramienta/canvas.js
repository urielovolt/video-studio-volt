// Canvas de Spotify (?formato=canvas): la foto tratada como una toma de cine, no la portada
// rebotando ni deformada.
//
//   - Fondo: canvas-fondo.jpg, un recorte vertical limpio de la portada (sin título ni artista),
//     que render.py saca de portada-original.* según estilo.canvas.encuadre.
//   - Cámara que se acerca y se aleja muy despacio; respira un poco con los graves.
//   - Un haz de sol que entra en diagonal y polvo flotando que brilla dentro del haz.
//   - (motion «cronografo») un cronógrafo fino: la aguja da una vuelta exacta por bucle y las
//     marcas se encienden a su paso y con los golpes.
//   - Película: gradación cálida, parpadeo leve, viñeta y grano (los del motor).
//
// Todo lo que se mueve es periódico en la duración del bucle (fase u de 0 a 1), así el final
// empata con el principio. Lo que reacciona a la música lo suaviza el cruce de render.py.

(function () {
  const { W, H } = Motor;
  const TAU = Math.PI * 2;
  const q = new URLSearchParams(location.search);
  const INICIO = parseFloat(q.get('inicio') || '0'), LARGO = parseFloat(q.get('largo') || '8');
  const fase = t => (((t - INICIO) / LARGO) % 1 + 1) % 1;

  const rnd = (i, k) => { const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return s - Math.floor(s); };
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

  // El haz de luz se dibuja una vez (con desenfoque) y luego solo se gira y se le cambia la opacidad.
  function texturaHaz(color) {
    const c = document.createElement('canvas');
    c.width = 1600; c.height = 2600;  // ancho de sobra: el desenfoque no debe toparse con la orilla
    const g = c.getContext('2d');
    g.filter = 'blur(38px)';
    for (const [x, w, a] of [[600, 170, 0.9], [820, 90, 0.55], [960, 220, 0.7]]) {
      const lg = g.createLinearGradient(0, 0, 0, c.height);
      lg.addColorStop(0, hexA(color, a));
      lg.addColorStop(0.55, hexA(color, a * 0.45));
      lg.addColorStop(1, hexA(color, 0));
      g.fillStyle = lg;
      g.beginPath();  // se abre un poco hacia abajo, como la luz real
      g.moveTo(x, 0); g.lineTo(x + w, 0); g.lineTo(x + w * 1.6 + 60, c.height); g.lineTo(x - w * 0.4 - 60, c.height);
      g.fill();
    }
    return c;
  }

  // Ángulo del haz: entra desde arriba a la derecha y cae hacia abajo a la izquierda.
  const HAZ = { x: W * 0.92, y: -H * 0.08 };

  Motor.prototype.motionCanvas = function (ctxT) {
    const im = this.fondoCanvas || this.portada;
    if (!im) return false;
    const c = this.ctx, s = this.s, { t, graves, medios, agudos, rms, beat, compas } = ctxT;
    const u = fase(t), ola = 0.5 - 0.5 * Math.cos(TAU * u);
    const luz = s.acento2;

    // ---- Cámara ----
    const z = 1.02 + 0.045 * ola + 0.008 * graves + 0.004 * beat;
    const k = Math.max(W / im.width, H / im.height) * z;
    const fx = W * 0.42, fy = H * 0.42;  // se acerca hacia el tercio superior, donde suele estar el sujeto
    const dx = 14 * Math.sin(TAU * u), dy = 10 * Math.sin(TAU * u * 2 + 1);
    const w = im.width * k, h = im.height * k;
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    c.filter = `contrast(1.12) saturate(1.15) sepia(0.12) brightness(${0.95 + 0.06 * rms})`;
    c.drawImage(im, (W - w) / 2 + (W / 2 - fx) * (z - 1) + dx, (H - h) / 2 + (H / 2 - fy) * (z - 1) + dy, w, h);
    c.filter = 'none';

    // ---- Gradación: sombras hacia el fondo, luces cálidas ----
    c.globalCompositeOperation = 'multiply';
    const gr = c.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, hexA(s.acento2, 0.18));
    gr.addColorStop(1, hexA(s.fondo1, 0.35));
    c.fillStyle = gr;
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';

    // ---- Haz de sol ----
    if (!this._haz || this._hazColor !== luz) { this._haz = texturaHaz(luz); this._hazColor = luz; }
    const ang = 0.42 + 0.035 * Math.sin(TAU * u);
    c.save();
    c.globalCompositeOperation = 'screen';
    c.globalAlpha = Math.min(1, 0.32 + 0.22 * medios + 0.14 * compas);
    c.translate(HAZ.x, HAZ.y);
    c.rotate(ang);
    c.drawImage(this._haz, -this._haz.width / 2, 0);
    c.restore();

    // ---- Polvo en el aire: cerca (grande, desenfocado) y lejos (puntitos) ----
    const ejeX = -Math.sin(ang), ejeY = Math.cos(ang);  // dirección del haz
    c.save();
    c.globalCompositeOperation = 'screen';
    for (let i = 0; i < 150; i++) {
      const prof = rnd(i, 1);  // 0 lejos, 1 cerca
      const vueltas = 1 + (prof > 0.7 ? 1 : 0);  // los cercanos suben más rápido; entero para que empate
      const x = W * rnd(i, 2) + (20 + 40 * prof) * Math.sin(TAU * (u * (1 + (i % 2)) + rnd(i, 3)));
      const y = ((H * rnd(i, 4) - vueltas * u * H * 0.5 * (i % 3 === 0 ? 2 : 1)) % H + H) % H;
      // Qué tan dentro del haz está (distancia al eje).
      const rx = x - HAZ.x, ry = y - HAZ.y;
      const dPerp = Math.abs(rx * ejeY - ry * ejeX);
      const enHaz = Math.exp(-Math.pow(dPerp / 330, 2));
      const tit = 0.55 + 0.45 * Math.sin(TAU * (u * (2 + (i % 3)) + rnd(i, 5)));
      const a = (0.05 + 0.85 * enHaz) * tit * (0.55 + 0.45 * prof) * (1 + 0.6 * agudos + 0.4 * beat);
      if (a < 0.01) continue;
      const r = 1.2 + 2.2 * prof + (prof > 0.85 ? 9 * (prof - 0.85) / 0.15 : 0);
      const g = c.createRadialGradient(x, y, 0, x, y, r * 3);
      g.addColorStop(0, `rgba(255,244,225,${Math.min(1, a)})`);
      g.addColorStop(0.35, hexA(luz, Math.min(1, a) * 0.5));
      g.addColorStop(1, hexA(luz, 0));
      c.fillStyle = g;
      c.beginPath(); c.arc(x, y, r * 3, 0, TAU); c.fill();
    }
    c.restore();

    // ---- Cronógrafo ----
    if (s.motion === 'cronografo') this.cronografo(u, ctxT);

    // ---- Luz que se cuela por la orilla con el compás ----
    const fuga = c.createRadialGradient(W * 1.05, H * 0.1, 0, W * 1.05, H * 0.1, W * 0.9);
    fuga.addColorStop(0, hexA(s.acento, 0.1 + 0.16 * compas));
    fuga.addColorStop(1, hexA(s.acento, 0));
    c.globalCompositeOperation = 'screen';
    c.fillStyle = fuga;
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';

    // ---- Parpadeo de proyector, apenas ----
    const parpadeo = 0.035 * rnd(Math.floor(t * 24), 9);
    if (parpadeo > 0.004) { c.fillStyle = `rgba(0,0,0,${parpadeo})`; c.fillRect(0, 0, W, H); }
    return true;
  };

  // Carátula de cronógrafo, fina y transparente: 60 marcas, la aguja barre una vuelta por bucle
  // y deja una estela; las marcas por las que pasa (y todas con el golpe) se encienden.
  Motor.prototype.cronografo = function (u, { beat, graves }) {
    const c = this.ctx, s = this.s;
    // Arriba a la derecha, sobre la pared: que no tape caras (ajustable en estilo.canvas.reloj).
    const [rx, ry, rr] = s.reloj || [0.72, 0.17, 0.22];
    const cx = W * rx, cy = H * ry, R = W * rr;
    const aguja = TAU * u - Math.PI / 2;
    c.save();
    c.translate(cx, cy);
    c.strokeStyle = s.texto;
    c.lineCap = 'round';
    // Sombra fina para que se lea sobre paredes claras.
    c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 6 * this.escala; c.shadowOffsetY = 1.5 * this.escala;
    // Aro exterior y un aro interior muy tenue.
    c.globalAlpha = 0.45 + 0.2 * beat;
    c.lineWidth = 2;
    c.beginPath(); c.arc(0, 0, R, 0, TAU); c.stroke();
    c.globalAlpha = 0.2;
    c.beginPath(); c.arc(0, 0, R * 0.86, 0, TAU); c.stroke();
    // Estela de la aguja (los últimos 70°).
    const estela = c.createConicGradient(aguja - 1.22, 0, 0);
    estela.addColorStop(0, hexA(s.acento2, 0));
    estela.addColorStop(1.22 / TAU, hexA(s.acento2, 0.22 + 0.15 * graves));
    estela.addColorStop(1.22 / TAU + 0.0001, hexA(s.acento2, 0));
    c.fillStyle = estela;
    c.globalAlpha = 1;
    c.beginPath(); c.arc(0, 0, R * 0.98, 0, TAU); c.arc(0, 0, R * 0.12, 0, TAU, true); c.fill();
    // Marcas.
    for (let m = 0; m < 60; m++) {
      const a = (m / 60) * TAU - Math.PI / 2;
      let atras = ((aguja - a) % TAU + TAU) % TAU;  // cuánto hace que pasó la aguja
      const enc = Math.exp(-atras * 2.2);
      const larga = m % 5 === 0;
      c.globalAlpha = Math.min(1, 0.4 + 0.6 * enc + 0.25 * beat);
      c.lineWidth = larga ? 4 : 2;
      const r0 = R * (larga ? 0.88 : 0.92), r1 = R * 0.97;
      c.beginPath();
      c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      c.stroke();
    }
    // Aguja con su contrapeso y el eje.
    c.shadowColor = s.acento2; c.shadowBlur = 18 * this.escala;
    c.globalAlpha = 0.85;
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(-Math.cos(aguja) * R * 0.16, -Math.sin(aguja) * R * 0.16);
    c.lineTo(Math.cos(aguja) * R * 0.95, Math.sin(aguja) * R * 0.95);
    c.stroke();
    c.fillStyle = s.texto;
    c.beginPath(); c.arc(0, 0, 7, 0, TAU); c.fill();
    c.restore();
  };

  Motor.MOTIONS = ['cine', 'cronografo', 'ondas'];
})();
