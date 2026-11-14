/* Sound Architect — simulation worker. Messages:
 *  in : {type:'sim', id, spec, q:{rays, tLen, fmax, isOrder, wave}}
 *  out: {type:'progress', id, stage, f} | {type:'result', id, ...} | {type:'error', id, message}
 */
importScripts('core.js', 'materials.js');

function post(type, o, tr) { self.postMessage(Object.assign({ type }, o), tr || []); }

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type !== 'sim') return;
  const id = m.id;
  try {
    const t0 = Date.now();
    const spec = m.spec, q = m.q;
    const env = Object.assign({ T: 20, RH: 50, grad: 0 }, spec.env || {});
    const prog = (stage, f) => post('progress', { id, stage, f });
    // user-built materials (재질 만들기) travel with the spec
    for (const [mid, mm] of Object.entries(spec.customMats || {})) SA.defMat(mid, mm);
    prog('geometry', 0);
    const mesh = SA.buildMesh(spec), bvh = SA.buildBVH(mesh.tris), M = SA.matArrays(mesh);
    const src = spec.source, rcv = spec.receiver, c = SA.soundSpeed(env.T, env.RH);
    // validity: source/receiver must be inside the air volume (between floor and ceiling, inside walls)
    const inside = p => SA.pointInPoly([p[0], p[1]], mesh.inner) && p[2] > 0.05 && p[2] < mesh.zc(p[0], p[1]) - 0.05;
    if (!inside(src) || !inside(rcv)) throw new Error(!inside(src) ? 'SRC_OUTSIDE' : 'RCV_OUTSIDE');
    prog('early', 0);
    const isr = SA.imageSources(mesh, bvh, M, src, rcv, q.isOrder == null ? 2 : q.isOrder, env);
    const dif = SA.edgeDiffraction(mesh, bvh, M, src, rcv, env);
    prog('rays', 0);
    const ray = SA.rayTrace(mesh, bvh, M, src, rcv, env, { rays: q.rays, tMax: q.tLen, isOrder: isr.order, seed: 7, dirs: true, onProgress: f => prog('rays', f) });
    prog('synth', 0);
    const early = isr.list.concat(dif);
    const fs = 48000;
    let ir = SA.synthIR(early, ray, { fs, tLen: q.tLen, V: mesh.volume, c, seed: 11, facing: spec.facing || [1, 0, 0] });
    // omnidirectional channel for ISO 3382 analysis (averaging the two decorrelated ear tails would lose 3 dB of late energy)
    let omni = SA.synthIR(early, ray, { fs, tLen: q.tLen, V: mesh.volume, c, seed: 11, mono: true });
    let fdInfo = null, frames = [], grid = null;
    if (q.fmax > 0) {
      let fmax = q.fmax, dx = c / (7 * fmax);
      const ext = (mesh.bb.x1 - mesh.bb.x0 + 1) * (mesh.bb.y1 - mesh.bb.y0 + 1) * (mesh.bb.z1 + 0.5);
      const MAXC = 2.5e6; // memory/time guard
      if (ext / (dx * dx * dx) > MAXC) { dx = Math.cbrt(ext / MAXC); fmax = c / (7 * dx); }
      prog('voxel', 0);
      try {
      const g = SA.voxelise(mesh, bvh, dx, rcv, M);
      const fd = SA.fdtdRun(g, src, [rcv], env, {
        tMax: q.tLen + 0.1, fmax, onProgress: f => prog('wave', f), zeroMean: !!q.wave, source: 'diff',
        snap: q.wave ? { every: Math.max(1, Math.round((1 / 1200) / (dx / (c * Math.sqrt(3))))), max: 360, z: rcv[2] } : null
      });
      const fx = Math.round(0.65 * fmax);
      if (!q.wave) { ir = SA.hybridIR(ir, fd, fx); omni = SA.hybridIR(omni, fd, fx); } // wave-view run uses a zero-mean pulse: frames only
      fdInfo = { fmax: Math.round(fmax), fx, dx, cells: g.airCount, steps: fd.steps, gridFs: fd.fs };
      frames = fd.frames; grid = { nx: g.nx, ny: g.ny, ox: g.ox, oy: g.oy, dx: g.dx, frameDt: fd.frameEvery / fd.fs };
      } catch (e) { // no air grid node reachable from the source/receiver (e.g. squeezed into a tiny gap): keep the geometric IR
        if (!/^FDTD_/.test(e.message)) throw e; fdInfo = { skipped: e.message };
      }
    }
    prog('analyse', 0);
    const mono = omni.L;
    const metrics = SA.decayParams(mono, fs);
    // G (strength, ISO 3382-1): band energy relative to the same source in free field at 10 m. Our IR is calibrated so the
    // direct sound at 1 m has amplitude 1 -> reference = band energy of an impulse of amplitude 0.1.
    metrics.G = SA.BANDS.map((f, b) => {
      if (f * Math.SQRT2 > fs / 2) return null;
      const y = SA.bandFilterExport(Float64Array.from(mono), f, fs); let e = 0; for (let i = 0; i < y.length; i++) e += y[i] * y[i];
      const imp = new Float64Array(fs / 2); imp[100] = 0.1; const r = SA.bandFilterExport(imp, f, fs); let er = 0; for (let i = 0; i < r.length; i++) er += r[i] * r[i];
      return 10 * Math.log10(e / er);
    });
    // Schroeder curves per band for plotting (downsampled to 10 ms) + echogram (1 ms bins, 1 kHz band)
    const curves = [];
    for (let b = 1; b < 7; b++) {
      const y = SA.bandFilterExport(Float64Array.from(mono), SA.BANDS[b], fs);
      let mx = 0, on = 0; for (let i = 0; i < y.length; i++) mx = Math.max(mx, y[i] * y[i]);
      while (on < y.length && y[on] * y[on] < mx * 0.01) on++;
      const n = y.length; const sc = new Float64Array(n); let acc = 0; for (let i = n - 1; i >= on; i--) { acc += y[i] * y[i]; sc[i] = acc; }
      const step = Math.round(0.01 * fs); const pts = [];
      for (let i = on; i < n; i += step) pts.push(10 * Math.log10(sc[i] / (sc[on] || 1e-30) + 1e-30));
      curves.push(pts);
    }
    const eg = new Float32Array(Math.ceil(Math.min(q.tLen, 1.0) * 1000));
    { const y = SA.bandFilterExport(Float64Array.from(mono), 1000, fs); const st = fs / 1000; for (let k = 0; k < eg.length; k++) { let e = 0; for (let i = k * st; i < (k + 1) * st && i < y.length; i++) e += y[i] * y[i]; eg[k] = e; } }
    const paths = early.slice().sort((a, b) => a.delay - b.delay).slice(0, 400).map(e => ({ d: e.delay, o: e.order, df: !!e.diffracted, g: e.gains.slice(), p: e.path }));
    // 저음 분석: transfer function below ~300 Hz; trustworthy as a wave result only where the FDTD band was computed
    const lfw = SA.lowFreqResponse(mono, fs, fdInfo && fdInfo.fx ? Math.min(400, Math.round(fdInfo.fx * 1.25)) : 300);
    const lf = { f: Float32Array.from(lfw.f), db: Float32Array.from(lfw.db), peaks: lfw.peaks, wave: !!(fdInfo && fdInfo.fx), fx: fdInfo && fdInfo.fx };
    const se = SA.sabineEyring(mesh, null, env);
    const result = {
      id, ms: Date.now() - t0, L: ir.L, R: ir.R, fs, metrics, curves, echogram: eg, paths, shift: ir.shift,
      se: { sabine: se.sabine, eyring: se.eyring, V: mesh.volume, S: se.S, meanAlpha: se.meanAlpha },
      ray: { lost: ray.lost, rr: ray.rr, rays: q.rays }, is: { order: isr.order, groups: isr.groups, count: isr.list.length }, diff: dif.length,
      fd: fdInfo, grid, c, env, lf
    };
    const tr = [ir.L.buffer, ir.R.buffer, eg.buffer];
    if (frames.length) { result.frames = frames; frames.forEach(f => tr.push(f.buffer)); }
    post('result', result, tr);
  } catch (e) {
    post('error', { id, message: e && e.message || String(e) });
  }
};
