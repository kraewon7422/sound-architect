/* Sound Architect — acoustic core (no DOM). Loaded by index.html and by Node tests (vm).
 * Units: metres, seconds, Kelvin/°C noted. Octave bands 63..8000 Hz.
 * Pipeline: spec -> buildMesh -> (image sources + ray tracing + edge diffraction) + FDTD (low band) -> synthIR
 */
(function (root) {
  'use strict';
  const BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
  const NB = BANDS.length;

  // ---------- small vector helpers ----------
  const v3 = (x, y, z) => [x, y, z];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // ---------- deterministic RNG (mulberry32) ----------
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- air: ISO 9613-1 absorption, speed of sound ----------
  /** attenuation in dB/m at frequency f (Hz), temperature tC (°C), relative humidity rh (%), pressure pa (kPa) */
  function airAbsDb(f, tC, rh, pa) {
    pa = pa || 101.325;
    const pr = 101.325, T = tC + 273.15, T0 = 293.15, T01 = 273.16;
    const psat = pr * Math.pow(10, -6.8346 * Math.pow(T01 / T, 1.261) + 4.6151);
    const h = rh * (psat / pa);
    const frO = (pa / pr) * (24 + 4.04e4 * h * (0.02 + h) / (0.391 + h));
    const frN = (pa / pr) * Math.pow(T / T0, -0.5) * (9 + 280 * h * Math.exp(-4.170 * (Math.pow(T / T0, -1 / 3) - 1)));
    const f2 = f * f;
    return 8.686 * f2 * (1.84e-11 * (pr / pa) * Math.sqrt(T / T0) +
      Math.pow(T / T0, -2.5) * (0.01275 * Math.exp(-2239.1 / T) / (frO + f2 / frO) +
        0.1068 * Math.exp(-3352.0 / T) / (frN + f2 / frN)));
  }
  /** energy attenuation coefficient m (1/m) per band: E(d) = E0 * exp(-m d) */
  function airM(tC, rh) { return BANDS.map(f => airAbsDb(f, tC, rh) / (10 * Math.LOG10E)); }
  /** speed of sound, dry-air ideal gas + small humidity term (Cramer-like linearisation) */
  function soundSpeed(tC, rh) { return 331.3 * Math.sqrt(1 + tC / 273.15) + 0.0124 * (rh || 0) * (tC > 0 ? tC / 20 : 0.2); }

  // ---------- materials (filled/overridden by materials table) ----------
  // a: absorption per band [63..8k], s: scattering per band, tl: transmission loss dB per band (for whole construction)
  const MATERIALS = {};
  function defMat(id, o) { MATERIALS[id] = Object.assign({ id, a: Array(NB).fill(0.05), s: Array(NB).fill(0.05), tl: Array(NB).fill(80), color: '#bbb', tex: 'plain' }, o); }
  defMat('exterior', { a: Array(NB).fill(1), s: Array(NB).fill(0), tl: Array(NB).fill(200), hidden: true });
  defMat('open', { a: Array(NB).fill(1), s: Array(NB).fill(0), tl: Array(NB).fill(0), hidden: true });

  // ---------- geometry: plan spec -> triangle mesh ----------
  /* spec = {
       loop: [{x,y,thick,mat,matOut,bulge,openings:[{t0,t1,z0,z1,kind,mat}]}...]  closed outer boundary, vertex i -> segment i..i+1
       ceiling: {type:'flat'|'shed'|'gable'|'vault', h, rise, axis:0|1, mat}, floorMat,
       partitions: [{a:[x,y], b:[x,y], thick, h, mat, openings:[]}],
       columns:[{x,y,r,shape:'round'|'square',mat}], platforms:[{poly:[[x,y]..], h, z, mat, under:bool}],
       balconies:[{poly, z, thick, mat}]
     } */
  function ceilingFn(spec, bb) {
    const c = spec.ceiling || { type: 'flat', h: 3 };
    const H = c.h || 3, rise = c.rise || 0, axis = c.axis || 0;
    const lo = axis ? bb.y0 : bb.x0, hi = axis ? bb.y1 : bb.x1;
    const span = Math.max(hi - lo, 1e-6);
    return (x, y) => {
      const u = ((axis ? y : x) - lo) / span; // 0..1 across
      const uc = Math.min(1, Math.max(0, u));
      switch (c.type) {
        case 'shed': return H + rise * uc;
        case 'gable': return H + rise * (1 - Math.abs(2 * uc - 1));
        case 'vault': return H + rise * Math.sqrt(Math.max(0, 1 - Math.pow(2 * uc - 1, 2)));
        default: return H;
      }
    };
  }

  function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; }

  /** discretise loop (arcs via bulge = sagitta/half-chord) into straight segments carrying wall props */
  function discretiseLoop(loop) {
    const segs = [];
    for (let i = 0; i < loop.length; i++) {
      const A = loop[i], B = loop[(i + 1) % loop.length];
      const b = A.bulge || 0;
      if (Math.abs(b) < 1e-4) { segs.push({ a: [A.x, A.y], b: [B.x, B.y], w: A, src: i, arc: false }); continue; }
      // arc through A,B with bulge b (tan(theta/4)), positive = bulge to the right of A->B (outward for CCW)
      const dx = B.x - A.x, dy = B.y - A.y, chord = Math.hypot(dx, dy);
      const theta = 4 * Math.atan(b), r = chord / (2 * Math.sin(theta / 2));
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      const nx = dy / chord, ny = -dx / chord; // right normal
      const d = r * Math.cos(theta / 2);
      const cx = mx - nx * d, cy = my - ny * d;
      const a0 = Math.atan2(A.y - cy, A.x - cx);
      const arcLen = Math.abs(r * theta);
      const n = Math.max(4, Math.ceil(arcLen / 0.6));
      let prev = [A.x, A.y];
      for (let k = 1; k <= n; k++) {
        const ang = a0 - theta * k / n;
        const p = k === n ? [B.x, B.y] : [cx + Math.abs(r) * Math.cos(ang) * Math.sign(r), cy + Math.abs(r) * Math.sin(ang) * Math.sign(r)];
        segs.push({ a: prev, b: p, w: A, src: i, arc: true });
        prev = p;
      }
    }
    return segs;
  }

  function lineIntersect(p, d, q, e) { // p + t d = q + s e
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
    return [p[0] + d[0] * t, p[1] + d[1] * t];
  }

  function buildMesh(spec) {
    const tris = []; // {a,b,c (3d), n, mat, uv:[[u,v]x3], wall, edgeFree}
    const edges = []; // diffraction edges {p0,p1,n1,n2}
    let loop = spec.loop.slice();
    if (polyArea(loop.map(w => [w.x, w.y])) < 0) { // make CCW; reverse keeps wall props on correct segment
      const r = []; const n = loop.length;
      for (let i = 0; i < n; i++) { const w = Object.assign({}, loop[(n - i) % n]); const prevW = loop[(n - i - 1 + n) % n]; Object.assign(w, { thick: prevW.thick, mat: prevW.mat, matOut: prevW.matOut, bulge: -(prevW.bulge || 0), openings: (prevW.openings || []).map(o => Object.assign({}, o, { t0: 1 - o.t1, t1: 1 - o.t0 })) }); r.push(w); }
      loop = r;
    }
    const segs = discretiseLoop(loop);
    const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    segs.forEach(s => { [s.a, s.b].forEach(p => { bb.x0 = Math.min(bb.x0, p[0]); bb.y0 = Math.min(bb.y0, p[1]); bb.x1 = Math.max(bb.x1, p[0]); bb.y1 = Math.max(bb.y1, p[1]); }); });
    const zc = ceilingFn(spec, bb);
    const flatCeil = !spec.ceiling || spec.ceiling.type === 'flat' || !spec.ceiling.rise;
    // offset lines: inner (left of CCW direction) and outer
    const N = segs.length;
    const L = segs.map(s => {
      const d = norm([s.b[0] - s.a[0], s.b[1] - s.a[1], 0]);
      const nIn = [-d[1], d[0]]; const t = (s.w.thick || 0.2) / 2;
      return { d: [d[0], d[1]], nIn, t, a: s.a, len: Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) };
    });
    const corner = (i, side) => { // miter point at start of seg i
      const P = L[(i - 1 + N) % N], C = L[i];
      const sp = side * 1; // +1 inner, -1 outer
      const p1 = [P.a[0] + P.nIn[0] * P.t * sp, P.a[1] + P.nIn[1] * P.t * sp];
      const p2 = [C.a[0] + C.nIn[0] * C.t * sp, C.a[1] + C.nIn[1] * C.t * sp];
      const X = lineIntersect(p1, P.d, p2, C.d);
      return X || p2;
    };
    const inner = [], outer = [];
    for (let i = 0; i < N; i++) { inner.push(corner(i, 1)); outer.push(corner(i, -1)); }

    function pushTri(a, b, c, mat, uvs, meta) {
      const n = cross(sub(b, a), sub(c, a)); const l = len(n);
      if (l < 1e-10) return;
      tris.push({ a, b, c, n: mul(n, 1 / l), area: l / 2, mat, uv: uvs, meta: meta || null });
    }
    function quad(p0, p1, p2, p3, mat, uv, meta) { // CCW seen from the front
      pushTri(p0, p1, p2, mat, [uv[0], uv[1], uv[2]], meta); pushTri(p0, p2, p3, mat, [uv[0], uv[2], uv[3]], meta);
    }

    /* wall face generator: a vertical face along a line, between t-range [ta,tb] (t measured along direction d from origin o),
       offset 'off' along nIn; facing: +1 faces nIn side, -1 faces opposite. Holes: [{t0,t1,z0,z1}] in same t coords. */
    function wallFace(o, d, nIn, off, ta, tb, holes, mat, facing, topFn, meta) {
      const P = t => [o[0] + d[0] * t + nIn[0] * off, o[1] + d[1] * t + nIn[1] * off];
      const brk = new Set([ta, tb]);
      holes.forEach(h => { if (h.t0 > ta && h.t0 < tb) brk.add(h.t0); if (h.t1 > ta && h.t1 < tb) brk.add(h.t1); });
      if (!flatCeil || meta && meta.subdiv) { const n = Math.ceil((tb - ta) / 0.5); for (let k = 1; k < n; k++) brk.add(ta + (tb - ta) * k / n); }
      const ts = [...brk].sort((x, y) => x - y);
      for (let k = 0; k < ts.length - 1; k++) {
        const t0 = ts[k], t1 = ts[k + 1]; if (t1 - t0 < 1e-6) continue;
        const tm = (t0 + t1) / 2;
        const pa = P(t0), pb = P(t1);
        const za = topFn(pa[0], pa[1]), zb = topFn(pb[0], pb[1]);
        // vertical intervals not in holes
        const hs = holes.filter(h => h.t0 <= tm && h.t1 >= tm).map(h => [h.z0, h.z1]).sort((x, y) => x[0] - y[0]);
        let z = 0; const intervals = [];
        hs.forEach(([h0, h1]) => { if (h0 > z) intervals.push([z, h0]); z = Math.max(z, h1); });
        intervals.push([z, null]); // up to top
        intervals.forEach(([z0, z1]) => {
          const zat = z1 === null ? za : Math.min(z1, za), zbt = z1 === null ? zb : Math.min(z1, zb);
          if (zat - z0 < 1e-6 && zbt - z0 < 1e-6) return;
          const A = [pa[0], pa[1], z0], B = [pb[0], pb[1], z0], C = [pb[0], pb[1], zbt], D = [pa[0], pa[1], zat];
          const uv = [[t0, z0], [t1, z0], [t1, zbt], [t0, zat]];
          // front side must face +nIn*facing: CCW order seen from that side
          // (B-A)x(D-A) = d x z = right normal = -nIn  -> A,B,C,D faces away from nIn
          if (facing < 0) quad(A, B, C, D, mat, uv, meta); else quad(B, A, D, C, mat, [uv[1], uv[0], uv[3], uv[2]], meta);
        });
      }
    }
    /* diffraction edge frame: f0 = direction along face A pointing into the solid (away from the edge), nA = face A normal,
       ext = exterior (air-side) wedge angle. Angles of points are measured from f0, rotating through the nA side. */
    function addEdge(p0, p1, n1, n2) {
      if (len(sub(p1, p0)) <= 0.05) return;
      const eu = norm(sub(p1, p0)); let f0 = norm(cross(n1, eu)); if (dot(f0, n2) > 0) f0 = mul(f0, -1);
      edges.push({ p0, p1, f0, nA: n1, ext: Math.PI + Math.acos(Math.max(-1, Math.min(1, dot(n1, n2)))) });
    }
    function addThinEdge(p0, p1, nA, f0) { if (len(sub(p1, p0)) > 0.05) edges.push({ p0, p1, f0, nA, ext: 2 * Math.PI, thin: true }); }
    const THIN = 0.35;

    // --- outer loop walls
    let openArea = 0;
    for (let i = 0; i < N; i++) {
      const s = segs[i], Li = L[i], w = s.w;
      const o = s.a, d = Li.d, nIn = Li.nIn;
      const tIn0 = dot2(sub2(inner[i], o), d), tIn1 = dot2(sub2(inner[(i + 1) % N], o), d);
      const tOut0 = dot2(sub2(outer[i], o), d), tOut1 = dot2(sub2(outer[(i + 1) % N], o), d);
      // openings only on straight (non-arc) walls; fractions of the original wall length
      let holes = [];
      if (!s.arc && w.openings && w.openings.length) {
        const wl = Li.len;
        holes = w.openings.map(op => ({ t0: op.t0 * wl, t1: op.t1 * wl, z0: op.z0, z1: op.z1, op }));
        // an open hole in the outer boundary is a perfect absorber (α = 1) for the classic formulas
        holes.forEach(h => { if (!h.op.mat || h.op.mat === 'open') openArea += (h.t1 - h.t0) * (h.z1 - h.z0); });
      }
      const matIn = w.mat || 'plaster', matOut = 'exterior';
      wallFace(o, d, nIn, Li.t, tIn0, tIn1, holes, matIn, 1, zc, { wall: i, side: 'in', src: s.src });
      wallFace(o, d, nIn, -Li.t, tOut0, tOut1, holes, matOut, -1, zc, { wall: i, side: 'out', src: s.src, vis: 'facade' });
      // wall top cap (follows ceiling) — exterior
      holes.forEach(h => addOpening(o, d, nIn, Li.t, h, matIn, zc, i));
      // top cap between inner and outer face (faces up)
      { const pi0 = inner[i], pi1 = inner[(i + 1) % N], po0 = outer[i], po1 = outer[(i + 1) % N];
        const nsub = flatCeil ? 1 : Math.max(1, Math.ceil(Li.len / 0.5));
        for (let k = 0; k < nsub; k++) {
          const f0 = k / nsub, f1 = (k + 1) / nsub, lerp = (p, q, f) => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
          const a = lerp(pi0, pi1, f0), b = lerp(pi0, pi1, f1), c = lerp(po0, po1, f1), dd = lerp(po0, po1, f0);
          quad([a[0], a[1], zc(a[0], a[1])], [dd[0], dd[1], zc(a[0], a[1])], [c[0], c[1], zc(b[0], b[1])], [b[0], b[1], zc(b[0], b[1])], 'exterior',
            [[a[0], a[1]], [dd[0], dd[1]], [c[0], c[1]], [b[0], b[1]]], { wall: i, cap: 1, vis: matIn });
        }
      }
    }
    function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }
    function sub2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }

    function addOpening(o, d, nIn, t, h, matIn, topFn, wallId) {
      const P = (tt, off) => [o[0] + d[0] * tt + nIn[0] * off, o[1] + d[1] * tt + nIn[1] * off];
      const op = h.op;
      const jm = op.jamb || matIn;
      // left jamb (at t0) faces +d, right jamb (at t1) faces -d; sill faces up; lintel faces down
      const a0 = P(h.t0, t), b0 = P(h.t0, -t), a1 = P(h.t1, t), b1 = P(h.t1, -t);
      quad([b0[0], b0[1], h.z0], [a0[0], a0[1], h.z0], [a0[0], a0[1], h.z1], [b0[0], b0[1], h.z1], jm, [[0, h.z0], [2 * t, h.z0], [2 * t, h.z1], [0, h.z1]], { wall: wallId, jamb: 1 });
      quad([a1[0], a1[1], h.z0], [b1[0], b1[1], h.z0], [b1[0], b1[1], h.z1], [a1[0], a1[1], h.z1], jm, [[0, h.z0], [2 * t, h.z0], [2 * t, h.z1], [0, h.z1]], { wall: wallId, jamb: 1 });
      if (h.z0 > 0.001) quad([a0[0], a0[1], h.z0], [b0[0], b0[1], h.z0], [b1[0], b1[1], h.z0], [a1[0], a1[1], h.z0], jm, [[0, 0], [2 * t, 0], [2 * t, 1], [0, 1]], { wall: wallId, jamb: 1 });
      quad([a1[0], a1[1], h.z1], [b1[0], b1[1], h.z1], [b0[0], b0[1], h.z1], [a0[0], a0[1], h.z1], jm, [[0, 0], [2 * t, 0], [2 * t, 1], [0, 1]], { wall: wallId, jamb: 1 });
      // glazing / door leaf inside the opening (mid-plane), if any material other than open
      if (op.mat && op.mat !== 'open') {
        // the two faces sit 1 mm apart: coplanar opposite faces let a ray hit the back face first and then
        // skip the front one (t < tmin) -> the leaf became ~75 % transparent (v3 fix)
        // the face whose normal points along nIn must be the one nearer the room (+LG), its twin at -LG
        const nA = cross(sub([o[0] + d[0], o[1] + d[1], 0], [o[0], o[1], 0]), [0, 0, 1]); // normal of quad(A,B,C,D) = d × z
        const LG = (nA[0] * nIn[0] + nA[1] * nIn[1] > 0 ? 1 : -1) * 0.0005;
        const m0 = P(h.t0, LG), m1 = P(h.t1, LG), n0 = P(h.t0, -LG), n1 = P(h.t1, -LG);
        const A = [m0[0], m0[1], h.z0], B = [m1[0], m1[1], h.z0], C = [m1[0], m1[1], h.z1], D = [m0[0], m0[1], h.z1];
        const A2 = [n0[0], n0[1], h.z0], B2 = [n1[0], n1[1], h.z0], C2 = [n1[0], n1[1], h.z1], D2 = [n0[0], n0[1], h.z1];
        const uv = [[h.t0, h.z0], [h.t1, h.z0], [h.t1, h.z1], [h.t0, h.z1]];
        quad(A, B, C, D, op.mat, uv, { wall: wallId, leaf: 1, side: 'in' });
        quad(B2, A2, D2, C2, op.mat, [uv[1], uv[0], uv[3], uv[2]], { wall: wallId, leaf: 1, side: 'out', outside: typeof wallId === 'number' ? 1 : 0 });
      } else {
        // free edges of an open doorway: vertical edges at inner face (wedge interior 90° -> exterior 270°)
        const nd = [d[0], d[1], 0], ni = [nIn[0], nIn[1], 0];
        if (2 * t <= THIN) { // thin wall: each jamb acts as one half-plane edge at mid-thickness
          const m0 = P(h.t0, 0), m1 = P(h.t1, 0);
          addThinEdge([m0[0], m0[1], h.z0], [m0[0], m0[1], h.z1], ni, mul(nd, -1));
          addThinEdge([m1[0], m1[1], h.z0], [m1[0], m1[1], h.z1], ni, nd);
          if (h.z1 < topFn(m0[0], m0[1]) - 0.05) { // lintel edge
            addThinEdge([m0[0], m0[1], h.z1], [m1[0], m1[1], h.z1], ni, [0, 0, 1]);
          }
        } else {
          addEdge([a0[0], a0[1], h.z0], [a0[0], a0[1], h.z1], ni, nd);
          addEdge([a1[0], a1[1], h.z0], [a1[0], a1[1], h.z1], ni, mul(nd, -1));
          addEdge([b0[0], b0[1], h.z0], [b0[0], b0[1], h.z1], mul(ni, -1), nd);
          addEdge([b1[0], b1[1], h.z0], [b1[0], b1[1], h.z1], mul(ni, -1), mul(nd, -1));
        }
      }
    }

    // --- floor & ceiling over the inner polygon (subdivided boundary)
    const innerFine = [];
    for (let i = 0; i < N; i++) {
      const p = inner[i], q = inner[(i + 1) % N];
      const n = flatCeil ? 1 : Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.5));
      for (let k = 0; k < n; k++) innerFine.push([p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n]);
    }
    const floorMat = spec.floorMat || 'wood_floor', ceilMat = (spec.ceiling && spec.ceiling.mat) || 'plaster';
    const fl = earClip(inner);
    fl.forEach(([i, j, k]) => {
      const A = inner[i], B = inner[j], C = inner[k];
      pushTri([A[0], A[1], 0], [B[0], B[1], 0], [C[0], C[1], 0], floorMat, [A, B, C], { floor: 1 }); // CCW from above -> faces up
      if (flatCeil) pushTri([A[0], A[1], zc(A[0], A[1])], [C[0], C[1], zc(C[0], C[1])], [B[0], B[1], zc(B[0], B[1])], ceilMat, [A, C, B], { ceiling: 1 });
    });
    if (!flatCeil) {
      // curved/sloped ceiling: square grid cells clipped to the inner polygon (convex cell clips concave polygon), then lifted.
      // Cell edges are aligned with the wall subdivision points via the shared boundary polyline innerFine.
      const cs = 0.75; const poly = innerFine;
      for (let gx = Math.floor(bb.x0 / cs) * cs; gx < bb.x1; gx += cs) for (let gy = Math.floor(bb.y0 / cs) * cs; gy < bb.y1; gy += cs) {
        const piece = clipPolyRect(poly, gx, gy, gx + cs, gy + cs);
        if (piece.length < 3 || Math.abs(polyArea(piece)) < 1e-6) continue;
        earClip(piece).forEach(([i, j, k]) => {
          const P = piece[i], Q = piece[j], R = piece[k];
          pushTri([P[0], P[1], zc(P[0], P[1])], [R[0], R[1], zc(R[0], R[1])], [Q[0], Q[1], zc(Q[0], Q[1])], ceilMat, [P, R, Q], { ceiling: 1 });
        });
      }
    }

    // --- partitions (free-standing interior walls): both faces + end caps + top cap if lower than ceiling
    (spec.partitions || []).forEach((pw, pi) => {
      const a = pw.a, b = pw.b; const ln = Math.hypot(b[0] - a[0], b[1] - a[1]); if (ln < 0.05) return;
      const d = [(b[0] - a[0]) / ln, (b[1] - a[1]) / ln], nI = [-d[1], d[0]], t = (pw.thick || 0.15) / 2;
      const top = (x, y) => Math.min(pw.h || 1e9, zc(x, y) );
      const holes = (pw.openings || []).map(op => ({ t0: op.t0 * ln, t1: op.t1 * ln, z0: op.z0, z1: op.z1, op }));
      const mat = pw.mat || 'plaster', mat2 = pw.mat2 || mat;
      wallFace(a, d, nI, t, 0, ln, holes, mat, 1, top, { part: pi, side: 'L' });
      wallFace(a, d, nI, -t, 0, ln, holes, mat2, -1, top, { part: pi, side: 'R' });
      holes.forEach(h => addOpening(a, d, nI, t, h, mat, top, 'p' + pi));
      // end caps
      const P = (tt, off) => [a[0] + d[0] * tt + nI[0] * off, a[1] + d[1] * tt + nI[1] * off];
      const cap = (tt, dir) => {
        const p1 = P(tt, t), p2 = P(tt, -t), z1 = top(p1[0], p1[1]), z2 = top(p2[0], p2[1]);
        if (dir < 0) quad([p1[0], p1[1], 0], [p2[0], p2[1], 0], [p2[0], p2[1], z2], [p1[0], p1[1], z1], mat, [[0, 0], [2 * t, 0], [2 * t, z2], [0, z1]], { part: pi, cap: 1 });
        else quad([p2[0], p2[1], 0], [p1[0], p1[1], 0], [p1[0], p1[1], z1], [p2[0], p2[1], z2], mat, [[0, 0], [2 * t, 0], [2 * t, z1], [0, z2]], { part: pi, cap: 1 });
        const nd = [d[0] * dir, d[1] * dir, 0], ni = [nI[0], nI[1], 0];
        if (2 * t <= THIN) { const pm = P(tt, 0); addThinEdge([pm[0], pm[1], 0], [pm[0], pm[1], Math.min(z1, z2)], ni, mul(nd, -1)); }
        else { addEdge([p1[0], p1[1], 0], [p1[0], p1[1], z1], ni, nd); addEdge([p2[0], p2[1], 0], [p2[0], p2[1], z2], mul(ni, -1), nd); }
      };
      cap(0, -1); cap(ln, 1);
      if (pw.h && pw.h < zc(a[0], a[1]) - 0.01) {
        const p1 = P(0, t), p2 = P(ln, t), p3 = P(ln, -t), p4 = P(0, -t), z = pw.h;
        quad([p4[0], p4[1], z], [p3[0], p3[1], z], [p2[0], p2[1], z], [p1[0], p1[1], z], mat, [[0, 0], [ln, 0], [ln, 2 * t], [0, 2 * t]], { part: pi, top: 1 });
        if (2 * t <= THIN) { const q0 = P(0, 0), q1 = P(ln, 0); addThinEdge([q0[0], q0[1], z], [q1[0], q1[1], z], [nI[0], nI[1], 0], [0, 0, -1]); }
        else {
          addEdge([p1[0], p1[1], z], [p2[0], p2[1], z], [nI[0], nI[1], 0], [0, 0, 1]);
          addEdge([p4[0], p4[1], z], [p3[0], p3[1], z], [-nI[0], -nI[1], 0], [0, 0, 1]);
        }
      }
    });

    // --- columns
    (spec.columns || []).forEach((c, ci) => {
      const sides = c.shape === 'square' ? 4 : 16, r = c.r || 0.25, mat = c.mat || 'concrete';
      const top = zc(c.x, c.y) + 0.02;
      const pts = []; for (let k = 0; k < sides; k++) { const an = (k + (c.shape === 'square' ? 0.5 : 0)) * 2 * Math.PI / sides; pts.push([c.x + r * Math.cos(an) * (c.shape === 'square' ? Math.SQRT2 : 1), c.y + r * Math.sin(an) * (c.shape === 'square' ? Math.SQRT2 : 1)]); }
      let u = 0;
      for (let k = 0; k < sides; k++) {
        const p = pts[k], q = pts[(k + 1) % sides]; const sl = Math.hypot(q[0] - p[0], q[1] - p[1]);
        quad([p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], top], [p[0], p[1], top], mat, [[u, 0], [u + sl, 0], [u + sl, top], [u, top]], { column: ci });
        if (c.shape === 'square') {
          const prev = pts[(k - 1 + sides) % sides];
          const n1 = norm([q[1] - p[1], p[0] - q[0], 0]), n0 = norm([p[1] - prev[1], prev[0] - p[0], 0]);
          addEdge([p[0], p[1], 0], [p[0], p[1], top - 0.02], n0, n1);
        }
        u += sl;
      }
    });

    // --- platforms / stage / risers / furniture blocks (extruded polygons)
    (spec.platforms || []).forEach((pl, k) => extrude(pl.poly, pl.z || 0, (pl.z || 0) + (pl.h || 0.5), pl.mat || 'wood_panel', pl.topMat || pl.mat || 'wood_floor', { plat: k }, true));
    // --- balconies (slabs in mid air)
    (spec.balconies || []).forEach((bl, k) => extrude(bl.poly, bl.z - (bl.thick || 0.3), bl.z, bl.mat || 'concrete', bl.topMat || 'carpet', { balc: k }, false));

    function extrude(poly, z0, z1, matSide, matTop, meta, onFloor) {
      let p = poly.slice(); if (polyArea(p) < 0) p.reverse();
      const n = p.length; let u = 0;
      for (let i = 0; i < n; i++) {
        const a = p[i], b = p[(i + 1) % n]; const sl = Math.hypot(b[0] - a[0], b[1] - a[1]);
        // outward face for CCW polygon: right side -> order a,b reversed when looking from outside
        quad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1], matSide, [[u, z0], [u + sl, z0], [u + sl, z1], [u, z1]], meta);
        const prev = p[(i - 1 + n) % n];
        const nOut = norm([b[1] - a[1], a[0] - b[0], 0]), nPrev = norm([a[1] - prev[1], prev[0] - a[0], 0]);
        if (cross([a[0] - prev[0], a[1] - prev[1], 0], [b[0] - a[0], b[1] - a[1], 0])[2] > 0) addEdge([a[0], a[1], z0 + (onFloor ? 0 : 0)], [a[0], a[1], z1], nPrev, nOut);
        addEdge([a[0], a[1], z1], [b[0], b[1], z1], nOut, [0, 0, 1]);
        if (!onFloor) addEdge([a[0], a[1], z0], [b[0], b[1], z0], nOut, [0, 0, -1]);
        u += sl;
      }
      const tri = earClip(p);
      tri.forEach(([i, j, k]) => {
        pushTri([p[i][0], p[i][1], z1], [p[j][0], p[j][1], z1], [p[k][0], p[k][1], z1], matTop, [p[i], p[j], p[k]], meta);
        if (!onFloor) pushTri([p[i][0], p[i][1], z0], [p[k][0], p[k][1], z0], [p[j][0], p[j][1], z0], matSide, [p[i], p[k], p[j]], meta);
      });
    }

    // volume of the air: inner floor area * mean ceiling height - obstacles (approx, used for Sabine/Eyring + receiver radius)
    const fArea = Math.abs(polyArea(inner));
    let hSum = 0, hN = 0;
    for (let gx = 0; gx < 24; gx++) for (let gy = 0; gy < 24; gy++) {
      const x = bb.x0 + (gx + 0.5) * (bb.x1 - bb.x0) / 24, y = bb.y0 + (gy + 0.5) * (bb.y1 - bb.y0) / 24;
      if (pointInPoly([x, y], inner)) { hSum += zc(x, y); hN++; }
    }
    let vol = fArea * (hN ? hSum / hN : 3);
    (spec.platforms || []).forEach(pl => { vol -= Math.abs(polyArea(pl.poly)) * (pl.h || 0.5); });
    (spec.columns || []).forEach(c => { vol -= (c.shape === 'square' ? 4 * (c.r || 0.25) ** 2 * 2 : Math.PI * (c.r || 0.25) ** 2) * (hN ? hSum / hN : 3); });
    let zmax = 0; tris.forEach(t => { zmax = Math.max(zmax, t.a[2], t.b[2], t.c[2]); });
    return { tris, edges, inner, outer, bb: Object.assign(bb, { z0: 0, z1: zmax }), volume: Math.max(vol, 1), floorArea: fArea, zc, openArea };
  }

  function pointInPoly(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (((a[1] > p[1]) !== (b[1] > p[1])) && (p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])) c = !c;
    }
    return c;
  }
  function earClip(poly) {
    const n = poly.length; if (n < 3) return [];
    const idx = []; for (let i = 0; i < n; i++) idx.push(i);
    if (polyArea(poly) < 0) idx.reverse();
    const out = []; let guard = 0;
    const isConvex = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12;
    const inTri = (p, a, b, c) => {
      const s = (q, r, t) => (r[0] - q[0]) * (t[1] - q[1]) - (r[1] - q[1]) * (t[0] - q[0]);
      return s(a, b, p) >= -1e-12 && s(b, c, p) >= -1e-12 && s(c, a, p) >= -1e-12;
    };
    while (idx.length > 3 && guard++ < 10000) {
      let cut = false;
      for (let i = 0; i < idx.length; i++) {
        const i0 = idx[(i - 1 + idx.length) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
        const a = poly[i0], b = poly[i1], c = poly[i2];
        if (!isConvex(a, b, c)) continue;
        let ok = true;
        for (const j of idx) { if (j === i0 || j === i1 || j === i2) continue; const p = poly[j]; if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1])) continue; if (inTri(p, a, b, c)) { ok = false; break; } }
        if (!ok) continue;
        out.push([i0, i1, i2]); idx.splice(i, 1); cut = true; break;
      }
      if (!cut) { // degenerate (collinear chain) -> drop a collinear vertex
        let removed = false;
        for (let i = 0; i < idx.length; i++) {
          const a = poly[idx[(i - 1 + idx.length) % idx.length]], b = poly[idx[i]], c = poly[idx[(i + 1) % idx.length]];
          if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-9) { idx.splice(i, 1); removed = true; break; }
        }
        if (!removed) break;
      }
    }
    if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
    return out;
  }
  /** Sutherland–Hodgman: clip polygon by axis-aligned rectangle (result may contain zero-area bridges for concave input; harmless) */
  function clipPolyRect(poly, x0, y0, x1, y1) {
    let out = poly;
    const edges = [[p => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]],
                   [p => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]],
                   [p => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]],
                   [p => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]]];
    for (const [inside, isect] of edges) {
      const inp = out; out = []; if (!inp.length) break;
      for (let i = 0; i < inp.length; i++) {
        const cur = inp[i], prev = inp[(i - 1 + inp.length) % inp.length];
        if (inside(cur)) { if (!inside(prev)) out.push(isect(prev, cur)); out.push(cur); }
        else if (inside(prev)) out.push(isect(prev, cur));
      }
    }
    // drop consecutive duplicates
    return out.filter((p, i) => { const q = out[(i + 1) % out.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9; });
  }
  function subdivTri(A, B, C, maxLen) {
    const l = Math.max(Math.hypot(B[0] - A[0], B[1] - A[1]), Math.hypot(C[0] - B[0], C[1] - B[1]), Math.hypot(A[0] - C[0], A[1] - C[1]));
    if (l <= maxLen) return [[A, B, C]];
    const m = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const ab = m(A, B), bc = m(B, C), ca = m(C, A);
    return [].concat(subdivTri(A, ab, ca, maxLen), subdivTri(ab, B, bc, maxLen), subdivTri(ca, bc, C, maxLen), subdivTri(ab, bc, ca, maxLen));
  }

  // ---------- BVH over triangles (flat arrays) ----------
  function buildBVH(tris) {
    const n = tris.length;
    const cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n);
    const T = new Float64Array(n * 12); // ax ay az e1x e1y e1z e2x e2y e2z nx ny nz
    for (let i = 0; i < n; i++) {
      const t = tris[i];
      cx[i] = (t.a[0] + t.b[0] + t.c[0]) / 3; cy[i] = (t.a[1] + t.b[1] + t.c[1]) / 3; cz[i] = (t.a[2] + t.b[2] + t.c[2]) / 3;
      const o = i * 12; T[o] = t.a[0]; T[o + 1] = t.a[1]; T[o + 2] = t.a[2];
      T[o + 3] = t.b[0] - t.a[0]; T[o + 4] = t.b[1] - t.a[1]; T[o + 5] = t.b[2] - t.a[2];
      T[o + 6] = t.c[0] - t.a[0]; T[o + 7] = t.c[1] - t.a[1]; T[o + 8] = t.c[2] - t.a[2];
      T[o + 9] = t.n[0]; T[o + 10] = t.n[1]; T[o + 11] = t.n[2];
    }
    const order = new Int32Array(n); for (let i = 0; i < n; i++) order[i] = i;
    const nodes = []; // {mn:[3], mx:[3], left, right, start, count}
    function bounds(s, e) {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let k = s; k < e; k++) { const t = tris[order[k]]; for (const p of [t.a, t.b, t.c]) for (let a = 0; a < 3; a++) { if (p[a] < mn[a]) mn[a] = p[a]; if (p[a] > mx[a]) mx[a] = p[a]; } }
      return [mn, mx];
    }
    function build(s, e) {
      const [mn, mx] = bounds(s, e); const id = nodes.length; nodes.push({ mn, mx, left: -1, right: -1, start: s, count: e - s });
      if (e - s <= 4) return id;
      const ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]; const ax = ext[0] > ext[1] ? (ext[0] > ext[2] ? 0 : 2) : (ext[1] > ext[2] ? 1 : 2);
      const C = ax === 0 ? cx : ax === 1 ? cy : cz;
      const sub = Array.from(order.subarray(s, e)).sort((a, b) => C[a] - C[b]);
      for (let k = 0; k < sub.length; k++) order[s + k] = sub[k];
      const m = (s + e) >> 1;
      nodes[id].left = build(s, m); nodes[id].right = build(m, e); nodes[id].count = 0;
      return id;
    }
    if (n) build(0, n);
    const NN = nodes.length, B = new Float64Array(NN * 6), I = new Int32Array(NN * 4);
    nodes.forEach((nd, i) => { B.set([nd.mn[0], nd.mn[1], nd.mn[2], nd.mx[0], nd.mx[1], nd.mx[2]], i * 6); I.set([nd.left, nd.right, nd.start, nd.count], i * 4); });
    return { B, I, T, order, n, stack: new Int32Array(128) };
  }
  /** closest hit along ray o + t d (t in (tmin,tmax)); backface hits ignored unless allowBack.
   *  returns triangle index or -1; writes t into out[0], u,v into out[1..2] */
  function raycast(bvh, ox, oy, oz, dx, dy, dz, tmin, tmax, out, allowBack, skip) {
    if (!bvh.n) return -1;
    const B = bvh.B, I = bvh.I, T = bvh.T, ord = bvh.order, st = bvh.stack;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let sp = 0, best = -1, bt = tmax; st[sp++] = 0;
    while (sp) {
      const ni = st[--sp], b = ni * 6;
      let t1 = (B[b] - ox) * ix, t2 = (B[b + 3] - ox) * ix; let tn = Math.min(t1, t2), tf = Math.max(t1, t2);
      t1 = (B[b + 1] - oy) * iy; t2 = (B[b + 4] - oy) * iy; tn = Math.max(tn, Math.min(t1, t2)); tf = Math.min(tf, Math.max(t1, t2));
      t1 = (B[b + 2] - oz) * iz; t2 = (B[b + 5] - oz) * iz; tn = Math.max(tn, Math.min(t1, t2)); tf = Math.min(tf, Math.max(t1, t2));
      if (!(tf >= Math.max(tn, tmin) && tn <= bt)) continue;
      const q = ni * 4, cnt = I[q + 3];
      if (cnt > 0) {
        for (let k = I[q + 2], e = I[q + 2] + cnt; k < e; k++) {
          const ti = ord[k]; if (ti === skip) continue; const o = ti * 12;
          const ndot = dx * T[o + 9] + dy * T[o + 10] + dz * T[o + 11];
          if (!allowBack && ndot >= 0) continue;
          // Möller–Trumbore
          const e1x = T[o + 3], e1y = T[o + 4], e1z = T[o + 5], e2x = T[o + 6], e2y = T[o + 7], e2z = T[o + 8];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) continue;
          const id = 1 / det; const sx = ox - T[o], sy = oy - T[o + 1], sz = oz - T[o + 2];
          const u = (sx * px + sy * py + sz * pz) * id; if (u < -1e-9 || u > 1 + 1e-9) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * id; if (v < -1e-9 || u + v > 1 + 1e-9) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * id;
          if (t > tmin && t < bt) { bt = t; best = ti; if (out) { out[1] = u; out[2] = v; } }
        }
      } else { st[sp++] = I[q]; st[sp++] = I[q + 1]; }
    }
    if (out) out[0] = bt;
    return best;
  }
  /** all front+back hits along an infinite line segment (for voxelisation) -> array of [t, triIndex] */
  function raycastAll(bvh, ox, oy, oz, dx, dy, dz, tmax, res) {
    res.length = 0; if (!bvh.n) return res;
    const B = bvh.B, I = bvh.I, T = bvh.T, ord = bvh.order, st = bvh.stack;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz; let sp = 0; st[sp++] = 0;
    while (sp) {
      const ni = st[--sp], b = ni * 6;
      let t1 = (B[b] - ox) * ix, t2 = (B[b + 3] - ox) * ix; let tn = Math.min(t1, t2), tf = Math.max(t1, t2);
      t1 = (B[b + 1] - oy) * iy; t2 = (B[b + 4] - oy) * iy; tn = Math.max(tn, Math.min(t1, t2)); tf = Math.min(tf, Math.max(t1, t2));
      t1 = (B[b + 2] - oz) * iz; t2 = (B[b + 5] - oz) * iz; tn = Math.max(tn, Math.min(t1, t2)); tf = Math.min(tf, Math.max(t1, t2));
      if (!(tf >= Math.max(tn, 0) && tn <= tmax)) continue;
      const q = ni * 4, cnt = I[q + 3];
      if (cnt > 0) {
        for (let k = I[q + 2], e = I[q + 2] + cnt; k < e; k++) {
          const ti = ord[k], o = ti * 12;
          const e1x = T[o + 3], e1y = T[o + 4], e1z = T[o + 5], e2x = T[o + 6], e2y = T[o + 7], e2z = T[o + 8];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) continue;
          const id = 1 / det; const sx = ox - T[o], sy = oy - T[o + 1], sz = oz - T[o + 2];
          const u = (sx * px + sy * py + sz * pz) * id; if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * id; if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * id;
          if (t >= 0 && t <= tmax) res.push([t, ti]);
        }
      } else { st[sp++] = I[q]; st[sp++] = I[q + 1]; }
    }
    return res;
  }
  function visible(bvh, p, q, skipA, skipB) {
    const d = sub(q, p); const L = len(d); if (L < 1e-9) return true;
    const out = [0, 0, 0];
    // test both faces: any surface between blocks
    let o = p; const dn = mul(d, 1 / L);
    const hit = raycastSkip2(bvh, o, dn, 1e-6, L - 1e-6, skipA, skipB);
    return hit < 0;
  }
  function raycastSkip2(bvh, o, d, tmin, tmax, sa, sb) {
    const out = [0, 0, 0]; let t0 = tmin;
    for (let g = 0; g < 8; g++) {
      const h = raycast(bvh, o[0], o[1], o[2], d[0], d[1], d[2], t0, tmax, out, true, -1);
      if (h < 0) return -1;
      if (h !== sa && h !== sb) return h;
      t0 = out[0] + 1e-7;
    }
    return -1;
  }

  // ---------- material lookup per triangle ----------
  function matArrays(mesh, mats) {
    mats = mats || MATERIALS;
    const n = mesh.tris.length;
    const A = new Float64Array(n * NB), S = new Float64Array(n * NB), TAU = new Float64Array(n * NB);
    mesh.tris.forEach((t, i) => {
      const m = mats[t.mat] || mats.plaster || MATERIALS.exterior;
      for (let b = 0; b < NB; b++) {
        A[i * NB + b] = Math.min(1, Math.max(0, m.a[b]));
        S[i * NB + b] = Math.min(1, Math.max(0, m.s ? m.s[b] : 0.05));
        TAU[i * NB + b] = Math.pow(10, -(m.tl ? m.tl[b] : 80) / 10);
      }
    });
    return { A, S, TAU };
  }

  // ---------- classic formulas ----------
  function sabineEyring(mesh, mats, env) {
    const M = matArrays(mesh, mats); const m = airM(env.T, env.RH);
    let S = 0; const Sa = Array(NB).fill(0);
    // skip exterior faces and the outdoor face of door/window leaves in the outer wall; open holes count as α = 1 (v3 fix)
    mesh.tris.forEach((t, i) => { if (t.mat === 'exterior' || (t.meta && t.meta.outside)) return; S += t.area; for (let b = 0; b < NB; b++) Sa[b] += t.area * M.A[i * NB + b]; });
    const oa = mesh.openArea || 0; S += oa; for (let b = 0; b < NB; b++) Sa[b] += oa;
    const V = mesh.volume, c = soundSpeed(env.T, env.RH);
    const k = 24 * Math.log(10) / c;
    return {
      S, V,
      sabine: Sa.map((a, b) => k * V / (a + 4 * m[b] * V)),
      eyring: Sa.map((a, b) => k * V / (-S * Math.log(1 - Math.min(a / S, 0.9999)) + 4 * m[b] * V)),
      meanAlpha: Sa.map(a => a / S)
    };
  }

  // ---------- image sources (specular early reflections) ----------
  function planeGroups(mesh) {
    // group coplanar triangles that face the room (exclude exterior)
    const groups = []; const key = new Map();
    mesh.tris.forEach((t, i) => {
      if (t.mat === 'exterior') return;
      const d = dot(t.n, t.a);
      const k = [Math.round(t.n[0] * 1000), Math.round(t.n[1] * 1000), Math.round(t.n[2] * 1000), Math.round(d * 200)].join(',');
      let g = key.get(k); if (g === undefined) { g = groups.length; key.set(k, g); groups.push({ n: t.n, d, tris: [], mat: t.mat }); }
      groups[g].tris.push(i);
    });
    return groups;
  }
  function imageSources(mesh, bvh, M, src, rcv, maxOrder, env) {
    const groups = planeGroups(mesh);
    if (groups.length > 400) maxOrder = Math.min(maxOrder, 1); else if (groups.length > 80) maxOrder = Math.min(maxOrder, 2);
    const triGroup = new Int32Array(mesh.tris.length).fill(-1);
    groups.forEach((g, gi) => g.tris.forEach(t => { triGroup[t] = gi; }));
    const out = []; // {delay, dist, gains[NB] (pressure), dir (arrival dir at receiver), order, path}
    const c = soundSpeed(env.T, env.RH), m = airM(env.T, env.RH);
    const tmp = [0, 0, 0];
    // direct
    if (visible(bvh, src, rcv, -1, -1)) { const d = len(sub(rcv, src)); out.push({ dist: d, order: 0, gains: m.map(mb => Math.exp(-mb * d / 2) / d), dir: norm(sub(src, rcv)), path: [src, rcv] }); }
    // recursive images
    function reflect(p, g) { const dd = dot(g.n, p) - g.d; return sub(p, mul(g.n, 2 * dd)); }
    function recurse(img, seq, order) {
      if (order > maxOrder) return;
      for (let gi = 0; gi < groups.length; gi++) {
        if (seq.length && seq[seq.length - 1] === gi) continue;
        const g = groups[gi];
        // source (image) must be in front of plane
        if (dot(g.n, img) - g.d <= 1e-6) continue;
        const ni = reflect(img, g); const s2 = seq.concat(gi);
        validate(ni, s2);
        recurse(ni, s2, order + 1);
      }
    }
    const imgsCache = [];
    function validate(img, seq) {
      // back-trace from receiver toward image through planes seq (reverse order)
      const images = [src]; for (let k = 0; k < seq.length; k++) images.push(reflect(images[k], groups[seq[k]]));
      let p = rcv; const pts = [rcv]; const gains = Array(NB).fill(1); let prevTri = -1;
      for (let k = seq.length - 1; k >= 0; k--) {
        const target = images[k + 1]; const d = norm(sub(target, p));
        const h = raycast(bvh, p[0], p[1], p[2], d[0], d[1], d[2], 1e-6, 1e9, tmp, false, prevTri);
        if (h < 0 || triGroup[h] !== seq[k]) return;
        const q = add(p, mul(d, tmp[0]));
        for (let b = 0; b < NB; b++) gains[b] *= Math.sqrt(Math.max(0, 1 - M.A[h * NB + b]) * (1 - M.S[h * NB + b]) * (1 - M.TAU[h * NB + b]));
        pts.push(q); p = q; prevTri = h;
      }
      // last leg to source
      if (!visibleFrom(p, src, prevTri)) return;
      pts.push(src);
      const dist = len(sub(img, rcv));
      out.push({ dist, order: seq.length, gains: gains.map((g, b) => g * Math.exp(-m[b] * dist / 2) / dist), dir: norm(sub(pts[1], rcv)), path: pts.reverse() });
    }
    function visibleFrom(p, q, skipTri) {
      const d = sub(q, p), L = len(d), dn = mul(d, 1 / L);
      const h = raycastSkip2(bvh, p, dn, 1e-6, L - 1e-6, skipTri, -1);
      return h < 0;
    }
    if (maxOrder >= 1) recurse(src, [], 1);
    out.forEach(r => { r.delay = r.dist / c; });
    return { list: out, order: maxOrder, groups: groups.length };
  }

  // ---------- UTD edge diffraction (Kouyoumjian–Pathak), magnitude per band ----------
  function fresnelTail(X) {
    // F(X) = 2j sqrt(X) e^{jX} ∫_{sqrt X}^{∞} e^{-j t^2} dt   (complex) -> [re, im]
    if (X > 10) { // asymptotic: 1 + j/(2X) - 3/(4X^2) - j 15/(8X^3)
      return [1 - 3 / (4 * X * X), 1 / (2 * X) - 15 / (8 * X * X * X)];
    }
    const a = Math.sqrt(X);
    // ∫_a^∞ e^{-jt²} dt = sqrt(pi/8)(1-j) - ∫_0^a e^{-jt²}dt
    let cr = 0, ci = 0; const n = 400; const h = a / n;
    for (let k = 0; k <= n; k++) { const t = k * h, w = (k === 0 || k === n) ? 1 : (k % 2 ? 4 : 2); cr += w * Math.cos(t * t); ci -= w * Math.sin(t * t); }
    cr *= h / 3; ci *= h / 3;
    const ir = Math.sqrt(Math.PI / 8) - cr, ii = -Math.sqrt(Math.PI / 8) - ci;
    // 2j sqrt(X) e^{jX} * (ir + j ii)
    const er = Math.cos(X), ei = Math.sin(X);
    const pr = ir * er - ii * ei, pi = ir * ei + ii * er;
    return [-2 * a * pi, 2 * a * pr];
  }
  /** UTD diffraction coefficient magnitude-weighted field for wedge with exterior angle n*pi.
   *  phiS, phiR measured from face 0 (radians, inside the exterior region 0..n*pi). rho: src-edge, r: edge-rcv distances, beta: angle to edge. */
  function utdField(k, n, phiS, phiR, rho, r, sinB) {
    const Lp = rho * r / (rho + r) * sinB * sinB;
    let re = 0, im = 0;
    const terms = [[+1, phiR - phiS], [-1, phiR - phiS], [+1, phiR + phiS], [-1, phiR + phiS]];
    for (let q = 0; q < 4; q++) {
      const sgn = terms[q][0], beta = terms[q][1];
      const cotArg = (Math.PI + sgn * beta) / (2 * n);
      const Nint = Math.round((beta + sgn * Math.PI) / (2 * Math.PI * n));
      const aval = 2 * Math.pow(Math.cos((2 * n * Math.PI * Nint - beta) / 2), 2);
      if (Math.abs(Math.sin(cotArg)) < 1e-3) {
        // at a shadow/reflection boundary cot -> ∞ while F -> 0; use the analytic limit (Kouyoumjian & Pathak 1974):
        // cot(..)·F(kLa) ≈ n·e^{jπ/4}·[ sqrt(2πkL)·sgn(ε) − 2kLε·e^{jπ/4} ],  ε = π ± β − 2πnN  (v3 fix: was a 1/ε blow-up)
        const eps = sgn > 0 ? Math.PI + beta - 2 * Math.PI * n * Nint : Math.PI - beta + 2 * Math.PI * n * Nint;
        const c4 = Math.SQRT1_2, a1 = n * Math.sqrt(2 * Math.PI * k * Lp) * (eps > 1e-12 ? 1 : eps < -1e-12 ? -1 : 0), a2 = n * 2 * k * Lp * eps;
        re += a1 * c4; im += a1 * c4 - a2; // n e^{jπ/4}·(−2kLε e^{jπ/4}) = −n·2kLε·j
        continue;
      }
      const F = fresnelTail(k * Lp * aval);
      const cot = Math.cos(cotArg) / Math.sin(cotArg);
      re += F[0] * cot; im += F[1] * cot;
    }
    // prefactor -e^{-jπ/4} / (2n sqrt(2πk) sinB)
    const pf = 1 / (2 * n * Math.sqrt(2 * Math.PI * k) * sinB);
    const c = Math.cos(-Math.PI / 4), s = Math.sin(-Math.PI / 4);
    const Dr = -pf * (re * c - im * s), Di = -pf * (re * s + im * c);
    const amp = Math.sqrt(rho / (r * (rho + r))) / rho; // spherical spreading for point source
    return Math.hypot(Dr, Di) * amp;
  }
  function edgeDiffraction(mesh, bvh, M, src, rcv, env, opts) {
    const c = soundSpeed(env.T, env.RH), m = airM(env.T, env.RH); const out = [];
    const direct = visible(bvh, src, rcv, -1, -1);
    if (direct && !(opts && opts.always)) return out; // add diffraction where the direct sound is shadowed
    for (const e of mesh.edges) {
      const ed = sub(e.p1, e.p0), el = len(ed), eu = mul(ed, 1 / el);
      // apex point minimises |S-P|+|P-R|; ternary search on [0, el]
      let lo = 0, hi = el;
      const f = t => { const P = add(e.p0, mul(eu, t)); return len(sub(P, src)) + len(sub(P, rcv)); };
      for (let it = 0; it < 40; it++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (f(m1) < f(m2)) hi = m2; else lo = m1; }
      const t = (lo + hi) / 2; if (t < 1e-3 || t > el - 1e-3) continue; // apex must be interior
      const P = add(e.p0, mul(eu, t));
      const wedgeExt = e.ext; if (wedgeExt < Math.PI * 1.01) continue; // concave corner: no diffraction
      const n = wedgeExt / Math.PI;
      const ang = (v) => { // angle of v (projected ⟂ edge) from face A, rotating through the air on the nA side
        const vp = sub(v, mul(eu, dot(v, eu))); const x = dot(vp, e.f0), y = dot(vp, e.nA);
        let a = Math.atan2(y, x); if (a < 0) a += 2 * Math.PI; return a;
      };
      const vs = sub(src, P), vr = sub(rcv, P);
      const phiS = ang(vs), phiR = ang(vr);
      if (phiS > wedgeExt || phiR > wedgeExt) continue; // a point inside the solid
      // visibility to a point just outside the solid next to the apex (clear of wall thickness)
      const outPt = (v) => add(add(P, mul(e.f0, -0.2)), mul(norm(sub(v, mul(eu, dot(v, eu)))), 0.02));
      if (!visible(bvh, src, outPt(vs), -1, -1)) continue;
      if (!visible(bvh, rcv, outPt(vr), -1, -1)) continue;
      const rho = len(vs), r = len(vr); const sinB = Math.max(0.05, Math.sqrt(1 - Math.pow(dot(norm(vs), eu), 2)));
      const gains = BANDS.map((fc, b) => {
        // average over 3 frequencies across the band to smooth comb nulls
        let s = 0; for (const fk of [fc / 1.26, fc, fc * 1.26]) s += utdField(2 * Math.PI * fk / c, n, phiS, phiR, rho, r, sinB) ** 2;
        return Math.sqrt(s / 3) * Math.exp(-m[b] * (rho + r) / 2);
      });
      out.push({ dist: rho + r, delay: (rho + r) / c, gains, dir: norm(vr), order: 0, diffracted: true, path: [src, P, rcv] });
    }
    return out;
  }

  // ---------- refraction helpers ----------
  /** dc/dT (m/s per K) of c = 331.3 sqrt(1 + T/273.15) */
  function dcdT(tC) { return 331.3 / (2 * Math.sqrt(273.15 * (273.15 + tC))); }
  /** ray equation in c(z): dd/ds = -(∇c/c) + (d·∇c/c) d, with ∇c/c = g ẑ; one explicit step of length ds, renormalised */
  function bend(dx, dy, dz, g, ds) {
    dx += ds * (dz * g * dx); dy += ds * (dz * g * dy); dz += ds * (-g + dz * g * dz);
    const l = Math.hypot(dx, dy, dz); return [dx / l, dy / l, dz / l];
  }
  /** free-field curved ray (for tests / visualising): returns end point after path length L */
  function refractPath(o, d, env, L, step) {
    step = step || 0.25; const c0 = soundSpeed(env.T, env.RH), dcdz = (env.grad || 0) * dcdT(env.T);
    let p = o.slice(), dir = norm(d); const z0 = o[2];
    for (let s = 0; s < L; s += step) {
      const ds = Math.min(step, L - s);
      // midpoint integration
      const pm = add(p, mul(dir, ds / 2)); const c = c0 + dcdz * (pm[2] - z0);
      const dm = bend(dir[0], dir[1], dir[2], dcdz / c, ds / 2);
      p = add(p, mul(dm, ds)); dir = bend(dir[0], dir[1], dir[2], dcdz / c, ds);
    }
    return { p, dir };
  }

  // ---------- stochastic ray tracing -> energy histograms per band ----------
  function rayTrace(mesh, bvh, M, src, rcv, env, opts) {
    opts = opts || {};
    const nRays = opts.rays || 20000, tMax = opts.tMax || 3.0, binDt = opts.binDt || 0.001, isOrder = opts.isOrder == null ? 2 : opts.isOrder;
    const R = rng(opts.seed || 1234);
    const c0 = soundSpeed(env.T, env.RH), m = airM(env.T, env.RH);
    const grad = env.grad || 0; // dT/dz in K/m -> dc/dz ≈ 0.6 m/s per K
    const dcdz = grad * dcdT(env.T); // m/s per m
    const nBins = Math.ceil(tMax / binDt);
    const H = new Float64Array(NB * nBins);
    const dirH = opts.dirs ? new Float64Array(nBins * 3) : null; // energy-weighted arrival directions (for stereo)
    const V = mesh.volume;
    const rr = opts.rr || Math.min(1.0, Math.max(0.25, Math.pow(15 * V / (2 * Math.PI * nRays), 1 / 3) * 0.6)); // receiver radius
    const Vs = 4 / 3 * Math.PI * rr * rr * rr;
    const tmp = [0, 0, 0]; let lost = 0, totalHits = 0;
    const E = new Float64Array(NB);
    const ga = (2 / (1 + Math.sqrt(5))) * 2 * Math.PI;
    for (let ray = 0; ray < nRays; ray++) {
      if (opts.onProgress && ray % 500 === 0) opts.onProgress(ray / nRays);
      // stratified Fibonacci sphere + jitter
      const zz = 1 - 2 * (ray + R()) / nRays, rad = Math.sqrt(Math.max(0, 1 - zz * zz)), ph = ray * ga + R() * 0.3;
      let dx = rad * Math.cos(ph), dy = rad * Math.sin(ph), dz = zz;
      let ox = src[0], oy = src[1], oz = src[2];
      for (let b = 0; b < NB; b++) E[b] = 1 / nRays;
      let dist = 0, order = 0, spec = true, lastTri = -1, time = 0;
      let alive = true;
      while (alive) {
        // segment: straight (or short steps if refraction)
        const stepMax = grad !== 0 ? 0.5 : 1e9;
        const hit = raycast(bvh, ox, oy, oz, dx, dy, dz, 1e-7, stepMax, tmp, true, lastTri);
        let segLen = hit >= 0 ? tmp[0] : (grad !== 0 ? stepMax : -1);
        if (segLen < 0) { lost++; break; }
        // receiver sphere intersection along this segment
        const wx = rcv[0] - ox, wy = rcv[1] - oy, wz = rcv[2] - oz;
        const proj = wx * dx + wy * dy + wz * dz;
        const d2 = wx * wx + wy * wy + wz * wz - proj * proj;
        if (d2 < rr * rr && order > 0 && (!spec || order > isOrder)) {
          const half = Math.sqrt(rr * rr - d2), ta = Math.max(0, proj - half), tb = Math.min(segLen, proj + half);
          if (tb > ta) {
            const cz = oz + dz * proj; const cHere = c0 + dcdz * (cz - (src[2]));
            const tArr = time + proj / cHere;
            const bin = Math.floor(tArr / binDt);
            if (bin < nBins) {
              const chord = tb - ta;
              const dTot = dist + proj;
              for (let b = 0; b < NB; b++) H[b * nBins + bin] += E[b] * Math.exp(-m[b] * dTot) * chord / Vs;
              if (dirH) { const w = E[3] * chord / Vs; dirH[bin * 3] -= dx * w; dirH[bin * 3 + 1] -= dy * w; dirH[bin * 3 + 2] -= dz * w; }
            }
          }
        }
        const cSeg = c0 + dcdz * (oz + dz * segLen / 2 - src[2]);
        dist += segLen; time += segLen / cSeg;
        ox += dx * segLen; oy += dy * segLen; oz += dz * segLen;
        if (time > tMax) break;
        if (hit < 0) { // refraction step without hit: bend direction  d' = d + ds*( -∇c/c + (d·∇c/c) d )
          const nd = bend(dx, dy, dz, dcdz / cSeg, segLen); dx = nd[0]; dy = nd[1]; dz = nd[2]; lastTri = -1; continue;
        }
        totalHits++;
        const o = hit * 12; let nx = bvh.T[o + 9], ny = bvh.T[o + 10], nz = bvh.T[o + 11];
        const back = dx * nx + dy * ny + dz * nz > 0;
        if (back) { lastTri = hit; continue; } // inside a wall / leaving through the back of a face: pass through
        const base = hit * NB;
        // transmission
        let tauBar = 0; for (let b = 0; b < NB; b++) tauBar += M.TAU[base + b]; tauBar /= NB;
        if (tauBar > 1e-9 && R() < tauBar) { for (let b = 0; b < NB; b++) E[b] *= M.TAU[base + b] / tauBar; lastTri = hit; spec = false; order++; continue; }
        else if (tauBar > 1e-9) { for (let b = 0; b < NB; b++) E[b] *= (1 - M.TAU[base + b]) / (1 - tauBar); }
        let emax = 0;
        for (let b = 0; b < NB; b++) { E[b] *= (1 - M.A[base + b]); if (E[b] > emax) emax = E[b]; }
        if (emax * nRays < 1e-9) break; // -90 dB
        // scattering: choose diffuse with probability sBar, re-weight per band
        let sBar = 0; for (let b = 0; b < NB; b++) sBar += M.S[base + b]; sBar /= NB;
        order++;
        if (R() < sBar) {
          for (let b = 0; b < NB; b++) E[b] *= M.S[base + b] / sBar;
          // Lambert (cosine) direction about normal
          const u1 = R(), u2 = R(); const rC = Math.sqrt(u1), th = 2 * Math.PI * u2;
          const lx = rC * Math.cos(th), ly = rC * Math.sin(th), lz = Math.sqrt(Math.max(0, 1 - u1));
          // basis
          let tx, ty, tz; if (Math.abs(nx) < 0.9) { tx = 0; ty = -nz; tz = ny; } else { tx = nz; ty = 0; tz = -nx; }
          const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
          const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
          dx = tx * lx + bx * ly + nx * lz; dy = ty * lx + by * ly + ny * lz; dz = tz * lx + bz * ly + nz * lz;
          spec = false;
        } else {
          if (sBar > 0) for (let b = 0; b < NB; b++) E[b] *= (1 - M.S[base + b]) / (1 - sBar);
          const k = 2 * (dx * nx + dy * ny + dz * nz); dx -= k * nx; dy -= k * ny; dz -= k * nz;
        }
        lastTri = hit;
        if (order > 2000) break;
      }
    }
    return { H, nBins, binDt, rr, lost: lost / nRays, hits: totalHits, dirH };
  }

  // ---------- random-incidence (Paris) absorption of a locally reacting surface with real admittance β ----------
  function alphaRandom(beta) {
    let s = 0; const n = 400;
    for (let i = 0; i < n; i++) { const th = (i + 0.5) / n * Math.PI / 2, c = Math.cos(th); const r = (c - beta) / (c + beta); s += (1 - r * r) * Math.sin(2 * th); }
    return s * (Math.PI / 2) / n;
  }
  const PARIS = (() => { const t = []; for (let i = 0; i <= 2000; i++) { const b = i / 2000; t.push([b, alphaRandom(b)]); } return t; })();
  /** table α is random-incidence (Sabine); invert the Paris integral (α_rand ≈ 8β for small β, max ≈ 0.951) */
  function betaFromRandomAlpha(al) {
    if (al <= 0) return 0;
    let best = PARIS[0];
    for (let i = 1; i < PARIS.length; i++) { if (PARIS[i][1] >= al) { const a = PARIS[i - 1], b = PARIS[i]; return a[0] + (b[0] - a[0]) * (al - a[1]) / (b[1] - a[1] || 1); } if (PARIS[i][1] > best[1]) best = PARIS[i]; }
    return best[0]; // unreachable α -> maximum achievable
  }

  // ---------- material physics: absorption computed from the construction (v3) ----------
  // Layers front -> back on a rigid wall, transfer-matrix method (Allard & Atalla, "Propagation of Sound in Porous Media", ch. 11),
  // time convention e^{+jωt}. Layer types:
  //   porous {d [m], sigma [Pa·s/m²]}  Miki (1990) empirical model (valid ~0.01 < f/σ < 1)
  //   sheet  {R [Pa·s/m], m}           limp porous sheet (curtain): R ∥ jωm
  //   air    {d}                       air gap (extended reaction: kz = k0 cosθ)
  //   panel  {m [kg/m²], eta}          limp mass (gypsum, plywood, glass) with loss factor η
  //   perf   {t, dh [m], phi}          perforated / micro-perforated plate, Maa (1998) transfer impedance (incl. 0.85·dh end correction)
  const RHO0 = 1.204, ETA_AIR = 1.81e-5;
  const CX = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1]], sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
    mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
    div: (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; },
    sqrt: a => { const r = Math.hypot(a[0], a[1]), re = Math.sqrt((r + a[0]) / 2), im = Math.sqrt(Math.max(0, (r - a[0]) / 2)) * (a[1] < 0 ? -1 : 1); return [re, im]; },
    cos: a => [Math.cos(a[0]) * Math.cosh(a[1]), -Math.sin(a[0]) * Math.sinh(a[1])],
    sin: a => [Math.sin(a[0]) * Math.cosh(a[1]), Math.cos(a[0]) * Math.sinh(a[1])],
    j: a => [-a[1], a[0]],
    abs2: a => a[0] * a[0] + a[1] * a[1],
  };
  function miki(f, sigma, c0) {
    const X = f / sigma, w = 2 * Math.PI * f, z0 = RHO0 * c0;
    const Zc = [z0 * (1 + 0.0699 * Math.pow(X, -0.632)), -z0 * 0.1071 * Math.pow(X, -0.632)];
    const kc = [(w / c0) * (1 + 0.1093 * Math.pow(X, -0.618)), -(w / c0) * 0.1597 * Math.pow(X, -0.618)];
    return { Zc, kc };
  }
  /** surface impedance [Pa·s/m] of a layered construction on a rigid backing at frequency f and incidence angle th (null = rigid) */
  function surfaceZ(layers, f, th, c0) {
    c0 = c0 || 343.2; const w = 2 * Math.PI * f, k0 = w / c0, kx = k0 * Math.sin(th), z0 = RHO0 * c0;
    // backing: rigid wall (null) or free air behind (doors, windows: the wave leaves into the next room / outside)
    let Z = layers.free ? [z0 / Math.max(0.05, Math.cos(th)), 0] : null;
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (L.type === 'panel' || L.type === 'perf' || L.type === 'sheet') {
        let Zt;
        if (L.type === 'panel') { const m = L.m, eta = L.eta == null ? 0.15 : L.eta; Zt = [eta * w * m, w * m]; }
        else if (L.type === 'sheet') { // limp porous sheet (curtain, fabric): flow resistance R in parallel with its mass reactance jωm
          const jm = [0, w * L.m]; Zt = CX.div(CX.mul([L.R, 0], jm), CX.add([L.R, 0], jm)); }
        else { // Maa: x = dh·sqrt(ωρ/(4η))
          const dh = L.dh, t = L.t, phi = L.phi, x = dh * Math.sqrt(w * RHO0 / (4 * ETA_AIR));
          const r = 32 * ETA_AIR * t / (phi * z0 * dh * dh) * (Math.sqrt(1 + x * x / 32) + Math.SQRT2 / 32 * x * dh / t);
          const wm = w * t / (phi * c0) * (1 + 1 / Math.sqrt(9 + x * x / 2) + 0.85 * dh / t);
          Zt = [z0 * r + (L.fleece || 0), z0 * wm]; // acoustic fleece / tissue behind the holes = series flow resistance [Pa·s/m]
        }
        if (Z === null) return null; // a plate glued to a rigid wall cannot move
        Z = CX.add(Z, Zt); continue;
      }
      let Zc, kc;
      if (L.type === 'porous') ({ Zc, kc } = miki(f, L.sigma, c0)); else { Zc = [z0, 0]; kc = [k0, 0]; }
      let kz = CX.sqrt(CX.sub(CX.mul(kc, kc), [kx * kx, 0])); if (kz[1] > 0) kz = [-kz[0], -kz[1]];
      const kd = [kz[0] * L.d, kz[1] * L.d], cs = CX.cos(kd), sn = CX.sin(kd);
      const Zl = CX.div(CX.mul(Zc, kc), kz); // impedance of the layer for the normal component
      if (Z === null) Z = CX.div(cs, CX.j(CX.div(sn, Zl))); // rigid backing: Z = -j Zl cot(kz d)
      else Z = CX.mul(Zl, CX.div(CX.add(CX.mul(Z, cs), CX.j(CX.mul(Zl, sn))), CX.add(CX.mul(Zl, cs), CX.j(CX.mul(Z, sn)))));
    }
    return Z;
  }
  function alphaAt(layers, f, th, c0) {
    c0 = c0 || 343.2; const Z = surfaceZ(layers, f, th, c0); const surf = layers.surf || 0;
    if (Z === null) return surf;
    const z0 = RHO0 * c0, zc = [Z[0] * Math.cos(th), Z[1] * Math.cos(th)];
    const R = CX.div(CX.sub(zc, [z0, 0]), CX.add(zc, [z0, 0])); const a = Math.max(0, Math.min(1, 1 - CX.abs2(R)));
    return 1 - (1 - a) * (1 - surf); // surf: losses of the surface finish / joints (paint, gaps), frequency independent
  }
  /** field-incidence absorption (0..78°, the usual model of reverberation-room "Sabine" α) */
  function alphaField(layers, f, c0) {
    const n = 60, tmax = 78 * Math.PI / 180; let s = 0, w = 0;
    for (let i = 0; i < n; i++) { const th = (i + 0.5) / n * tmax, g = Math.sin(2 * th); s += alphaAt(layers, f, th, c0) * g; w += g; }
    return s / w;
  }
  /** octave-band α (mean of the three 1/3-octaves in each band) for BANDS */
  function alphaOctaves(layers, c0) {
    return BANDS.map(f => { let s = 0; for (const k of [-1, 0, 1]) s += alphaField(layers, f * Math.pow(2, k / 3), c0); return Math.round(s / 3 * 1000) / 1000; });
  }
  /** human-friendly build-ups used by the "재질 만들기" editor and the material table.
   *  porous {d, sigma, gap}; panel {m, gap, fill, eta}; perf {t, dh, phi, gap, fill, fleece}  (fill = mineral wool in the cavity, m;
   *  eta = loss factor of the mounted panel incl. frame/edge damping, default 0.15; surf = finish/joint losses, default 0.03) */
  function buildUp(kind, p) {
    const cavity = () => { const fill = Math.min(p.fill || 0, p.gap); const out = []; if (fill > 0) out.push({ type: 'porous', d: fill, sigma: 8000 }); if (p.gap - fill > 1e-4) out.push({ type: 'air', d: p.gap - fill }); return out; };
    let L;
    if (kind === 'porous') L = [{ type: 'porous', d: p.d, sigma: p.sigma }].concat(p.gap > 0 ? [{ type: 'air', d: p.gap }] : []);
    else if (kind === 'panel') L = [{ type: 'panel', m: p.m, eta: p.eta }].concat(cavity());
    else if (kind === 'perf') L = [{ type: 'perf', t: p.t, dh: p.dh, phi: p.phi, fleece: p.fleece || 0 }].concat(cavity());
    else if (kind === 'sheet') L = [{ type: 'sheet', R: p.R, m: p.m }].concat(cavity());
    else if (kind === 'glazing') { // leaf with free air behind: single pane {m} or double {m, m2, gap}
      L = [{ type: 'panel', m: p.m, eta: p.eta == null ? 0.05 : p.eta }];
      if (p.m2) L.push({ type: 'air', d: p.gap }, { type: 'panel', m: p.m2, eta: p.eta == null ? 0.05 : p.eta });
      L.free = true;
    }
    else throw new Error('unknown build-up ' + kind);
    L.surf = p.surf == null ? (kind === 'porous' ? 0 : 0.03) : p.surf;
    return L;
  }
  /** resonance estimates shown in the editor */
  function resonanceHz(kind, p, c0) {
    c0 = c0 || 343.2;
    if (kind === 'panel') return c0 / (2 * Math.PI) * Math.sqrt(RHO0 / (p.m * p.gap)); // ≈ 60/sqrt(m·D)
    if (kind === 'perf') return c0 / (2 * Math.PI) * Math.sqrt(p.phi / (p.gap * (p.t + 0.85 * p.dh))); // Helmholtz
    if (kind === 'porous') return c0 / (4 * (p.d + (p.gap || 0))); // quarter wave
    if (kind === 'glazing' && p.m2) return c0 / (2 * Math.PI) * Math.sqrt(RHO0 * (1 / p.m + 1 / p.m2) / p.gap); // mass-air-mass
    return null;
  }
  /** a user material from a construction ("재질 만들기"): α from the model, scattering from the surface relief, TL of the masonry
   *  wall it is mounted on (the finish itself adds little mass). Returns a plain object for defMat / spec.customMats. */
  function makeMaterial(kind, p, name) {
    const a = alphaOctaves(buildUp(kind, p));
    const relief = kind === 'sheet' ? 0.06 : kind === 'perf' ? 0.005 : 0.0; // curtain folds / hole depth -> BRAS s = 0.5·sqrt(d/λ)
    const s = BANDS.map(f => Math.round(Math.min(0.99, Math.max(0.05, 0.5 * Math.sqrt(relief / (343 / f)))) * 1000) / 1000);
    const tl = (MATERIALS.plaster && MATERIALS.plaster.tl) ? MATERIALS.plaster.tl.slice() : Array(NB).fill(50);
    const look = { porous: ['#5d7480', 'fabric'], panel: ['#b58a5a', 'woodpanel'], perf: ['#e9e5dc', 'perforated'], sheet: ['#6f4a6b', 'curtain'], glazing: ['#a9c6d4', 'glass'] }[kind];
    return { ko: name, en: 'Custom ' + kind, a, s, tl, color: look[0], tex: look[1], src: 'model', ssrc: 'BRAS model d=' + relief + 'm', phys: Object.assign({ kind }, p), custom: true, kind };
  }
  /** table materials keep their MEASURED α (125 Hz–8 kHz). 63 Hz is not tabulated -> extrapolate with the physical model of
   *  the construction: α63 = α125 · α_model(63)/α_model(125)  (replaces the fixed factors 0.6 / 1.15 / 1 of v1-v2). */
  function applyPhysLF(m) {
    if (!m.phys || !m.a) return m;
    const lay = buildUp(m.phys.kind, m.phys);
    const r63 = alphaField(lay, 63), r125 = alphaField(lay, 125);
    // a rising curve never exceeds the model's own absolute 63 Hz value (the ratio would otherwise amplify a too-low model α125)
    if (r125 > 1e-4) { let a63 = m.a[1] * r63 / r125; if (r63 > r125) a63 = Math.min(a63, Math.max(m.a[1], r63));
      m.a = m.a.slice(); m.a[0] = Math.round(Math.max(0.005, Math.min(1, a63)) * 1000) / 1000; m.a63 = 'phys'; }
    return m;
  }

  // ---------- frequency-dependent FDTD boundaries (v3) ----------
  // Each wall material gets a locally reacting normalised impedance  ζ(ω) = r + jωm − jk/ω  (series resistance–mass–spring:
  // a damped resonator, Bilbao 2013 "Modeling of complex geometries and boundary conditions in FD/FV time domain room
  // acoustics simulation", IEEE TASLP 21(7)). Passive for r, m, k ≥ 0 -> the scheme stays stable at the usual Courant number.
  // r, m, k are fitted so that the random-incidence (Paris) absorption of ζ matches the material's octave α at 63–500 Hz.
  function alphaRandomZ(r, m, k, f) {
    const w = 2 * Math.PI * f, x = w * m - (k ? k / w : 0); let s = 0; const n = 24;
    for (let i = 0; i < n; i++) {
      const th = (i + 0.5) / n * Math.PI / 2, c = Math.cos(th);
      const zr = r * c, zi = x * c; // R = (ζc − 1)/(ζc + 1)
      const R2 = ((zr - 1) * (zr - 1) + zi * zi) / ((zr + 1) * (zr + 1) + zi * zi);
      s += (1 - R2) * Math.sin(2 * th);
    }
    return s * (Math.PI / 2) / n;
  }
  const FDB_BANDS = [0, 1, 2, 3], FDB_W = [1.5, 1.5, 1, 0.5];
  const fdbCache = new Map();
  /** fit {r, m, k} to target α at 63/125/250/500 Hz. Coarse log grid then coordinate refinement. */
  function fitBoundary(alpha) {
    const key = FDB_BANDS.map(b => alpha[b].toFixed(4)).join(',');
    if (fdbCache.has(key)) return fdbCache.get(key);
    const tgt = FDB_BANDS.map(b => Math.min(0.95, Math.max(0.002, alpha[b])));
    const err = (r, m, k) => { let e = 0; for (let i = 0; i < 4; i++) { const d = alphaRandomZ(r, m, k, BANDS[FDB_BANDS[i]]) - tgt[i]; e += FDB_W[i] * d * d; } return e; };
    let best = { r: 1 / Math.max(1e-4, betaFromRandomAlpha((tgt[0] + tgt[1] + tgt[2]) / 3)), m: 0, k: 0 }; best.e = err(best.r, 0, 0);
    for (let ir = 0; ir <= 36; ir++) { const r = 0.5 * Math.pow(10, ir / 12); // 0.5 .. 500
      for (let im = 0; im <= 22; im++) { const m = im === 0 ? 0 : 1e-6 * Math.pow(10, (im - 1) / 5); // 0, 1e-6 .. 1e-2 s
        for (let i0 = 0; i0 <= 20; i0++) { const k = i0 === 0 || m === 0 ? 0 : m * Math.pow(2 * Math.PI * 30 * Math.pow(20, (i0 - 1) / 19), 2); // f0 30..600 Hz
          const e = err(r, m, k); if (e < best.e) best = { r, m, k, e };
          if (m === 0) break; } } }
    // refine (multiplicative coordinate search)
    for (let it = 0; it < 60; it++) { let improved = false;
      for (const p of ['r', 'm', 'k']) for (const f of [1.25, 0.8]) { const c = Object.assign({}, best); c[p] = (c[p] || (p === 'r' ? 1 : 0)) * f; if (c[p] === 0) continue; c.e = err(c.r, c.m, c.k); if (c.e < best.e) { best = c; improved = true; } }
      if (!improved) break; }
    best.alpha = FDB_BANDS.map(b => alphaRandomZ(best.r, best.m, best.k, BANDS[b]));
    fdbCache.set(key, best); return best;
  }

  // ---------- 3D FDTD (standard leapfrog, 7-point, locally-reacting boundaries) — CPU reference ----------
  /** voxelise mesh into grid of spacing dx; returns {nx,ny,nz,ox,oy,oz,K (Int8 air-neighbour count, -1 solid), beta (Float32)} */
  function voxelise(mesh, bvh, dx, seedPt, M, pad) {
    pad = pad == null ? 2 : pad;
    const bb = mesh.bb;
    // non-round origin offsets so grid nodes never sit exactly on (usually round-numbered) surfaces -> no seam leaks
    const ox = Math.min(bb.x0, ...mesh.outer.map(p => p[0])) - pad * dx - 0.3183 * dx, oy = Math.min(bb.y0, ...mesh.outer.map(p => p[1])) - pad * dx - 0.2718 * dx, oz = -pad * dx - 0.4142 * dx;
    const X1 = Math.max(bb.x1, ...mesh.outer.map(p => p[0])) + pad * dx, Y1 = Math.max(bb.y1, ...mesh.outer.map(p => p[1])) + pad * dx, Z1 = bb.z1 + pad * dx;
    const nx = Math.ceil((X1 - ox) / dx) + 1, ny = Math.ceil((Y1 - oy) / dx) + 1, nz = Math.ceil((Z1 - oz) / dx) + 1;
    const NC = nx * ny * nz;
    // blocked links: bit 0 = +x, 1 = +y, 2 = +z from cell (i,j,k); store material beta of blocking face
    const block = new Uint8Array(NC); const bAcc = new Float32Array(NC); const bCnt = new Uint8Array(NC);
    const res = [];
    const alphaToBeta = betaFromRandomAlpha;
    const triBeta = new Float32Array(mesh.tris.length);
    // v3: frequency-dependent boundary -> one fitted (r, m, k) per material; 'exterior'/'open' = ρc (r = 1)
    const matIdx = new Map(), bParams = [], triMat = new Int16Array(mesh.tris.length);
    mesh.tris.forEach((t, i) => {
      if (!matIdx.has(t.mat)) {
        const al = []; for (let b = 0; b < NB; b++) al.push(M.A[i * NB + b]);
        matIdx.set(t.mat, bParams.length);
        bParams.push(t.mat === 'exterior' || t.mat === 'open' ? { r: 1, m: 0, k: 0, mat: t.mat } : Object.assign({ mat: t.mat }, fitBoundary(al)));
      }
      triMat[i] = matIdx.get(t.mat);
    });
    const cellMat = new Int16Array(NC).fill(-1);
    mesh.tris.forEach((t, i) => {
      // FDTD band: use mean of 63/125/250 absorption (random-incidence -> normal-incidence approx via Paris inversion skipped)
      const a = (M.A[i * NB] + M.A[i * NB + 1] + M.A[i * NB + 2]) / 3; triBeta[i] = t.mat === 'exterior' || t.mat === 'open' ? 1 : alphaToBeta(a);
    });
    const idx = (i, j, k) => (k * ny + j) * nx + i;
    // one blocked link may cross several faces (wall thinner than dx: inner face AND the 'exterior' outer face).
    // Each end cell takes the β of the face nearest to it only (v3 fix: before, β_inner and β_exterior=1 were averaged).
    const mark = (cellA, cellB, bit, tiA, tiB) => {
      block[cellA] |= (1 << bit);
      bAcc[cellA] += triBeta[tiA]; bCnt[cellA]++; bAcc[cellB] += triBeta[tiB]; bCnt[cellB]++;
      cellMat[cellA] = triMat[tiA]; cellMat[cellB] = triMat[tiB];
    };
    const markLine = (bit, cellOf, n) => { // res = hits along one grid line -> one mark per crossed link
      res.sort((a, b) => a[0] - b[0]);
      let k = 0;
      while (k < res.length) {
        const i = Math.floor(res[k][0] / dx); let k2 = k;
        while (k2 + 1 < res.length && Math.floor(res[k2 + 1][0] / dx) === i) k2++;
        if (i >= 0 && i < n - 1) mark(cellOf(i), cellOf(i + 1), bit, res[k][1], res[k2][1]);
        k = k2 + 1;
      }
    };
    // lines along x
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const y = oy + j * dx, z = oz + k * dx;
      raycastAll(bvh, ox, y + 1e-5, z + 1e-5, 1, 1e-12, 1e-12, (nx - 1) * dx, res);
      markLine(0, i => idx(i, j, k), nx);
    }
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const x = ox + i * dx, z = oz + k * dx;
      raycastAll(bvh, x + 1e-5, oy, z + 1e-5, 1e-12, 1, 1e-12, (ny - 1) * dx, res);
      markLine(1, j => idx(i, j, k), ny);
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = ox + i * dx, y = oy + j * dx;
      raycastAll(bvh, x + 1e-5, y + 1e-5, oz, 1e-12, 1e-12, 1, (nz - 1) * dx, res);
      markLine(2, k => idx(i, j, k), nz);
    }
    // flood fill air from seed
    const air = new Uint8Array(NC);
    // seed = nearest grid node that the seed point can SEE (no face in between): rounding alone can land inside a wall slab
    const nodeOf = (p, test) => {
      const fi = (p[0] - ox) / dx, fj = (p[1] - oy) / dx, fk = (p[2] - oz) / dx; const cand = [];
      for (let a = -2; a <= 3; a++) for (let b = -2; b <= 3; b++) for (let e = -2; e <= 3; e++) {
        const i = Math.floor(fi) + a, j = Math.floor(fj) + b, k = Math.floor(fk) + e;
        if (i < 1 || j < 1 || k < 1 || i > nx - 2 || j > ny - 2 || k > nz - 2) continue;
        cand.push([(i - fi) ** 2 + (j - fj) ** 2 + (k - fk) ** 2, i, j, k]);
      }
      cand.sort((u, v) => u[0] - v[0]);
      for (const [, i, j, k] of cand) { const c = idx(i, j, k); if (test && !test(c)) continue; if (visible(bvh, p, [ox + i * dx, oy + j * dx, oz + k * dx])) return c; }
      return -1;
    };
    const q = new Int32Array(NC); let qh = 0, qt = 0; const s0 = nodeOf(seedPt);
    if (s0 < 0) throw new Error('FDTD_SEED');
    air[s0] = 1; q[qt++] = s0;
    while (qh < qt) {
      const c = q[qh++]; const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / (nx * ny)) | 0;
      const tryN = (cond, n2, blocked) => { if (cond && !blocked && !air[n2]) { air[n2] = 1; q[qt++] = n2; } };
      tryN(i < nx - 1, c + 1, block[c] & 1); tryN(i > 0, c - 1, i > 0 && (block[c - 1] & 1));
      tryN(j < ny - 1, c + nx, block[c] & 2); tryN(j > 0, c - nx, j > 0 && (block[c - nx] & 2));
      tryN(k < nz - 1, c + nx * ny, block[c] & 4); tryN(k > 0, c - nx * ny, k > 0 && (block[c - nx * ny] & 4));
    }
    // the outermost grid layer is never updated by the solver (p stays 0 -> pressure-release, it REFLECTS). Make it solid so
    // its neighbours see a missing neighbour with β = 1 (absorbing) -> sound leaving through an open window is lost (v3 fix)
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) air[idx(i, j, k)] = 0;
    // K = number of air neighbours reachable without crossing a face; beta = mean of blocking faces, open (unblocked)
    // non-air neighbours = grid boundary -> absorbing β = 1
    const K = new Int8Array(NC).fill(-1); const beta = new Float32Array(NC);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = idx(i, j, k); if (!air[c]) continue;
      let n = 0, edge = 0;
      const nb = (blocked, c2) => { if (blocked) return; if (air[c2]) n++; else edge++; };
      nb(block[c] & 1, c + 1); nb(block[c - 1] & 1, c - 1);
      nb(block[c] & 2, c + nx); nb(block[c - nx] & 2, c - nx);
      nb(block[c] & 4, c + nx * ny); nb(block[c - nx * ny] & 4, c - nx * ny);
      K[c] = n;
      const missing = 6 - n;
      if (missing) beta[c] = (bAcc[c] + edge * 1) / Math.max(1, bCnt[c] + edge);
      if (missing && edge) cellMat[c] = -2; // touches the absorbing grid edge -> resistive with the mixed β
    }
    // sources/receivers snap to the nearest AIR node they can see (v3 fix: rounding could pick a solid node -> silent FDTD)
    const snap = p => nodeOf(p, c => K[c] >= 0);
    return { nx, ny, nz, ox, oy, oz, dx, K, beta, block, airCount: qt, snap, cellMat, bParams };
  }

  /** run CPU FDTD; returns {fs, ir: Float32Array per receiver} — receivers: array of points. source: Gaussian pulse (lowpass fmax) */
  function fdtdRun(grid, src, rcvs, env, opts) {
    opts = opts || {};
    const c = soundSpeed(env.T, env.RH);
    const { nx, ny, nz, dx, K, beta, block } = grid;
    const lam = opts.courant || 1 / Math.sqrt(3);
    const dt = lam * dx / c, fs = 1 / dt;
    const steps = Math.ceil((opts.tMax || 1.0) / dt);
    const NC = nx * ny * nz, l2 = lam * lam;
    let p0 = new Float32Array(NC), p1 = new Float32Array(NC), p2 = new Float32Array(NC);
    const ci = p => { const c = grid.snap ? grid.snap(p) : -1; if (c >= 0) return c; const i = Math.round((p[0] - grid.ox) / dx), j = Math.round((p[1] - grid.oy) / dx), k = Math.round((p[2] - grid.oz) / dx); return (k * ny + j) * nx + i; };
    const sIdx = ci(src); const rIdx = rcvs.map(ci);
    if (K[sIdx] < 0 || rIdx.some(r => K[r] < 0)) throw new Error('FDTD_SNAP');
    const fmax = opts.fmax || c / (6 * dx);
    const sigma = 1 / (2 * Math.PI * fmax * 0.5); // Gaussian width so spectrum ~ -10 dB near fmax
    const t0 = 4 * sigma;
    const g = []; let gs = 0; for (let n = 0; n * dt < 2 * t0; n++) { const v = Math.exp(-Math.pow(n * dt - t0, 2) / (2 * sigma * sigma)); g.push(v); gs += v; }
    for (let n = 0; n < g.length; n++) g[n] /= gs; // unit sum
    if (opts.zeroMean) { // for visualisation: time-derivative of the Gaussian -> no net volume injected, no static pressure step
      const d = g.map((v, n) => n ? v - g[n - 1] : v); let m = 0; d.forEach(v => m = Math.max(m, Math.abs(v))); for (let n = 0; n < g.length; n++) g[n] = d[n] / m * 0.02;
    } else if (opts.source === 'diff') {
      // v3: first difference of the unit-sum Gaussian (zero net volume, like a real loudspeaker). A volume-injecting source
      // leaves a static over-pressure that, with springy (reactive) wall impedances, rings in the room's "breathing" mode.
      // hybridIR divides the spectrum by (1 − e^{−jωΔt})·G(ω) to recover the impulse response.
      const d = g.map((v, n) => n ? v - g[n - 1] : v); for (let n = 0; n < g.length; n++) g[n] = d[n];
      g.push(-g.reduce((a, b) => a + b, 0)); // exact zero sum (closes the last sample)
    }
    const outs = rcvs.map(() => new Float32Array(steps));
    const snap = opts.snap || null, frames = [];
    const snapK = snap ? Math.max(1, Math.min(nz - 2, Math.round(((snap.z == null ? 1.5 : snap.z) - grid.oz) / dx))) : 0;
    const sxy = nx * ny;
    // precompute boundary loss coefficient
    const lb = new Float32Array(NC);
    const useFdb = opts.fdb !== false && grid.bParams && grid.cellMat;
    let nb = 0, bI, bQ, bA, bB, bK, gP, gC, sP, sC;
    if (useFdb) {
      // v3 frequency-dependent boundaries: interior update with L = 0 (p2 = A − p⁻), then per boundary cell
      //   p⁺(1 + Q/2a) = A − p⁻(1 + Q/2a) − Q[(b/a − 1)g⁻ − kψ⁻/a],  g⁺ = [(p⁺+p⁻)/2 + b g⁻ − kψ⁻]/a,  ψ⁺ = ψ⁻ + dt(g⁺+g⁻)
      //   Q = (6−K)λ/2, a = m/2dt + r/2 + k dt/2, b = m/2dt − r/2 − k dt/2,  g = ρc·v_n (pressure units). r-only == old scheme.
      for (let q = 0; q < NC; q++) if (K[q] >= 0 && K[q] < 6) nb++;
      bI = new Int32Array(nb); bQ = new Float64Array(nb); bA = new Float64Array(nb); bB = new Float64Array(nb); bK = new Float64Array(nb);
      gP = new Float64Array(nb); gC = new Float64Array(nb); sP = new Float64Array(nb); sC = new Float64Array(nb);
      let j = 0;
      for (let q = 0; q < NC; q++) if (K[q] >= 0 && K[q] < 6) {
        const cm = grid.cellMat[q]; const P = cm >= 0 ? grid.bParams[cm] : { r: 1 / Math.max(1e-4, beta[q]), m: 0, k: 0 };
        bI[j] = q; bQ[j] = (6 - K[q]) * lam / 2;
        bA[j] = P.m / (2 * dt) + P.r / 2 + P.k * dt / 2; bB[j] = P.m / (2 * dt) - P.r / 2 - P.k * dt / 2; bK[j] = P.k; j++;
      }
    } else for (let q = 0; q < NC; q++) if (K[q] >= 0) lb[q] = 0.5 * lam * (6 - K[q]) * beta[q];
    for (let n = 0; n < steps; n++) {
      for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) {
        let q = (k * ny + j) * nx + 1;
        for (let i = 1; i < nx - 1; i++, q++) {
          const Kq = K[q]; if (Kq < 0) continue;
          let s = 0;
          if (!(block[q] & 1) && K[q + 1] >= 0) s += p1[q + 1];
          if (!(block[q - 1] & 1) && K[q - 1] >= 0) s += p1[q - 1];
          if (!(block[q] & 2) && K[q + nx] >= 0) s += p1[q + nx];
          if (!(block[q - nx] & 2) && K[q - nx] >= 0) s += p1[q - nx];
          if (!(block[q] & 4) && K[q + sxy] >= 0) s += p1[q + sxy];
          if (!(block[q - sxy] & 4) && K[q - sxy] >= 0) s += p1[q - sxy];
          const L = lb[q];
          p2[q] = ((2 - Kq * l2) * p1[q] + l2 * s - (1 - L) * p0[q]) / (1 + L);
        }
      }
      if (useFdb) for (let j = 0; j < nb; j++) {
        const q = bI[j], pm = p0[q], A = p2[q] + pm, a = bA[j], Q = bQ[j], gm = gP[j], sm = sP[j], kk = bK[j];
        const h = 1 + Q / (2 * a);
        const pp = (A - pm * h - Q * ((bB[j] / a - 1) * gm - kk * sm / a)) / h;
        const gp = ((pp + pm) / 2 + bB[j] * gm - kk * sm) / a;
        p2[q] = pp; gP[j] = gC[j]; gC[j] = gp; const sp = sm + dt * (gp + gm); sP[j] = sC[j]; sC[j] = sp;
      }
      if (n < g.length) p2[sIdx] += g[n];
      for (let r = 0; r < rIdx.length; r++) outs[r][n] = p2[rIdx[r]];
      if (snap && n % snap.every === 0 && frames.length < snap.max) {
        const fr = new Float32Array(nx * ny); const base = snapK * nx * ny;
        for (let q = 0; q < nx * ny; q++) fr[q] = K[base + q] >= 0 ? p2[base + q] : NaN;
        frames.push(fr);
      }
      if (opts.onProgress && n % 200 === 0) opts.onProgress(n / steps);
      const t = p0; p0 = p1; p1 = p2; p2 = t;
    }
    // calibration: p(r) = dx * s(t - r/c) / (4π λ² r)  ->  scale so that a unit-sum source gives 1/r (per audio-rate unit impulse)
    const scale = 4 * Math.PI * l2 / dx;
    outs.forEach(o => { for (let n = 0; n < o.length; n++) o[n] *= scale; });
    // a point "soft source" injects net volume -> a static pressure step in a closed room. Loudspeakers cannot make DC,
    // so remove it with a zero-phase 2nd-order Butterworth high-pass at 15 Hz (well below the 63 Hz octave).
    if (opts.dcBlock !== false) outs.forEach(o => { hp2(o, 15, fs); o.reverse(); hp2(o, 15, fs); o.reverse(); });
    return { fs, dt, steps, ir: outs, delay0: t0, fmax, sigma, frames, frameEvery: snap ? snap.every : 0, fdb: !!useFdb, source: opts.source === 'diff' && !opts.zeroMean ? 'diff' : 'gauss' };
  }

  function hp2(x, fc, fs) { // RBJ 2nd-order Butterworth high-pass, in place
    const w0 = 2 * Math.PI * fc / fs, al = Math.sin(w0) / Math.SQRT2, cw = Math.cos(w0), a0 = 1 + al;
    const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; x[i] = v; }
  }

  function lp2(x, fc, fs) { // RBJ 2nd-order Butterworth low-pass, in place
    const w0 = 2 * Math.PI * fc / fs, al = Math.sin(w0) / Math.SQRT2, cw = Math.cos(w0), a0 = 1 + al;
    const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; x[i] = v; }
  }
  function zeroPhase(x, f, fc, fs) { f(x, fc, fs); x.reverse(); f(x, fc, fs); x.reverse(); }
  /** merge: FDTD below fx, geometric above. Zero-phase Butterworth pairs are power-complementary (|LP|²+|HP|² = 1).
   *  geo = {L,R,fs,shift}; fd = {ir:[Float32Array], fs (grid rate), delay0} */
  function hybridIR(geo, fd, fx) {
    const fs = geo.fs, n = geo.L.length, low = new Float32Array(n), src = fd.ir[0];
    for (let i = 0; i < n; i++) {
      const tAbs = i / fs + geo.shift + fd.delay0; const u = tAbs * fd.fs; const k = Math.floor(u), fr = u - k;
      if (k >= 0 && k + 1 < src.length) low[i] = src[k] * (1 - fr) + src[k + 1] * fr;
    }
    // FDTD samples are at the grid rate; a unit-sum source maps to a unit-sum audio-rate impulse -> rescale by grid/audio rate
    const sc = fd.fs / fs; for (let i = 0; i < n; i++) low[i] *= sc;
    // deconvolve the Gaussian source pulse: |G(f)| = exp(-(2πfσ)²/2) -> divide (gain capped at +24 dB, only matters below ~1.5 fx)
    if (fd.sigma) {
      let N = 1; while (N < n) N <<= 1;
      const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < n; i++) re[i] = low[i];
      fft(re, im, false);
      for (let k = 0; k <= N / 2; k++) {
        const f = k * fs / N; const g = Math.min(16, Math.exp(Math.pow(2 * Math.PI * f * fd.sigma, 2) / 2));
        let gr = g, gi = 0;
        if (fd.source === 'diff') { // divide by D = 1 − e^{−jωΔt} (Δt = grid step); below 12 Hz -> 0 (no loudspeaker reaches DC)
          const w = 2 * Math.PI * f * fd.dt, dr = 1 - Math.cos(w), di = Math.sin(w), d2 = dr * dr + di * di;
          if (f < 12 || d2 < 1e-30) { gr = 0; gi = 0; } else { gr = g * dr / d2; gi = -g * di / d2; }
        }
        const mulc = (i, sg) => { const a = re[i], b = im[i]; re[i] = a * gr - b * gi * sg; im[i] = a * gi * sg + b * gr; };
        mulc(k, 1); if (k > 0 && k < N / 2) mulc(N - k, -1);
      }
      fft(re, im, true); for (let i = 0; i < n; i++) low[i] = re[i];
    }
    zeroPhase(low, lp2, fx, fs);
    const out = {};
    ['L', 'R'].forEach(ch => { const h = Float32Array.from(geo[ch]); zeroPhase(h, hp2, fx, fs); for (let i = 0; i < n; i++) h[i] += low[i]; out[ch] = h; });
    return { L: out.L, R: out.R, fs, shift: geo.shift, fx };
  }

  // ---------- FFT (radix-2, in place) ----------
  function fft(re, im, inv) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const ang = (inv ? 2 : -2) * Math.PI / size; const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let s = 0; s < n; s += size) {
        let cr = 1, ci = 0;
        for (let k = 0; k < size / 2; k++) {
          const a = s + k, b = a + size / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  /** magnitude response on rfft bins from 8 band gains (log-frequency linear interpolation in dB) */
  function bandCurve(gains, nfft, fs, out) {
    const lg = gains.map(g => Math.log(Math.max(g, 1e-9)));
    const lf = BANDS.map(f => Math.log(f));
    for (let k = 0; k <= nfft / 2; k++) {
      const f = Math.max(k * fs / nfft, 20); const x = Math.log(f);
      let v;
      if (x <= lf[0]) v = lg[0]; else if (x >= lf[NB - 1]) v = lg[NB - 1] + (x - lf[NB - 1]) * (lg[NB - 1] - lg[NB - 2]) / (lf[NB - 1] - lf[NB - 2]) * 0.5;
      else { let b = 0; while (lf[b + 1] < x) b++; const w = (x - lf[b]) / (lf[b + 1] - lf[b]); v = lg[b] * (1 - w) + lg[b + 1] * w; }
      out[k] = Math.exp(v);
    }
    return out;
  }

  // ---------- simple spherical-head binaural cues (Brown & Duda 1998) ----------
  function headCues(dir, facing, fs) {
    // azimuth of arrival relative to facing direction in horizontal plane; positive = left
    const f = norm([facing[0], facing[1], 0]); const left = [-f[1], f[0], 0];
    const dh = norm([dir[0], dir[1], 1e-9]);
    const az = Math.atan2(dot(dh, left), dot(dh, f)); // -pi..pi
    const elev = Math.asin(Math.max(-1, Math.min(1, dir[2])));
    const a = 0.0875, c = 343;
    const ears = [Math.PI / 2, -Math.PI / 2].map(earAz => {
      let th = Math.acos(Math.max(-1, Math.min(1, Math.cos(elev) * Math.cos(az - earAz)))); // angle between source dir and ear axis
      const alpha = 1.05 + 0.95 * Math.cos(th * 180 / 150); // head-shadow
      // Woodworth ITD
      const tau = th < Math.PI / 2 ? -a / c * Math.cos(th) : a / c * (th - Math.PI / 2);
      return { alpha, tau };
    });
    return ears; // [left, right]
  }

  // ---------- IR synthesis ----------
  /** early: [{delay, gains[NB], dir}]; late: ray result; returns {L,R, fs} Float32Arrays */
  function synthIR(early, late, opts) {
    const fs = opts.fs || 48000, tLen = opts.tLen || 2.0, V = opts.V || 100, c = opts.c || 343;
    const n = Math.ceil(tLen * fs); const L = new Float32Array(n), Rr = new Float32Array(n);
    const R = rng(opts.seed || 99);
    const facing = opts.facing || [1, 0, 0];
    // --- early arrivals: each filtered by a short linear-phase FIR built from its band gains + head cues
    const NF = 256, half = NF / 2;
    const re = new Float64Array(NF), im = new Float64Array(NF), mag = new Float64Array(NF / 2 + 1);
    const win = new Float64Array(NF); for (let i = 0; i < NF; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / NF);
    const firCache = new Map();
    function firFor(gains, alpha) {
      bandCurve(gains, NF, fs, mag);
      re.fill(0); im.fill(0);
      for (let k = 0; k <= NF / 2; k++) {
        const f = k * fs / NF; const w0 = 2 * c / 0.0875;
        // head shadow one-pole-one-zero |H| = |(1 + j α ω/2w0)/(1 + j ω/2w0)|
        const wr = 2 * Math.PI * f / (2 * w0); const hs = alpha == null ? 1 : Math.hypot(1, alpha * wr) / Math.hypot(1, wr);
        const mgk = mag[k] * hs; const ph = -2 * Math.PI * k * half / NF;
        re[k] = mgk * Math.cos(ph); im[k] = mgk * Math.sin(ph);
        if (k > 0 && k < NF / 2) { re[NF - k] = re[k]; im[NF - k] = -im[k]; }
      }
      fft(re, im, true);
      const h = new Float32Array(NF); for (let i = 0; i < NF; i++) h[i] = re[i] * win[i];
      return h;
    }
    function addFrac(buf, t, h, gain) {
      const pos = t * fs - half; const i0 = Math.floor(pos), fr = pos - i0;
      for (let i = 0; i < NF; i++) {
        const v = h[i] * gain; const a = i0 + i;
        if (a >= 0 && a < n) buf[a] += v * (1 - fr);
        if (a + 1 >= 0 && a + 1 < n) buf[a + 1] += v * fr;
      }
    }
    let tFirst = Infinity; early.forEach(e => { tFirst = Math.min(tFirst, e.delay); });
    if (!isFinite(tFirst)) tFirst = 0;
    const pre = opts.pre == null ? 0.005 : opts.pre; const shift = tFirst - pre; // start IR shortly before first arrival
    early.forEach(e => {
      const t = e.delay - shift; if (t < 0 || t >= tLen) return;
      if (opts.mono) { addFrac(L, t, firFor(e.gains, null), 1); return; }
      const ears = headCues(e.dir, facing, fs);
      addFrac(L, t + ears[0].tau, firFor(e.gains, ears[0].alpha), 1);
      addFrac(Rr, t + ears[1].tau, firFor(e.gains, ears[1].alpha), 1);
    });
    // --- late: Poisson Dirac sequence shaped per frame by the ray-traced band energies
    if (late && late.H) {
      const nBins = late.nBins, bdt = late.binDt;
      const FR = 512, hop = FR / 2;
      const w = new Float64Array(FR); for (let i = 0; i < FR; i++) w[i] = Math.sin(Math.PI * (i + 0.5) / FR); // sqrt-Hann (analysis*synthesis = Hann, COLA at 50%)
      const chans = opts.mono ? [L] : [L, Rr];
      chans.forEach((buf, ch) => {
        const Rn = rng((opts.seed || 99) + 17 * (ch + 1));
        // dirac sequence
        const dseq = new Float32Array(n);
        let t = 0.0005 + (late.tStart || 0);
        const mu = tt => Math.min(4 * Math.PI * c * c * c * tt * tt / V, fs / 4);
        // generate events
        let tt = Math.max(1e-3, t);
        while (tt < tLen + shift) {
          const rate = Math.max(mu(tt), 1500); // floor: every 512-sample frame must hold Diracs or its energy is lost
          tt += -Math.log(1 - Rn()) / rate;
          const s = Math.round((tt - shift) * fs); if (s >= 0 && s < n) dseq[s] += Rn() < 0.5 ? 1 : -1;
        }
        const fre = new Float64Array(FR), fim = new Float64Array(FR), gb = new Float64Array(NB), cur = new Float64Array(FR / 2 + 1);
        for (let st = 0; st + FR <= n + FR; st += hop) {
          // band energies for this frame: sum histogram over frame span (absolute time = st/fs + shift)
          const tA = st / fs + shift, tB = (st + FR) / fs + shift;
          const bA = Math.max(0, Math.floor(tA / bdt)), bB = Math.min(nBins, Math.ceil(tB / bdt));
          // energy per second in each band -> want sum of squares of IR over the frame = E_band(frame)
          let dirac2 = 0; for (let i = 0; i < FR; i++) { const s = st + i; if (s < n) dirac2 += dseq[s] * dseq[s] * w[i] * w[i]; }
          if (dirac2 <= 0 || bB <= bA) continue;
          // Each band histogram holds the energy transfer for a flat-spectrum source (every ray carries the full source energy
          // in every band), so sqrt(4π·E_b / Σ(d·w)²) is directly the band's magnitude response for this frame.
          // Frames overlap 50 % (each bin is seen by 2 frames) -> use half the frame-span energy.
          for (let b = 0; b < NB; b++) { let e = 0; for (let k = bA; k < bB; k++) e += late.H[b * nBins + k]; gb[b] = Math.sqrt(4 * Math.PI * e * (hop / FR) / dirac2); }
          for (let i = 0; i < FR; i++) { const s = st + i; fre[i] = s < n ? dseq[s] * w[i] : 0; fim[i] = 0; }
          fft(fre, fim, false);
          bandCurve(gb, FR, fs, cur);
          for (let k = 0; k <= FR / 2; k++) { fre[k] *= cur[k]; fim[k] *= cur[k]; if (k > 0 && k < FR / 2) { fre[FR - k] = fre[k]; fim[FR - k] = -fim[k]; } }
          fft(fre, fim, true);
          for (let i = 0; i < FR; i++) { const s = st + i; if (s < n) buf[s] += fre[i] * w[i]; }
        }
      });
    }
    if (opts.mono) Rr.set(L);
    return { L, R: Rr, fs, shift };
  }
  /** fraction of white-noise energy (up to fs/2) that falls in octave band b */
  function octaveShare(b, fs) {
    const lo = BANDS[b] / Math.SQRT2, hi = Math.min(BANDS[b] * Math.SQRT2, fs / 2);
    let l = b === 0 ? 0 : lo, h = b === NB - 1 ? fs / 2 : hi;
    return Math.max(1e-6, (h - l) / (fs / 2));
  }

  // ---------- ISO 3382 analysis in JS (Schroeder; used in-app and in tests) ----------
  function biquadBandpass(fc, fs) { // RBJ constant-0dB-peak bandpass, Q = sqrt2 (one octave)
    const w0 = 2 * Math.PI * fc / fs, Q = Math.SQRT2, al = Math.sin(w0) / (2 * Q);
    const a0 = 1 + al; return { b0: al / a0, b1: 0, b2: -al / a0, a1: -2 * Math.cos(w0) / a0, a2: (1 - al) / a0 };
  }
  function filt(x, c) { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; }
  function bandFilter(x, fc, fs) { const c = biquadBandpass(fc, fs); return filt(filt(filt(x, c), c), c); } // 6th order
  function decayParams(x, fs) {
    // onset
    let mx = 0; for (let i = 0; i < x.length; i++) mx = Math.max(mx, x[i] * x[i]);
    let on = 0; while (on < x.length && x[on] * x[on] < mx * 0.01) on++;
    const res = { EDT: [], T20: [], T30: [], C80: [], D50: [] };
    for (let b = 0; b < NB; b++) {
      if (BANDS[b] * Math.SQRT2 > fs / 2) { ['EDT', 'T20', 'T30', 'C80', 'D50'].forEach(k => res[k].push(null)); (res.T30from20 = res.T30from20 || []).push(false); continue; }
      const y = bandFilter(x.subarray ? x.subarray(on) : x.slice(on), BANDS[b], fs);
      const n = y.length; const e = new Float64Array(n); for (let i = 0; i < n; i++) e[i] = y[i] * y[i];
      // truncation compensation (Lundeby et al. 1995 / ISO 3382-1 §5.3.4): an IR cut before it has decayed misses the tail
      // energy  E_tail = e(t_end)·τ,  τ = T/(6 ln10). τ from a fit to the 10 ms-block envelope over the second half of the IR.
      let tail = 0;
      { const blk = Math.max(1, Math.round(0.01 * fs)), nbk = Math.floor(n / blk); const env = [];
        for (let k = 0; k < nbk; k++) { let s2 = 0; for (let i = k * blk; i < (k + 1) * blk; i++) s2 += e[i]; env.push(s2 / blk); }
        if (nbk >= 20) {
          const k0 = Math.floor(nbk * 0.5), k1 = nbk - 1; let sx = 0, sy = 0, sxx = 0, sxy = 0, c2 = 0;
          for (let k = k0; k <= k1; k++) { if (!(env[k] > 0)) continue; const t = (k + 0.5) * blk / fs, d = 10 * Math.log10(env[k]); sx += t; sy += d; sxx += t * t; sxy += t * d; c2++; }
          const sl = c2 > 5 ? (c2 * sxy - sx * sy) / (c2 * sxx - sx * sx) : 0; // dB/s
          if (sl < -1) { const tau = -60 / sl / (6 * Math.LN10), a0 = (sy - sl * sx) / c2; // fitted line at t_end
            tail = Math.pow(10, (a0 + sl * n / fs) / 10) * tau * fs; }
        }
      }
      const sc = new Float64Array(n); let acc = tail; for (let i = n - 1; i >= 0; i--) { acc += e[i]; sc[i] = acc; }
      const tot = sc[0] || 1e-30; const db = i => 10 * Math.log10(sc[i] / tot + 1e-30);
      const fit = (hi, lo) => {
        let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0, minDb = 0;
        for (let i = 0; i < n; i++) { const d = db(i); minDb = Math.min(minDb, d); if (d <= hi && d >= lo) { const t = i / fs; sx += t; sy += d; sxx += t * t; sxy += t * d; cnt++; } }
        if (cnt < 10 || minDb > lo) return null; const sl = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx); return sl < 0 ? -60 / sl : null;
      };
      // ISO 3382-1 allows T20 when the decay range is too short for T30; flag it so the UI can say so
      const t20 = fit(-5, -25); let t30 = fit(-5, -35); const from20 = t30 == null && t20 != null; if (from20) t30 = t20;
      res.EDT.push(fit(0, -10)); res.T20.push(t20); res.T30.push(t30); (res.T30from20 = res.T30from20 || []).push(from20);
      const n80 = Math.min(n, Math.round(0.08 * fs)), n50 = Math.min(n, Math.round(0.05 * fs));
      let e80 = 0, e50 = 0; for (let i = 0; i < n80; i++) e80 += e[i]; for (let i = 0; i < n50; i++) e50 += e[i];
      res.C80.push(10 * Math.log10(e80 / Math.max(tot - e80, 1e-30))); res.D50.push(e50 / tot);
    }
    return res;
  }

  /** low-frequency transfer function at the receiver (v3 "저음 분석"): |H(f)| in dB, 1/24-octave smoothed, on a log grid
   *  20..fMax Hz, plus the strongest resonance peaks (local maxima ≥ 3 dB above the ±1/6-octave surroundings). */
  function lowFreqResponse(x, fs, fMax) {
    let N = 1; while (N < x.length) N <<= 1; N = Math.min(N, 1 << 19);
    const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < Math.min(x.length, N); i++) re[i] = x[i];
    fft(re, im, false);
    const df = fs / N, mag2 = k => re[k] * re[k] + im[k] * im[k];
    const f = [], db = []; const n = 360, f0 = 20, f1 = Math.max(40, fMax);
    for (let i = 0; i < n; i++) {
      const fc = f0 * Math.pow(f1 / f0, i / (n - 1)), lo = fc * Math.pow(2, -1 / 48), hi = fc * Math.pow(2, 1 / 48);
      let s2 = 0, c = 0; for (let k = Math.max(1, Math.floor(lo / df)); k <= Math.ceil(hi / df); k++) { s2 += mag2(k); c++; }
      f.push(fc); db.push(10 * Math.log10(s2 / Math.max(1, c) + 1e-30));
    }
    const peaks = []; const w = Math.round(n * Math.log2(Math.pow(2, 1 / 6)) / Math.log2(f1 / f0)) || 1;
    for (let i = 1; i < n - 1; i++) {
      if (!(db[i] >= db[i - 1] && db[i] > db[i + 1])) continue;
      let mn = Infinity; for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) mn = Math.min(mn, db[j]);
      if (db[i] - mn >= 3) peaks.push({ f: f[i], db: db[i] });
    }
    peaks.sort((a, b) => b.db - a.db);
    const keep = []; for (const p of peaks) if (!keep.some(q => Math.abs(Math.log2(p.f / q.f)) < 1 / 12)) keep.push(p); // one mode = one peak
    return { f, db, peaks: keep.slice(0, 8).sort((a, b) => a.f - b.f) };
  }

  // ---------- one-call simulation ----------
  function simulate(spec, opts) {
    opts = opts || {};
    const env = Object.assign({ T: 20, RH: 50, grad: 0 }, spec.env || {});
    const mesh = buildMesh(spec); const bvh = buildBVH(mesh.tris); const M = matArrays(mesh, opts.mats);
    const src = spec.source || [1, 1, 1.5], rcv = spec.receiver || [3, 2, 1.2];
    const c = soundSpeed(env.T, env.RH);
    const t0 = Date.now();
    const isr = imageSources(mesh, bvh, M, src, rcv, opts.isOrder == null ? 2 : opts.isOrder, env);
    const dif = opts.diffraction === false ? [] : edgeDiffraction(mesh, bvh, M, src, rcv, env);
    const ray = rayTrace(mesh, bvh, M, src, rcv, Object.assign({}, env), { rays: opts.rays || 20000, tMax: opts.tLen || 2.5, isOrder: isr.order, seed: opts.seed, dirs: true });
    const early = isr.list.concat(dif);
    const ir = synthIR(early, ray, { fs: opts.fs || 48000, tLen: opts.tLen || 2.5, V: mesh.volume, c, seed: opts.seed, facing: spec.facing || [1, 0, 0], mono: opts.mono });
    const se = sabineEyring(mesh, opts.mats, env);
    return { mesh, bvh, M, isr, dif, ray, early, ir, se, ms: Date.now() - t0, env, c };
  }

  // ---------- shoebox helper (for tests and the starter scene) ----------
  function shoebox(Lx, Ly, H, mats, thick) {
    mats = mats || {}; thick = thick || 0.2;
    const w = (x, y, mat) => ({ x, y, thick, mat });
    return {
      loop: [w(0, 0, mats.s || mats.walls), w(Lx, 0, mats.e || mats.walls), w(Lx, Ly, mats.n || mats.walls), w(0, Ly, mats.w || mats.walls)],
      ceiling: { type: 'flat', h: H, mat: mats.ceiling }, floorMat: mats.floor
    };
  }

  const api = {
    BANDS, NB, MATERIALS, defMat, airAbsDb, airM, soundSpeed, buildMesh, buildBVH, raycast, matArrays, sabineEyring,
    imageSources, edgeDiffraction, utdField, fresnelTail, rayTrace, voxelise, raycastAll, refractPath, dcdT, fdtdRun, fft, bandCurve, synthIR, decayParams,
    simulate, shoebox, rng, bandFilterExport: bandFilter, hybridIR, lp2, hp2, alphaRandom, betaFromRandomAlpha, earClip, polyArea, pointInPoly, headCues, visible, octaveShare,
    fitBoundary, alphaRandomZ, lowFreqResponse,
    phys: { miki, surfaceZ, alphaAt, alphaField, alphaOctaves, buildUp, resonanceHz, applyPhysLF, makeMaterial },
    vec: { add, sub, mul, dot, cross, len, norm }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
