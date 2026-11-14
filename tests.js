// Node test runner for core.js:  node tests.js [filter]
// Physics checks use published reference values; tolerances stated per test. No parameter is tuned to force a pass.
const SA = require('./core.js');
const filter = process.argv[2] || '';
const results = [];
function test(name, fn) {
  if (filter && !name.includes(filter)) return;
  const t0 = Date.now();
  try { const info = fn(); results.push([true, name, info || '', Date.now() - t0]); }
  catch (e) { results.push([false, name, e.message, Date.now() - t0]); }
}
function ok(c, msg) { if (!c) throw new Error(msg); }
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const f2 = v => v == null ? 'null' : (+v).toFixed(2);

// simple uniform material for controlled tests
function uni(id, a, s, tl) { SA.defMat(id, { a: Array(8).fill(a), s: Array(8).fill(s), tl: Array(8).fill(tl == null ? 200 : tl) }); }

test('air absorption matches ISO 9613-2 table (20°C, 70% RH) within 10%', () => {
  const ref = [0.1, 0.3, 1.1, 2.8, 5.0, 9.0, 22.9, 76.6]; // dB/km
  const got = SA.BANDS.map(f => SA.airAbsDb(f, 20, 70) * 1000);
  got.forEach((g, i) => { if (i >= 2) ok(rel(g, ref[i]) < 0.10, `band ${SA.BANDS[i]}: ${g.toFixed(2)} vs ${ref[i]}`); });
  return got.map(g => g.toFixed(1)).join(' ');
});

test('speed of sound 20°C ≈ 343 m/s', () => { const c = SA.soundSpeed(20, 0); ok(Math.abs(c - 343.2) < 0.5, c); return c.toFixed(2); });

test('shoebox mesh is closed (rays lost < 0.1%)', () => {
  uni('u20', 0.2, 0.3);
  const spec = SA.shoebox(8, 6, 3, { walls: 'u20', floor: 'u20', ceiling: 'u20' });
  const mesh = SA.buildMesh(spec); const bvh = SA.buildBVH(mesh.tris); const M = SA.matArrays(mesh);
  const r = SA.rayTrace(mesh, bvh, M, [2, 2, 1.5], [6, 4, 1.2], { T: 20, RH: 50 }, { rays: 3000, tMax: 0.5 });
  ok(r.lost < 0.001, 'lost ' + r.lost);
  ok(Math.abs(mesh.volume - 7.8 * 5.8 * 3) < 0.5, 'volume ' + mesh.volume); // walls centred on the loop line -> inner 7.8 x 5.8
  return `tris ${mesh.tris.length}, V ${mesh.volume.toFixed(1)}, lost ${r.lost}`;
});

test('image sources: shoebox order-1 count = 6 and delays exact', () => {
  uni('u10', 0.1, 0.0);
  const spec = SA.shoebox(8, 6, 3, { walls: 'u10', floor: 'u10', ceiling: 'u10' });
  const mesh = SA.buildMesh(spec); const bvh = SA.buildBVH(mesh.tris); const M = SA.matArrays(mesh);
  const src = [2, 2, 1.5], rcv = [6, 4, 1.2];
  const is = SA.imageSources(mesh, bvh, M, src, rcv, 2, { T: 20, RH: 50 });
  const o1 = is.list.filter(x => x.order === 1); const o2 = is.list.filter(x => x.order === 2);
  ok(o1.length === 6, 'order1 ' + o1.length);
  // floor image at z=-1.5 -> distance to receiver
  const dFloor = Math.hypot(4, 2, 1.5 + 1.2);
  ok(o1.some(x => Math.abs(x.dist - dFloor) < 1e-6), 'floor image distance');
  ok(o2.length === 18, 'order2 shoebox = 18, got ' + o2.length);
  return `o1 ${o1.length}, o2 ${o2.length}`;
});

test('ray tracing reverberation ≈ Eyring in diffuse shoebox (±12%)', () => {
  uni('u15', 0.15, 0.7);
  const spec = SA.shoebox(10, 7, 4, { walls: 'u15', floor: 'u15', ceiling: 'u15' });
  spec.source = [2.5, 2, 1.6]; spec.receiver = [7, 4.5, 1.2];
  const s = SA.simulate(spec, { rays: 20000, tLen: 3.0, mono: true, diffraction: false });
  const a = SA.decayParams(s.ir.L, s.ir.fs);
  const out = [];
  [2, 3, 4, 5].forEach(b => { // 250..2k
    const T = a.T30[b], E = s.se.eyring[b];
    out.push(`${SA.BANDS[b]}:${f2(T)}/${f2(E)}`);
    ok(T && rel(T, E) < 0.12, `band ${SA.BANDS[b]} T30 ${f2(T)} vs Eyring ${f2(E)}`);
  });
  return out.join(' ') + ` (${s.ms} ms)`;
});

test('specular-only shoebox decays slower than Eyring at low uniform absorption? (sanity: T30 within 0.7–1.6×)', () => {
  uni('u05s0', 0.05, 0.02);
  const spec = SA.shoebox(6, 5, 3, { walls: 'u05s0', floor: 'u05s0', ceiling: 'u05s0' });
  spec.source = [1.5, 1.5, 1.5]; spec.receiver = [4.5, 3.2, 1.2];
  const s = SA.simulate(spec, { rays: 8000, tLen: 4.0, mono: true, diffraction: false });
  const a = SA.decayParams(s.ir.L, s.ir.fs); const T = a.T30[4], E = s.se.eyring[4];
  ok(T && T / E > 0.7 && T / E < 1.6, `T30 ${f2(T)} Eyring ${f2(E)}`);
  return `T30 ${f2(T)} vs Eyring ${f2(E)}`;
});

test('IR direct sound amplitude = 1/r (synth calibration)', () => {
  uni('u99', 0.99, 0.0);
  const spec = SA.shoebox(30, 30, 30, { walls: 'u99', floor: 'u99', ceiling: 'u99' });
  spec.source = [10, 15, 15]; spec.receiver = [14, 15, 15];
  const s = SA.simulate(spec, { rays: 500, tLen: 0.3, mono: true, diffraction: false, isOrder: 0 });
  let e = 0; const x = s.ir.L; const i0 = Math.round(0.005 * s.ir.fs) - 300; for (let i = Math.max(0, i0); i < i0 + 600; i++) e += x[i];
  ok(rel(e, 0.25) < 0.05, 'sum around direct ' + e);
  return 'direct area ' + e.toFixed(4) + ' (expect 0.25)';
});

