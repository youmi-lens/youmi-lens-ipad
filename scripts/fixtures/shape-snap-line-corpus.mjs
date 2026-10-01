// Deterministic corpus of lines and line-like near-misses for the LINE regression guard.
export function lineCorpus() {
  const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const out = [];
  for (let s = 1; s <= 140; s += 1) { // clean/crooked lines of many lengths, angles and wobble
    const r = rng(s); const len = 60 + r() * 500; const ang = (r() - 0.5) * 6.2; const bow = (r() - 0.5) * 0.10 * len; const jit = r() * 2.2; const n = 30 + Math.floor(r() * 90);
    const pts = []; for (let i = 0; i <= n; i += 1) { const t = i / n; const u = t * len; const v = bow * Math.sin(t * Math.PI) + (r() - 0.5) * 2 * jit; pts.push({ x: 100 + u * Math.cos(ang) - v * Math.sin(ang), y: 100 + u * Math.sin(ang) + v * Math.cos(ang) }); }
    out.push({ name: `line-${s}`, points: pts });
  }
  for (let s = 1; s <= 60; s += 1) { // near-misses that must keep behaving identically (mostly rejects)
    const r = rng(1000 + s); const pts = []; const len = 120 + r() * 300;
    const kind = s % 4;
    for (let i = 0; i <= 80; i += 1) { const t = i / 80; let x = t * len, y = 0;
      if (kind === 0) y = Math.sin(t * Math.PI * (2 + r())) * len * 0.12; // wave
      if (kind === 1) { x = (t < 0.7 ? t / 0.7 : 1 - (t - 0.7) / 0.3 * 0.6) * len; y = (r() - 0.5) * 3; } // out and back
      if (kind === 2) y = t * t * len * 0.35; // curve
      if (kind === 3) y = (r() - 0.5) * 10; // rough line
      pts.push({ x: 50 + x, y: 50 + y }); }
    out.push({ name: `near-${s}`, points: pts });
  }
  return out;
}
