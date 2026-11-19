export const SAMPLES = {
  canvas: {
    filename: 'neon-orbit-synth.html',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #050814; }
  canvas { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>
<canvas id="c" width="1280" height="720"></canvas>
<script>
window.DURATION = 6.0;
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

// WebAudio generative arpeggio synced with virtual clock
const AudioCtx = window.AudioContext || window.webkitAudioContext;
const actx = new AudioCtx();
const master = actx.createGain();
master.gain.value = 0.25;
master.connect(actx.destination);

const notes = [261.63, 329.63, 392.00, 523.25, 659.25, 523.25, 392.00, 329.63];
function playBeat(step) {
  const t = actx.currentTime;
  const osc = actx.createOscillator();
  const gain = actx.createGain();
  const filter = actx.createBiquadFilter();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(notes[step % notes.length], t);
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1800, t);
  filter.frequency.exponentialRampToValueAtTime(320, t + 0.35);
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.linearRampToValueAtTime(0.45, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  osc.start(t);
  osc.stop(t + 0.45);
}

let lastStep = -1;
function draw(now) {
  const t = now / 1000;
  const step = Math.floor(t * 4);
  if (step !== lastStep && t < 5.6) {
    lastStep = step;
    playBeat(step);
  }

  ctx.fillStyle = 'rgba(5, 8, 20, 0.24)';
  ctx.fillRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2;
  const rings = 5;
  for (let r = 0; r < rings; r++) {
    const radius = 85 + r * 48 + Math.sin(t * 2.5 + r) * 14;
    ctx.beginPath();
    ctx.strokeStyle = \`hsla(\${(t * 70 + r * 45) % 360}, 92%, 62%, 0.45)\`;
    ctx.lineWidth = 3;
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    const orbs = 8 + r * 2;
    for (let i = 0; i < orbs; i++) {
      const a = (i / orbs) * Math.PI * 2 + t * (1.1 + r * 0.35) * (r % 2 === 0 ? 1 : -1);
      const x = cx + Math.cos(a) * radius;
      const y = cy + Math.sin(a) * radius;
      ctx.beginPath();
      ctx.fillStyle = \`hsl(\${(t * 90 + i * 28 + r * 40) % 360}, 95%, 68%)\`;
      ctx.arc(x, y, 6 + Math.sin(t * 5 + i) * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.fillStyle = '#F8FAFC';
  ctx.font = 'bold 42px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NEON ORBIT SYNTH', cx, H - 64);
  ctx.fillStyle = '#38BDF8';
  ctx.font = '22px monospace';
  ctx.fillText(\`t = \${t.toFixed(2)}s / 6.00s\`, cx, H - 30);

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
</script>
</body>
</html>`
  },
  css: {
    filename: 'kinetic-css-card.html',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 100vw; height: 100vh; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #090D16 0%, #1E1B4B 55%, #0C4A6E 100%);
    font-family: system-ui, -apple-system, sans-serif;
    color: #F8FAFC;
  }
  .orb {
    position: absolute; border-radius: 50%; filter: blur(2px);
    animation: floatOrb 5s ease-in-out forwards;
  }
  .orb1 { width: 280px; height: 280px; background: rgba(56, 189, 248, 0.32); top: 8%; left: 10%; }
  .orb2 { width: 340px; height: 340px; background: rgba(129, 140, 248, 0.28); bottom: 6%; right: 10%; animation-delay: 0.2s; }
  .card {
    position: relative; z-index: 2; padding: 48px 64px; border-radius: 28px;
    background: rgba(15, 23, 42, 0.86); border: 2px solid rgba(56, 189, 248, 0.45);
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
    text-align: center;
    animation: cardEntrance 5s cubic-bezier(0.22, 1, 0.36, 1) forwards;
  }
  .badge {
    display: inline-block; padding: 8px 18px; border-radius: 999px;
    background: #38BDF8; color: #082F49; font-weight: 800; font-size: 16px;
    letter-spacing: 2px; margin-bottom: 22px;
    animation: pulseBadge 5s ease-in-out forwards;
  }
  h1 {
    font-size: 58px; font-weight: 900; letter-spacing: -1.5px; margin-bottom: 14px;
    color: #F8FAFC;
  }
  p { font-size: 24px; color: #CBD5E1; }
  @keyframes cardEntrance {
    0% { opacity: 0; transform: translateY(60px) scale(0.86); }
    20% { opacity: 1; transform: translateY(0px) scale(1); }
    80% { opacity: 1; transform: translateY(-6px) scale(1.03); }
    100% { opacity: 1; transform: translateY(0px) scale(1); }
  }
  @keyframes floatOrb {
    0% { transform: translate(0px, 0px) scale(0.9); }
    50% { transform: translate(45px, -35px) scale(1.15); }
    100% { transform: translate(-20px, 15px) scale(1); }
  }
  @keyframes pulseBadge {
    0%, 100% { transform: scale(1); }
    40% { transform: scale(1.1); }
  }
</style>
</head>
<body>
  <div class="orb orb1"></div>
  <div class="orb orb2"></div>
  <div class="card">
    <div class="badge">PURE CSS MOTION</div>
    <h1>HTML TO MP4</h1>
    <p>Deterministic Virtual Clock • Zero Dropped Frames</p>
  </div>
</body>
</html>`
  },
  svg: {
    filename: 'mandala-svg-chime.html',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: #070B14; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  svg { width: 92vmin; height: 92vmin; }
</style>
</head>
<body>
<svg id="scene" viewBox="-200 -200 400 400" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.45" />
      <stop offset="100%" stop-color="#070B14" stop-opacity="0" />
    </radialGradient>
  </defs>
  <circle cx="0" cy="0" r="190" fill="url(#glow)" />
  <g id="petals"></g>
  <circle cx="0" cy="0" r="24" fill="#F8FAFC" />
</svg>
<script>
window.TOTAL = 5.0;
const g = document.getElementById('petals');
const count = 16;
const els = [];
for (let i = 0; i < count; i++) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
  path.setAttribute('cx', '0');
  path.setAttribute('cy', '-90');
  path.setAttribute('rx', '24');
  path.setAttribute('ry', '72');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', i % 2 === 0 ? '#38BDF8' : '#818CF8');
  path.setAttribute('stroke-width', '3');
  g.appendChild(path);
  els.push(path);
}

const actx = new (window.AudioContext || window.webkitAudioContext)();
[440, 554.37, 659.25, 880].forEach((freq, idx) => {
  const osc = actx.createOscillator();
  const gain = actx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, idx * 0.9);
  gain.gain.setValueAtTime(0.0001, idx * 0.9);
  gain.gain.linearRampToValueAtTime(0.18, idx * 0.9 + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, idx * 0.9 + 1.4);
  osc.connect(gain);
  gain.connect(actx.destination);
  osc.start(idx * 0.9);
  osc.stop(idx * 0.9 + 1.45);
});

function tick(now) {
  const t = now / 1000;
  g.setAttribute('transform', \`rotate(\${t * 45})\`);
  els.forEach((el, i) => {
    const base = (i / count) * 360;
    const s = 0.75 + 0.25 * Math.sin(t * 3 + i * 0.5);
    el.setAttribute('transform', \`rotate(\${base}) scale(\${s})\`);
  });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
</script>
</body>
</html>`
  }
};