test('UTD knife edge matches ITU-R P.526 Fresnel attenuation (±1.5 dB, v = 0.5..4)', () => {
  // half-plane (n = 2). Screen hangs down from the edge (face A direction = -y). Source/receiver at distance d on each side,
  // h metres below the edge line, so the edge obstructs line of sight by h.
  const c = 343, out = [];
  for (const [f, d, h] of [[500, 10, 0.8], [1000, 10, 1], [2000, 10, 2], [4000, 20, 3]]) {
    const k = 2 * Math.PI * f / c, lam = c / f;
    const ang = (x, y) => { let a = Math.atan2(-(0 * y - (-1) * x) * 0 + x * 1 * 0 + (-x), -y); return a; };
    // angles from face A (pointing -y), rotating toward nA = -x side for the source (left) — use explicit formula
    const phi = (x, y) => { let a = Math.atan2(-x, -y); if (a < 0) a += 2 * Math.PI; return a; }; // nA = (-1,0)
    const phiS = phi(-d, -h), phiR = phi(d, -h);
    const rho = Math.hypot(d, h), r = rho;
    const A = SA.utdField(k, 2, phiS, phiR, rho, r, 1);
    const att = -20 * Math.log10(A * (2 * d));       // relative to free field over the direct distance 2d
    const v = h * Math.sqrt(2 / lam * (1 / d + 1 / d));
    const J = 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
    out.push(`v=${v.toFixed(2)}: UTD ${att.toFixed(1)} / ITU ${J.toFixed(1)}`);
    ok(Math.abs(att - J) < 1.5, out[out.length - 1]);
  }
  return out.join(', ');
});

test('diffraction around a partition: shadowed receiver still hears sound', () => {
  uni('u30', 0.3, 0.2);
  const spec = SA.shoebox(10, 6, 3, { walls: 'u30', floor: 'u30', ceiling: 'u30' });
  spec.partitions = [{ a: [5, 0], b: [5, 4], thick: 0.15, mat: 'u30' }];
  const mesh = SA.buildMesh(spec); const bvh = SA.buildBVH(mesh.tris); const M = SA.matArrays(mesh);
  const src = [2, 2, 1.5], rcv = [8, 2, 1.5];
  ok(!SA.visible(bvh, src, rcv), 'direct should be blocked');
  const d = SA.edgeDiffraction(mesh, bvh, M, src, rcv, { T: 20, RH: 50 });
  ok(d.length >= 1, 'no diffracted path found');
  const best = d.reduce((a, b) => a.gains[3] > b.gains[3] ? a : b);
  // low frequencies bend more than high frequencies
  ok(best.gains[1] > best.gains[6], 'expected 125 Hz > 4 kHz');
  return `paths ${d.length}, edge at (${best.path[1].map(v => v.toFixed(2))}), 125Hz/4k ratio ${(best.gains[1] / best.gains[6]).toFixed(1)}`;
});

test('FDTD free-field calibration: direct peak area ≈ 1/r (±10%)', () => {
  uni('abs', 1.0, 0);
  const spec = SA.shoebox(6, 6, 6, { walls: 'abs', floor: 'abs', ceiling: 'abs' });
  const mesh = SA.buildMesh(spec); const bvh = SA.buildBVH(mesh.tris); const M = SA.matArrays(mesh);
  const dx = 0.1; const g = SA.voxelise(mesh, bvh, dx, [3, 3, 3], M);
  const src = [2, 3, 3], rc = [4, 3, 3];
  const r = SA.fdtdRun(g, src, [rc], { T: 20, RH: 50 }, { tMax: 0.012, fmax: 300, dcBlock: false });
  const ir = r.ir[0];
  // integrate the pulse around arrival (direct only; first reflection from absorbing walls is weak)
  const tArr = 2 / SA.soundSpeed(20, 50) + r.delay0; let s = 0;
  for (let n = 0; n < ir.length; n++) { const t = n * r.dt; if (Math.abs(t - tArr) < 0.004) s += ir[n]; }
  // samples at grid rate: sum over grid samples * (dt) * audio fs -> compare as area (seconds) * 1 => expect (1/r)/fs_audio*fs_grid... use area
  const area = s * r.dt; // pressure-seconds
  const expect = 0.5; // 1/r with unit-sum source -> area = 1/r * dt_source... normalised: scale makes sum (grid) = 1/r
  const sumGrid = s;
  ok(rel(sumGrid, expect) < 0.10, 'sum ' + sumGrid.toFixed(3));
  return `grid ${g.nx}x${g.ny}x${g.nz}, sum ${sumGrid.toFixed(3)} (expect 0.5)`;
});

test('FDTD shoebox: first axial mode at c/(2Lx) (±3%)', () => {
  uni('hard', 0.02, 0);
  const Lx = 4, Ly = 3, H = 2.5;
  const spec = SA.shoebox(Lx, Ly, H, { walls: 'hard', floor: 'hard', ceiling: 'hard' }, 0.2);
  const mesh = SA.buildMesh(spec); const bvh = SA.buildBVH(mesh.tris); const M = SA.matArrays(mesh);
  const g = SA.voxelise(mesh, bvh, 0.1, [2, 1.5, 1.2], M);
  const r = SA.fdtdRun(g, [0.4, 0.4, 0.4], [[3.6, 2.6, 2.1]], { T: 20, RH: 50 }, { tMax: 1.0, fmax: 250 });
  const x = r.ir[0];
  // DFT magnitude scan 30..80 Hz
  let best = 0, bf = 0;
  for (let f = 30; f <= 80; f += 0.25) {
    let re = 0, im = 0; for (let n = 0; n < x.length; n++) { const ph = 2 * Math.PI * f * n * r.dt; re += x[n] * Math.cos(ph); im -= x[n] * Math.sin(ph); }
    const m = Math.hypot(re, im); if (m > best) { best = m; bf = f; }
  }
  // effective inner length: walls 0.2 thick centred on the loop -> inner Lx-0.2
  const c = SA.soundSpeed(20, 50), exp = c / (2 * (Lx - 0.2));
  ok(rel(bf, exp) < 0.03, `peak ${bf} Hz vs ${exp.toFixed(1)}`);
  return `peak ${bf.toFixed(2)} Hz, expected ${exp.toFixed(2)} Hz (grid ${g.nx}x${g.ny}x${g.nz}, ${r.steps} steps)`;
});

test('FDTD absorbing room decays faster than hard room', () => {
  const run = (mat) => {
    const spec = SA.shoebox(4, 3, 2.5, { walls: mat, floor: mat, ceiling: mat }, 0.2);
    const mesh = SA.buildMesh(spec); const bvh = SA.buildBVH(mesh.tris); const M = SA.matArrays(mesh);
    const g = SA.voxelise(mesh, bvh, 0.12, [2, 1.5, 1.2], M);
    const r = SA.fdtdRun(g, [0.7, 0.6, 0.5], [[3.1, 2.2, 1.8]], { T: 20, RH: 50 }, { tMax: 0.6, fmax: 200 });
    let e1 = 0, e2 = 0; const x = r.ir[0]; for (let n = 0; n < x.length; n++) { const t = n * r.dt; if (t > 0.05 && t < 0.15) e1 += x[n] * x[n]; if (t > 0.35 && t < 0.45) e2 += x[n] * x[n]; }
    return 10 * Math.log10(e2 / e1);
  };
  uni('a10', 0.10, 0); uni('a50', 0.50, 0);
  const d10 = run('a10'), d50 = run('a50');
  ok(d50 < d10 - 6, `decay 0.3 s: α0.1 ${d10.toFixed(1)} dB, α0.5 ${d50.toFixed(1)} dB`);
  return `α0.1 ${d10.toFixed(1)} dB, α0.5 ${d50.toFixed(1)} dB over 0.3 s`;
});

test('refraction: ray bends with radius R = c/(dc/dz) (drop over 100 m within 3%)', () => {
  const env = { T: 20, RH: 50, grad: 1.0 }; // +1 K/m: warmer (faster) above -> horizontal ray bends down
  const c = SA.soundSpeed(20, 50), R = c / (1.0 * SA.dcdT(20));
  const L = 100; const end = SA.refractPath([0, 0, 50], [1, 0, 0], env, L, 0.25);
  const drop = 50 - end.p[2];
  const exact = R - Math.sqrt(R * R - Math.pow(end.p[0], 2)); // circle of radius R
  ok(rel(drop, exact) < 0.03, `drop ${drop.toFixed(3)} vs circle ${exact.toFixed(3)} (R ${R.toFixed(0)} m)`);
  ok(SA.refractPath([0, 0, 50], [1, 0, 0], { T: 20, RH: 50, grad: 0 }, L).p[2] === 50, 'no gradient must stay straight');
  return `R ${R.toFixed(0)} m, drop ${drop.toFixed(2)} m vs ${exact.toFixed(2)} m`;
});

test('absolute level: reverberant/direct energy (1 kHz) = 16πr²/R diffuse theory (±1.5 dB)', () => {
  uni('u20d', 0.2, 0.8);
  const spec = SA.shoebox(10.2, 8.2, 4.2, { walls: 'u20d', floor: 'u20d', ceiling: 'u20d' }); // inner 10 x 8 x 4
  spec.source = [3, 3, 1.5]; spec.receiver = [7, 5, 1.5]; spec.env = { T: 20, RH: 50 };
  const s = SA.simulate(spec, { rays: 30000, tLen: 2, mono: true, diffraction: false, isOrder: 0 });
  const fs = s.ir.fs, r = Math.hypot(4, 2);
  const yb = SA.bandFilterExport(Float64Array.from(s.ir.L), 1000, fs);
  let eD = 0, eL = 0; const iD = Math.round(0.005 * fs) + Math.round(0.004 * fs);
  for (let i = 0; i < yb.length; i++) { if (i < iD) eD += yb[i] * yb[i]; else eL += yb[i] * yb[i]; }
  const S = 2 * (10 * 8 + 10 * 4 + 8 * 4), a = 0.2, R = S * a / (1 - a);
  const sim = 10 * Math.log10(eL / eD), th = 10 * Math.log10(16 * Math.PI * r * r / R);
  ok(Math.abs(sim - th) < 1.5, `sim ${sim.toFixed(2)} dB vs theory ${th.toFixed(2)} dB`);
  return `late/direct ${sim.toFixed(2)} dB vs theory ${th.toFixed(2)} dB`;
});

test('hybrid FDTD+geometric: 125 Hz band energy consistent with geometric-only (±3 dB), T30 within 40%', () => {
  uni('u25h', 0.25, 0.7);
  const spec = SA.shoebox(7.2, 5.2, 3.2, { walls: 'u25h', floor: 'u25h', ceiling: 'u25h' }); // inner 7 x 5 x 3
  spec.source = [1.5, 1.5, 1.4]; spec.receiver = [5.2, 3.6, 1.3]; spec.env = { T: 20, RH: 50 };
  const s = SA.simulate(spec, { rays: 20000, tLen: 1.5, mono: true, diffraction: false });
  const fd = SA.fdtdRun(SA.voxelise(s.mesh, s.bvh, 343 / (7 * 400), spec.receiver, s.M), spec.source, [spec.receiver], s.env, { tMax: 1.6, fmax: 400, source: 'diff' });
  const h = SA.hybridIR(s.ir, fd, 250);
  const e125 = x => { const y = SA.bandFilterExport(Float64Array.from(x), 125, s.ir.fs); let e = 0; for (const v of y) e += v * v; return e; };
  const dB = 10 * Math.log10(e125(h.L) / e125(s.ir.L));
  const tG = SA.decayParams(s.ir.L, s.ir.fs).T30[1], tH = SA.decayParams(h.L, h.fs).T30[1];
  ok(Math.abs(dB) < 3, `125 Hz energy hybrid vs geometric ${dB.toFixed(2)} dB`);
  // wave solution keeps weakly damped axial/grazing modes below the Schroeder frequency -> longer than diffuse ray/Eyring T (physics, not a bug)
  ok(tH && rel(tH, tG) < 0.4, `T30@125 hybrid ${f2(tH)} vs geometric ${f2(tG)}`);
  return `ΔE125 ${dB.toFixed(2)} dB, T30@125 hybrid ${f2(tH)} vs geo ${f2(tG)} (Eyring ${f2(s.se.eyring[1])})`;
});

// ---------------- v3 regression tests (from the 2026-11-10 audit) ----------------
require('./materials.js');
test('v3: door/window leaves are opaque from both sides (front face hit first)', () => {
  const spec = SA.shoebox(5, 4, 3, { walls: 'plaster', ceiling: 'plaster', floor: 'plaster' }, 0.2);
  spec.loop[0].openings = [{ t0: 0.2, t1: 0.8, z0: 0.5, z1: 2.5, kind: 'window', mat: 'glass_window' }];
  spec.partitions = [{ a: [2.5, 0.1], b: [2.5, 3.9], thick: 0.1, h: 3, mat: 'plaster', openings: [{ t0: 0.4, t1: 0.6, z0: 0, z1: 2.1, kind: 'door', mat: 'wood_door' }] }];
  const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), tmp = [0, 0, 0]; const R = SA.rng(9);
  const shoot = (o, tgt) => { let bad = 0, n = 0; for (let k = 0; k < 500; k++) { const p = tgt(R()); let d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]; const l = Math.hypot(...d); d = d.map(v => v / l);
    const h = SA.raycast(bvh, o[0], o[1], o[2], d[0], d[1], d[2], 1e-7, 1e9, tmp, true, -1); if (h < 0) continue; const t = mesh.tris[h]; if (!(t.meta && t.meta.leaf)) continue; n++;
    if (d[0] * t.n[0] + d[1] * t.n[1] + d[2] * t.n[2] > 0) bad++; } return [bad, n]; };
  // window in wall 0 (y = 0 side): from inside and from outside
  const a = shoot([2.0, 2, 1.5], u => [0.3 + u * 1.9, -0.1, 0.6 + (u * 7 % 1) * 1.8]);
  const b = shoot([1.25, -3, 1.5], u => [0.3 + u * 1.9, -0.1, 0.6 + (u * 7 % 1) * 1.8]);
  const c = shoot([1.2, 2, 1.0], u => [2.5, 1.7 + u * 0.6, 0.2 + (u * 5 % 1) * 1.7]);
  const d = shoot([3.8, 2, 1.0], u => [2.5, 1.7 + u * 0.6, 0.2 + (u * 5 % 1) * 1.7]);
  [a, b, c, d].forEach((r, i) => ok(r[1] > 50 && r[0] === 0, `case ${i}: back-face first ${r[0]}/${r[1]}`));
  return `window in/out ${a[1]}/${b[1]} rays, door L/R ${c[1]}/${d[1]} rays, back-face-first 0`;
});
test('v3: glazed window keeps the room reverberant; an open hole does not', () => {
  const T = m => { const spec = SA.shoebox(5, 4, 3, { walls: 'plaster', ceiling: 'plaster', floor: 'carpet_thin' }, 0.2);
    if (m) spec.loop[0].openings = [{ t0: 0.2, t1: 0.8, z0: 0.5, z1: 2.5, kind: 'window', mat: m }];
    const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), M = SA.matArrays(mesh);
    const r = SA.rayTrace(mesh, bvh, M, [1.2, 1.1, 1.5], [3.6, 2.7, 1.2], { T: 20, RH: 50 }, { rays: 3000, tMax: 1.5 });
    const e = (a, c) => { let s = 0; for (let i = a; i < c; i++) s += r.H[3 * r.nBins + i]; return s; }; return 60 * 0.6 / (10 * Math.log10(e(100, 300) / e(700, 900))); };
  const t0 = T(null), tg = T('glass_window'), to = T('open');
  ok(rel(tg, t0) < 0.15, `glass ${f2(tg)} vs closed ${f2(t0)}`); ok(to < 0.6 * t0, `open ${f2(to)} vs closed ${f2(t0)}`);
  return `500 Hz T: closed ${f2(t0)}, glass ${f2(tg)}, open hole ${f2(to)} s`;
});
test('v3: FDTD boundary β of a wall thinner than dx is the inner material only (no exterior β mixed in)', () => {
  const spec = SA.shoebox(6, 5, 3, { walls: 'plaster', ceiling: 'plaster', floor: 'plaster' }, 0.2);
  const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), M = SA.matArrays(mesh);
  const g = SA.voxelise(mesh, bvh, 0.27, [3, 2.5, 1.5], M); let mx = 0, n = 0;
  for (let q = 0; q < g.K.length; q++) if (g.K[q] >= 0 && g.K[q] < 6) { n++; mx = Math.max(mx, g.beta[q]); }
  const want = SA.betaFromRandomAlpha((SA.MATERIALS.plaster.a[0] + SA.MATERIALS.plaster.a[1] + SA.MATERIALS.plaster.a[2]) / 3);
  ok(mx < 2 * want + 1e-6, `max β ${mx.toFixed(4)} vs plaster ${want.toFixed(4)}`);
  return `${n} boundary cells, max β ${mx.toFixed(4)} (plaster ${want.toFixed(4)})`;
});
test('v3: FDTD source 3 cm from a wall still radiates (snaps to an air node)', () => {
  const spec = SA.shoebox(4, 3, 2.6, { walls: 'plaster', ceiling: 'plaster', floor: 'plaster' }, 0.2);
  const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), M = SA.matArrays(mesh);
  const g = SA.voxelise(mesh, bvh, 0.27, [2, 1.5, 1.2], M);
  const r = SA.fdtdRun(g, [2, 0.13, 1.2], [[2.5, 2, 1.3]], { T: 20, RH: 50 }, { tMax: 0.1, fmax: 180, dcBlock: false });
  let e = 0; for (const v of r.ir[0]) e += v * v; ok(e > 1e-6, 'energy ' + e); return 'receiver energy ' + e.toExponential(2);
});
test('v3: an open window drains low-frequency energy in the FDTD (grid edge absorbs)', () => {
  const run = open => { const spec = SA.shoebox(4, 3, 2.6, { walls: 'plaster', ceiling: 'plaster', floor: 'plaster' }, 0.4);
    if (open) spec.loop[0].openings = [{ t0: 0.1, t1: 0.9, z0: 0.3, z1: 2.3, kind: 'window', mat: 'open' }];
    const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), M = SA.matArrays(mesh);
    const g = SA.voxelise(mesh, bvh, 0.2, [2, 1.5, 1.2], M);
    const r = SA.fdtdRun(g, [1, 1, 1], [[3, 2, 1.5]], { T: 20, RH: 50 }, { tMax: 0.5, fmax: 240 }); const x = r.ir[0], n = x.length;
    let a = 0, b = 0; for (let i = Math.floor(n * 0.1); i < Math.floor(n * 0.3); i++) a += x[i] * x[i]; for (let i = Math.floor(n * 0.7); i < n * 0.9; i++) b += x[i] * x[i]; return 10 * Math.log10(a / b); };
  const dc = run(false), dop = run(true); ok(dop > dc + 6, `decay over 0.2 s: open ${dop.toFixed(1)} dB vs closed ${dc.toFixed(1)} dB`);
  return `decay 0.05–0.15 s → 0.35–0.45 s: closed ${dc.toFixed(1)} dB, open window ${dop.toFixed(1)} dB`;
});
test('v3: Sabine/Eyring count an open hole as α = 1', () => {
  const se = open => { const spec = SA.shoebox(5, 4, 3, { walls: 'plaster', ceiling: 'plaster', floor: 'plaster' }, 0.2);
    if (open) spec.loop[0].openings = [{ t0: 0.1, t1: 0.9, z0: 0.3, z1: 2.3, kind: 'window', mat: 'open' }];
    return SA.sabineEyring(SA.buildMesh(spec), null, { T: 20, RH: 50 }); };
  const a = se(false), b = se(true);
  ok(b.sabine[3] < 0.5 * a.sabine[3], `sabine 500 Hz open ${f2(b.sabine[3])} vs closed ${f2(a.sabine[3])}`);
  return `Sabine 500 Hz closed ${f2(a.sabine[3])} s → with 5.6 m² hole ${f2(b.sabine[3])} s`;
});
test('v3: truncated IR (T = 7 s cut at 3 s) still gives T30 within 10% (Lundeby compensation / T20 fallback)', () => {
  const fs = 16000, n = 3 * fs, x = new Float64Array(n), R = SA.rng(4); const T = 7;
  for (let i = 0; i < n; i++) { const g = Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R()); x[i] = g * Math.pow(10, -3 * i / fs / T); }
  x[0] = 30; const m = SA.decayParams(x, fs); ok(rel(m.T30[3], T) < 0.1 && rel(m.T30[4], T) < 0.1, `T30 ${f2(m.T30[3])} ${f2(m.T30[4])}`);
  return `T30 500/1k ${f2(m.T30[3])} / ${f2(m.T30[4])} s (true 7)`;
});
test('v3: UTD field is finite and continuous next to a shadow boundary', () => {
  const k = 2 * Math.PI * 500 / 343, v = e => SA.utdField(k, 2, 0.6, 0.6 + Math.PI + e, 3, 4, 1);
  const a = v(1e-3), b = v(1e-7), c = v(1e-12); ok(isFinite(c) && rel(b, a) < 0.05 && rel(c, a) < 0.05, `${a} ${b} ${c}`);
  return `|D| at ε = 1e-3/1e-7/1e-12: ${a.toFixed(4)} / ${b.toFixed(4)} / ${c.toFixed(4)}`;
});

// ---------------- v3 material physics tests ----------------
test('phys: thick porous layer -> surface impedance tends to the characteristic impedance (semi-infinite limit, ±2%)', () => {
  const Z = SA.phys.surfaceZ([{ type: 'porous', d: 2, sigma: 10000 }], 1000, 0), m = SA.phys.miki(1000, 10000, 343.2);
  ok(Math.abs(Z[0] - m.Zc[0]) / m.Zc[0] < 0.02 && Math.abs(Z[1] - m.Zc[1]) / Math.abs(m.Zc[1]) < 0.02, `${Z} vs ${m.Zc}`);
  return `Z ${Z[0].toFixed(0)}${Z[1].toFixed(0)}j vs Zc ${m.Zc[0].toFixed(0)}${m.Zc[1].toFixed(0)}j`;
});
test('phys: panel absorber peaks at the mass-spring resonance 60/sqrt(m·D) (±8%)', () => {
  const lay = [{ type: 'panel', m: 10, eta: 0.02 }, { type: 'air', d: 0.1 }]; lay.surf = 0;
  let best = 0, fb = 0; for (let f = 20; f < 200; f += 0.25) { const a = SA.phys.alphaAt(lay, f, 0); if (a > best) { best = a; fb = f; } }
  const f0 = SA.phys.resonanceHz('panel', { m: 10, gap: 0.1 });
  ok(Math.abs(fb - f0) / f0 < 0.08, `peak ${fb} Hz vs ${f0.toFixed(1)} Hz`); return `peak ${fb.toFixed(1)} Hz, formula ${f0.toFixed(1)} Hz (60/√(mD) = ${(60 / Math.sqrt(1)).toFixed(0)})`;
});
test('phys: perforated plate (Helmholtz) peaks at c/2π·sqrt(φ/(D(t+0.85d))) (±12%)', () => {
  const p = { t: 0.012, dh: 0.006, phi: 0.05, gap: 0.1, fleece: 150, surf: 0 }, lay = SA.phys.buildUp('perf', p);
  let best = 0, fb = 0; for (let f = 50; f < 1500; f += 1) { const a = SA.phys.alphaAt(lay, f, 0); if (a > best) { best = a; fb = f; } }
  const f0 = SA.phys.resonanceHz('perf', p); ok(Math.abs(fb - f0) / f0 < 0.12, `peak ${fb} vs ${f0.toFixed(0)}`);
  return `peak ${fb} Hz (α ${best.toFixed(2)}), formula ${f0.toFixed(0)} Hz`;
});
test('phys: every random construction is passive (Re Z ≥ 0) and 0 ≤ α ≤ 1', () => {
  const R = SA.rng(77); let n = 0;
  for (let i = 0; i < 150; i++) {
    const kind = ['porous', 'panel', 'perf', 'sheet', 'glazing'][i % 5];
    const p = { d: 0.01 + R() * 0.15, sigma: 3000 + R() * 60000, gap: R() * 0.4, m: 1 + R() * 40, fill: R() * 0.1, t: 0.001 + R() * 0.02, dh: 0.0005 + R() * 0.01, phi: 0.01 + R() * 0.3, fleece: R() * 400, R: 100 + R() * 1500, m2: R() < 0.5 ? 5 + R() * 20 : 0 };
    if (kind === 'glazing' && p.m2) p.gap = 0.01 + R() * 0.1;
    const lay = SA.phys.buildUp(kind, p);
    for (const f of [40, 63, 125, 250, 500, 1000, 4000]) for (const th of [0, 0.7, 1.3]) {
      const Z = SA.phys.surfaceZ(lay, f, th); const a = SA.phys.alphaAt(lay, f, th); n++;
      ok(Z === null || Z[0] >= -1e-6, `${kind} Re Z ${Z && Z[0]} at ${f} Hz`); ok(a >= 0 && a <= 1, `${kind} α ${a}`);
    }
  }
  return `${n} cases`;
});
test('phys: model vs measured table rows (rockwool 40/80 kg/m³, plasterboard, wood lining, plasterboard ceiling): rms Δα < 0.17', () => {
  const tab = { rw40: [0.23, 0.59, 0.86, 0.86, 0.86, 0.86], rw80: [0.22, 0.6, 0.92, 0.9, 0.88, 0.88], pb: [0.15, 0.1, 0.06, 0.04, 0.04, 0.05], wl: [0.27, 0.23, 0.22, 0.15, 0.1, 0.07], pc: [0.2, 0.15, 0.1, 0.08, 0.04, 0.02] };
  const mod = { rw40: ['porous', { d: 0.05, sigma: 12000 }], rw80: ['porous', { d: 0.05, sigma: 30000 }], pb: ['panel', { m: 20, gap: 0.05, fill: 0.05 }], wl: ['panel', { m: 7, gap: 0.05 }], pc: ['panel', { m: 10, gap: 0.4 }] };
  const out = [];
  for (const k of Object.keys(tab)) { const a = SA.phys.alphaOctaves(SA.phys.buildUp(...mod[k])).slice(1, 7); const e = Math.sqrt(a.reduce((s, v, i) => s + (v - tab[k][i]) ** 2, 0) / 6); out.push(`${k} ${e.toFixed(2)}`); ok(e < 0.17, `${k} rms ${e.toFixed(3)}`); }
  return 'rms ' + out.join(', ');
});
test('phys: 63 Hz of table materials comes from the construction model (panel rises, porous falls)', () => {
  require('./materials.js'); const M = SA.MATERIALS;
  ok(M.gypsum_stud.a63 === 'phys' && M.gypsum_stud.a[0] > M.gypsum_stud.a[1], 'stud wall should absorb more at 63 Hz (resonance ≈ 60 Hz)');
  ok(M.rockwool_panel.a[0] < M.rockwool_panel.a[1], 'porous panel should absorb less at 63 Hz');
  return `stud wall ${M.gypsum_stud.a[0]} vs ${M.gypsum_stud.a[1]} @125, rockwool panel ${M.rockwool_panel.a[0]} vs ${M.rockwool_panel.a[1]}`;
});

// ---------------- v3 frequency-dependent FDTD boundary tests ----------------
test('fdb: resistive-only branch reproduces the v2 boundary scheme (max diff < 1e-4 of peak)', () => {
  uni('uR3', 0.2, 0.1);
  const spec = SA.shoebox(4.2, 3.2, 2.6, { walls: 'uR3', ceiling: 'uR3', floor: 'uR3' }, 0.2);
  const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), M = SA.matArrays(mesh);
  const g = SA.voxelise(mesh, bvh, 0.15, [2, 1.5, 1.2], M); const b0 = SA.betaFromRandomAlpha((0.2 + 0.2 + 0.2) / 3);
  const g2 = Object.assign({}, g, { bParams: g.bParams.map(p => p.mat === 'exterior' ? p : { r: 1 / b0, m: 0, k: 0 }) });
  const A = SA.fdtdRun(g2, [1, 1, 1], [[3, 2, 1.5]], { T: 20, RH: 50 }, { tMax: 0.3, fmax: 300, dcBlock: false });
  const B = SA.fdtdRun(g, [1, 1, 1], [[3, 2, 1.5]], { T: 20, RH: 50 }, { tMax: 0.3, fmax: 300, dcBlock: false, fdb: false });
  let d = 0, e = 0; for (let i = 0; i < A.ir[0].length; i++) { d = Math.max(d, Math.abs(A.ir[0][i] - B.ir[0][i])); e = Math.max(e, Math.abs(B.ir[0][i])); }
  ok(A.fdb && !B.fdb && d < 1e-4 * e, `diff ${d} of ${e}`); return `max diff ${(d / e).toExponential(1)} of peak`;
});
test('fdb: fitted impedance reproduces table α at 63–500 Hz (|Δα| ≤ 0.1 for 8 materials)', () => {
  require('./materials.js'); const out = [];
  for (const id of ['plaster', 'gypsum_stud', 'plywood', 'carpet_thick', 'curtain_velour', 'rockwool_panel', 'audience', 'perforated_gypsum']) {
    const a = SA.MATERIALS[id].a, f = SA.fitBoundary(a); const e = Math.max(...f.alpha.map((v, i) => Math.abs(v - Math.min(0.95, a[i]))));
    ok(e <= 0.1, `${id}: fit ${f.alpha.map(v => v.toFixed(2))} vs ${a.slice(0, 4)}`); out.push(`${id} ${e.toFixed(2)}`);
  }
  return 'max |Δα| ' + out.join(', ');
});
// Grid (staircase) error of a reactive boundary grows with f·dx: at 180 Hz the FDTD |R| is 0.10 / 0.08 / 0.05 too high for
// dx = 8 / 6 / 4 cm (converges). Tolerance: ±0.05 at 63–125 Hz, ±0.10 at 180–250 Hz.
test('fdb: normal-incidence reflection in a rigid duct matches |(ζ−1)/(ζ+1)| of the fitted impedance (±0.05 ≤125 Hz, ±0.10 above)', () => {
  require('./materials.js'); uni('rig3', 0.0005, 0.01);
  const L = 16, Wd = 0.62, dx = 0.06, mat = 'rockwool_panel';
  const spec = { loop: [{ x: -0.1, y: -0.1, thick: 0.2, mat: 'rig3' }, { x: L + 0.1, y: -0.1, thick: 0.2, mat }, { x: L + 0.1, y: Wd + 0.1, thick: 0.2, mat: 'rig3' }, { x: -0.1, y: Wd + 0.1, thick: 0.2, mat: 'rig3' }], ceiling: { type: 'flat', h: Wd, mat: 'rig3' }, floorMat: 'rig3' };
  const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), M = SA.matArrays(mesh);
  const g = SA.voxelise(mesh, bvh, dx, [2, 0.31, 0.31], M); const P = g.bParams.find(p => p.mat === mat);
  const rx = 8, r = SA.fdtdRun(g, [0.3, 0.31, 0.31], [[rx, 0.31, 0.31]], { T: 20, RH: 50 }, { tMax: 0.1, fmax: 280, dcBlock: false, zeroMean: true });
  const x = r.ir[0], fs = r.fs, c = SA.soundSpeed(20, 50);
  const tI = (rx - 0.3) / c, tR = (2 * L - rx - 0.3) / c, split = Math.round((tI + tR) / 2 * fs), end = Math.round((tR + (tR - tI) / 2) * fs);
  const seg = (a, b) => x.slice(a, Math.min(b, x.length));
  const amp = (y, f) => { let re = 0, im = 0; for (let i = 0; i < y.length; i++) { re += y[i] * Math.cos(2 * Math.PI * f * i / fs); im -= y[i] * Math.sin(2 * Math.PI * f * i / fs); } return Math.hypot(re, im); };
  const I = seg(0, split), Rf = seg(split, end); const out = [];
  for (const f of [63, 125, 180, 250]) { const w = 2 * Math.PI * f, zi = w * P.m - P.k / w; const th = Math.sqrt(((P.r - 1) ** 2 + zi * zi) / ((P.r + 1) ** 2 + zi * zi)); const got = amp(Rf, f) / amp(I, f);
    ok(Math.abs(got - th) < (f <= 125 ? 0.05 : 0.10), `${f} Hz: FDTD |R| ${got.toFixed(3)} vs theory ${th.toFixed(3)}`); out.push(`${f}: ${got.toFixed(2)}/${th.toFixed(2)}`); }
  return '|R| FDTD/theory ' + out.join(', ');
});
test('fdb: long run with reactive walls (stud wall, wood lining, glass, curtains) stays finite and decays', () => {
  require('./materials.js');
  const spec = SA.shoebox(5.2, 4.2, 2.8, { s: 'gypsum_stud', e: 'wood_lining', n: 'glass_window', w: 'curtain_velour', ceiling: 'plasterboard_ceiling', floor: 'wood_floor' }, 0.2);
  const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), M = SA.matArrays(mesh);
  const g = SA.voxelise(mesh, bvh, 0.15, [2, 1.5, 1.2], M);
  const r = SA.fdtdRun(g, [1, 1, 1.2], [[3.9, 3.1, 1.5]], { T: 20, RH: 50 }, { tMax: 3, fmax: 300, source: 'diff' });
  const x = r.ir[0], n = x.length; let bad = 0, a = 0, b = 0;
  for (let i = 0; i < n; i++) { if (!isFinite(x[i])) bad++; if (i < n * 0.1) a += x[i] * x[i]; if (i > n * 0.9) b += x[i] * x[i]; }
  ok(!bad && b < a * 1e-4, `nan ${bad}, late/early ${b / a}`); return `${r.steps} steps, late/early energy ${(10 * Math.log10(b / a)).toFixed(0)} dB`;
});

test('lf: 저음 분석 peaks = analytic room modes of a 7.2×5.1×3.0 m box (each of the first 6 peaks within 2%)', () => {
  uni('h1lf', 0.03, 0.05);
  const spec = SA.shoebox(7.4, 5.3, 3.0, { walls: 'h1lf', ceiling: 'h1lf', floor: 'h1lf' }, 0.2);
  const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), M = SA.matArrays(mesh);
  const g = SA.voxelise(mesh, bvh, 0.1, [2, 1.5, 1.2], M);
  const r = SA.fdtdRun(g, [0.4, 0.4, 0.4], [[6.8, 4.7, 2.6]], { T: 20, RH: 50 }, { tMax: 1.5, fmax: 300 });
  const lf = SA.lowFreqResponse(r.ir[0], r.fs, 80); const c = SA.soundSpeed(20, 50); const modes = [];
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let d = 0; d < 3; d++) if (a || b || d) modes.push(c / 2 * Math.hypot(a / 7.2, b / 5.1, d / 3.0));
  const pk = lf.peaks.slice(0, 6).map(p => p.f);
  pk.forEach(f => { const e = Math.min(...modes.map(m => Math.abs(f - m) / m)); ok(e < 0.02, `peak ${f.toFixed(1)} Hz is ${(e * 100).toFixed(1)}% from the nearest mode`); });
  ok(pk.length >= 6 && Math.abs(pk[0] - c / 2 / 7.2) / (c / 2 / 7.2) < 0.02, 'first peak = (1,0,0)');
  return 'peaks ' + pk.map(f => f.toFixed(1)).join(', ') + ' Hz';
});

// ---------------- v4: shapes, furniture, robustness ----------------
function lostRays(spec, src, rcv) {
  const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), M = SA.matArrays(mesh);
  return { mesh, r: SA.rayTrace(mesh, bvh, M, src, rcv, { T: 20, RH: 50 }, { rays: 3000, tMax: 0.6 }) };
}
test('v4: curved wall = circular arc with the stated sagitta, bulging outward; round room area = πr²', () => {
  uni('u4', 0.2, 0.3); const s = SA.shoebox(6, 4, 3, { walls: 'u4', floor: 'u4', ceiling: 'u4' }); s.loop[0].bulge = 0.3;
  const m = SA.buildMesh(s); const ymin = Math.min(...m.inner.map(p => p[1]));
  ok(Math.abs(ymin - (-0.3 * 3 + 0.1)) < 0.03, 'inner lowest point ' + ymin); // sagitta 0.9 m below the chord, minus half the wall
  const r = 8, b = Math.tan(Math.PI / 8); const W = (x, y) => ({ x: x + 8.5, y: y + 8.5, thick: 0.3, mat: 'u4', bulge: b });
  const m2 = SA.buildMesh({ loop: [[r, 0], [0, r], [-r, 0], [0, -r]].map(([x, y]) => W(x, y)), ceiling: { type: 'flat', h: 6, mat: 'u4' }, floorMat: 'u4' });
  const A = SA.polyArea(m2.inner), ref = Math.PI * (r - 0.15) ** 2; ok(A > 0 && Math.abs(A - ref) / ref < 0.02, 'area ' + A);
  return `lowest inner point ${ymin.toFixed(2)} m (expected −0.80), round room ${A.toFixed(1)} vs ${ref.toFixed(1)} m²`;
});
test('v4: closed meshes with curved walls, curved partition, hex/oct columns, furniture, vault and dome (rays lost < 0.2%)', () => {
  uni('u4', 0.2, 0.3); const out = [];
  const cases = {
    arc: s => { s.loop[0].bulge = 0.3; s.loop[2].bulge = -0.2; },
    partition: s => { s.partitions = [{ a: [1, 1.5], b: [5, 1.5], thick: 0.15, h: 0, mat: 'u4', bulge: -0.5, openings: [] }]; },
    columns: s => { s.columns = [{ x: 1, y: 1, r: 0.3, shape: 'hex', mat: 'u4' }, { x: 5, y: 1, r: 0.3, shape: 'oct', mat: 'u4' }]; },
    furniture: s => { s.furniture = Object.keys(SA.FURNITURE).map((t, i) => ({ type: t, x: 0.8 + (i % 6) * 0.9, y: i < 6 ? 0.9 : 3.3, rot: i * 20, w: 0.6, d: 0.4, mat: 'u4' })); },
    vault: s => { s.ceiling = { type: 'vault', h: 3, rise: 1.5, axis: 1, mat: 'u4' }; },
    dome: s => { s.ceiling = { type: 'dome', h: 3, rise: 1.5, mat: 'u4' }; },
  };
  for (const [k, f] of Object.entries(cases)) {
    const s = SA.shoebox(6, 4, 3, { walls: 'u4', floor: 'u4', ceiling: 'u4' }); f(s);
    const { r } = lostRays(s, [3, 2.4, 1.6], [4.5, 2.6, 1.6]); ok(r.lost < 0.002, `${k}: lost ${r.lost}`); out.push(`${k} ${(r.lost * 100).toFixed(2)}%`);
  }
  return out.join(', ');
});
test('v4: zero-length wall (duplicate vertex) and a window at the very corner no longer leak', () => {
  uni('u4', 0.2, 0.3); SA.defMat('g200', { a: Array(8).fill(0.05), s: Array(8).fill(0.05), tl: Array(8).fill(200) });
  const s = SA.shoebox(4, 3, 3, { walls: 'u4', floor: 'u4', ceiling: 'u4' }); s.loop.splice(1, 0, Object.assign({}, s.loop[1]));
  const a = lostRays(s, [1, 1, 1.5], [3, 2, 1.5]).r.lost;
  const s2 = SA.shoebox(4, 3, 3, { walls: 'u4', floor: 'u4', ceiling: 'u4' }); s2.loop[1].openings = [{ t0: 0, t1: 0.4, z0: 0.9, z1: 2.2, kind: 'window', mat: 'g200' }];
  const b = lostRays(s2, [1, 1, 1.5], [3, 2, 1.5]).r.lost;
  ok(a < 0.002 && b < 0.002, `dup vertex lost ${a}, corner window lost ${b}`);
  return `lost: duplicate vertex ${(a * 100).toFixed(2)}% (was 17.5%), corner window ${(b * 100).toFixed(2)}% (was 16%)`;
});
test('v4: insideSolid finds points inside furniture, columns, partitions and platforms (and not in the air)', () => {
  uni('u4', 0.2, 0.3); const s = SA.shoebox(6, 4, 3, { walls: 'u4', floor: 'u4', ceiling: 'u4' });
  s.platforms = [{ poly: [[1, 1], [2, 1], [2, 2], [1, 2]], h: 0.75, mat: 'u4' }]; s.columns = [{ x: 4, y: 3, r: 0.3 }];
  s.furniture = [{ type: 'table', x: 4.5, y: 1 }, { type: 'sofa', x: 1.5, y: 3.2 }]; s.partitions = [{ a: [3, 0.5], b: [3, 3.5], thick: 0.2, h: 0, mat: 'u4', openings: [] }];
  const m = SA.buildMesh(s), b = SA.buildBVH(m.tris);
  const inS = [[1.5, 1.5, 0.5], [4, 3, 1], [4.5, 1, 0.73], [3, 2, 1], [1.5, 3.2, 0.3]], air = [[1.5, 1.5, 1.2], [4.6, 3, 1], [4.5, 1, 0.5], [3.3, 2, 1], [5, 2, 1.5], [1.5, 3.2, 1.2]];
  inS.forEach(p => ok(SA.insideSolid(m, b, p), 'should be inside: ' + p)); air.forEach(p => ok(!SA.insideSolid(m, b, p), 'should be air: ' + p));
  return `${inS.length} inside, ${air.length} in the air — all correct`;
});
test('v4: furniture volume and parts follow size and rotation', () => {
  const f = { type: 'bookshelf', x: 2, y: 2, rot: 90, w: 2, d: 0.5, h: 2 }; const P = SA.furnitureParts(f);
  ok(P.length === 1 && Math.abs(Math.abs(SA.polyArea(P[0].poly)) - 1) < 1e-9, 'area'); const xs = P[0].poly.map(p => p[0]);
  ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 0.5) < 1e-9, 'rotated 90°: x-extent = depth');
  const s = SA.shoebox(6, 4, 3, {}); const v0 = SA.buildMesh(s).volume; s.furniture = [f]; const v1 = SA.buildMesh(s).volume;
  ok(Math.abs(v0 - v1 - 2) < 1e-6, 'volume drop ' + (v0 - v1)); return `volume −${(v0 - v1).toFixed(2)} m³ (2 × 0.5 × 2)`;
});

const pass = results.filter(r => r[0]).length;
results.forEach(([p, n, info, ms]) => console.log(`${p ? 'PASS' : 'FAIL'}  ${n}  — ${info}  [${ms} ms]`));
console.log(`\nTests ${pass}/${results.length}`);
process.exitCode = pass === results.length ? 0 : 1;
