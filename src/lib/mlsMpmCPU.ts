/**
 * MLS-MPM 3D Fluid Solver — CPU Implementation
 * 
 * Full Moving Least Squares Material Point Method with:
 * - Quadratic B-spline weight functions
 * - APIC (Affine Particle-In-Cell) velocity transfers
 * - Equation-of-state pressure model
 * - Viscosity via strain rate tensor
 * - Gravity and boundary enforcement
 * - Particle aging, reabsorption, compaction
 * - Density-based regime classification (sheet/filament/droplet)
 *
 * Reference: Hu et al. "A Moving Least Squares Material Point Method" (2018)
 */

// Grid dimensions (cells) — large enough to cover visible ocean area
const GW = 128, GH = 48, GD = 128;
const CELL_SIZE = 0.5; // world units per cell
const INV_CELL = 1.0 / CELL_SIZE;

// Domain origin in world space (grid cell 0,0,0 maps here)
// Covers world space [-32, 32] x [-6, 18] x [-32, 32]
const ORIGIN_X = -32, ORIGIN_Y = -6, ORIGIN_Z = -32;

// Solver constants
const MAX_PARTICLES = 1024;
const GRAVITY = -9.8;
const REST_DENSITY = 3.0;
const STIFFNESS = 30.0;
const VISCOSITY = 0.12;
const MAX_AGE = 6.0;

export { MAX_PARTICLES };

export class MLSMPMSolver {
  // SoA particle storage
  px: Float32Array; py: Float32Array; pz: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  C: Float32Array;   // 9 per particle (3x3 APIC affine matrix)
  mass: Float32Array;
  density: Float32Array;
  age: Float32Array;
  alive: Uint8Array;
  count = 0;

  // Grid (flat arrays)
  gMass: Float32Array;
  gVx: Float32Array; gVy: Float32Array; gVz: Float32Array;

  // Bounding box of active particles (world space)
  boundsMin = [0, 0, 0];
  boundsMax = [0, 0, 0];

  constructor() {
    const N = MAX_PARTICLES;
    this.px = new Float32Array(N);
    this.py = new Float32Array(N);
    this.pz = new Float32Array(N);
    this.vx = new Float32Array(N);
    this.vy = new Float32Array(N);
    this.vz = new Float32Array(N);
    this.C = new Float32Array(N * 9);
    this.mass = new Float32Array(N).fill(1.0);
    this.density = new Float32Array(N);
    this.age = new Float32Array(N);
    this.alive = new Uint8Array(N);

    const G = GW * GH * GD;
    this.gMass = new Float32Array(G);
    this.gVx = new Float32Array(G);
    this.gVy = new Float32Array(G);
    this.gVz = new Float32Array(G);
  }

  /** Convert world → grid coordinates */
  private w2g(wx: number, wy: number, wz: number): [number, number, number] {
    return [
      (wx - ORIGIN_X) * INV_CELL,
      (wy - ORIGIN_Y) * INV_CELL,
      (wz - ORIGIN_Z) * INV_CELL,
    ];
  }

  private gi(x: number, y: number, z: number): number {
    return x * GH * GD + y * GD + z;
  }

  /**
   * Spawn particles organically from wave surface.
   * Places particles in a thin sheet along the surface with inherited wave momentum.
   * NOT an explosion — particles conform to the surface and inherit its velocity.
   * 
   * @param wx World X of spawn center
   * @param wz World Z of spawn center  
   * @param surfaceH Ocean height at spawn point
   * @param count Number of particles to spawn
   * @param surfaceVel Wave surface momentum [vx, vy, vz] — inherited from wave gradients
   * @param rupture Rupture potential (0-1+) — controls upward lift and spread
   * @param oceanHeightAt Callback to get ocean height at any point
   */
  spawnFromSurface(
    wx: number, wz: number,
    surfaceH: number,
    count: number,
    surfaceVel: [number, number, number],
    rupture: number,
    oceanHeightAt?: (x: number, z: number) => number,
  ) {
    // Clamp spawn to grid interior
    const [gx, , gz] = this.w2g(wx, 0, wz);
    if (gx < 4 || gx >= GW - 4 || gz < 4 || gz >= GD - 4) return;

    const spreadRadius = 1.0 + rupture * 2.0; // How wide the spawn patch is
    const surfNormalLift = rupture * 3.0; // Upward velocity from rupture severity
    
    for (let i = 0; i < count && this.count < MAX_PARTICLES; i++) {
      const idx = this.count;
      
      // Place in a thin disc on the surface
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * spreadRadius;
      const spx = wx + Math.cos(angle) * r;
      const spz = wz + Math.sin(angle) * r;
      
      // Get actual ocean height at this offset position
      const localH = oceanHeightAt 
        ? oceanHeightAt(spx, spz) 
        : surfaceH;
      
      // Place slightly above surface (thin sheet)
      this.px[idx] = spx;
      this.py[idx] = localH + 0.05 + Math.random() * 0.15;
      this.pz[idx] = spz;

      // Velocity: inherit surface momentum + controlled upward lift from rupture
      // Forward throw from wave momentum (the key insight from the docs)
      const jitter = 0.3;
      this.vx[idx] = surfaceVel[0] + (Math.random() - 0.5) * jitter;
      this.vy[idx] = surfaceVel[1] + surfNormalLift * (0.5 + Math.random() * 0.5);
      this.vz[idx] = surfaceVel[2] + (Math.random() - 0.5) * jitter;

      // Lateral spread along crest tangent (perpendicular to momentum)
      const umag = Math.sqrt(surfaceVel[0] ** 2 + surfaceVel[2] ** 2);
      if (umag > 0.1) {
        // Tangent perpendicular to momentum direction
        const tx = -surfaceVel[2] / umag;
        const tz = surfaceVel[0] / umag;
        const lateralSpread = (Math.random() - 0.5) * rupture * 1.5;
        this.vx[idx] += tx * lateralSpread;
        this.vz[idx] += tz * lateralSpread;
      }

      this.C.fill(0, idx * 9, idx * 9 + 9);
      this.mass[idx] = 1.0;
      this.density[idx] = REST_DENSITY;
      this.age[idx] = 0;
      this.alive[idx] = 1;
      this.count++;
    }
  }

  /**
   * One full MLS-MPM timestep: clear → P2G → grid update → G2P → advect → reabsorb → compact
   */
  step(dt: number, oceanHeightAt?: (x: number, z: number) => number) {
    if (this.count === 0) return;

    const clamped_dt = Math.min(dt, 0.006); // stability cap

    // ═══ Clear grid ═══
    this.gMass.fill(0);
    this.gVx.fill(0);
    this.gVy.fill(0);
    this.gVz.fill(0);

    // ═══ P2G Phase 1: scatter mass & momentum ═══
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue;

      const [gx, gy, gz] = this.w2g(this.px[i], this.py[i], this.pz[i]);
      const cx = Math.floor(gx), cy = Math.floor(gy), cz = Math.floor(gz);
      
      // Bounds check
      if (cx < 1 || cx >= GW - 2 || cy < 1 || cy >= GH - 2 || cz < 1 || cz >= GD - 2) {
        this.alive[i] = 0;
        continue;
      }
      
      const dx = gx - (cx + 0.5), dy = gy - (cy + 0.5), dz = gz - (cz + 0.5);

      // Quadratic B-spline weights
      const wx0 = 0.5 * (0.5 - dx) * (0.5 - dx), wx1 = 0.75 - dx * dx, wx2 = 0.5 * (0.5 + dx) * (0.5 + dx);
      const wy0 = 0.5 * (0.5 - dy) * (0.5 - dy), wy1 = 0.75 - dy * dy, wy2 = 0.5 * (0.5 + dy) * (0.5 + dy);
      const wz0 = 0.5 * (0.5 - dz) * (0.5 - dz), wz1 = 0.75 - dz * dz, wz2 = 0.5 * (0.5 + dz) * (0.5 + dz);
      const wxArr = [wx0, wx1, wx2], wyArr = [wy0, wy1, wy2], wzArr = [wz0, wz1, wz2];

      const Ci = i * 9;
      const mi = this.mass[i];

      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          for (let c = 0; c < 3; c++) {
            const w = wxArr[a] * wyArr[b] * wzArr[c];
            const ix = cx + a - 1, iy = cy + b - 1, iz = cz + c - 1;
            if (ix < 0 || ix >= GW || iy < 0 || iy >= GH || iz < 0 || iz >= GD) continue;

            const cdx = (ix + 0.5) - gx, cdy = (iy + 0.5) - gy, cdz = (iz + 0.5) - gz;

            // Q = C * cellDist (APIC affine velocity contribution)
            const qx = this.C[Ci] * cdx + this.C[Ci + 1] * cdy + this.C[Ci + 2] * cdz;
            const qy = this.C[Ci + 3] * cdx + this.C[Ci + 4] * cdy + this.C[Ci + 5] * cdz;
            const qz = this.C[Ci + 6] * cdx + this.C[Ci + 7] * cdy + this.C[Ci + 8] * cdz;

            const mc = w * mi;
            const g = this.gi(ix, iy, iz);
            this.gMass[g] += mc;
            this.gVx[g] += mc * (this.vx[i] + qx);
            this.gVy[g] += mc * (this.vy[i] + qy);
            this.gVz[g] += mc * (this.vz[i] + qz);
          }
        }
      }
    }

    // ═══ P2G Phase 2: density estimation + pressure/viscosity forces ═══
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue;

      const [gx, gy, gz] = this.w2g(this.px[i], this.py[i], this.pz[i]);
      const cx = Math.floor(gx), cy = Math.floor(gy), cz = Math.floor(gz);
      if (cx < 1 || cx >= GW - 2 || cy < 1 || cy >= GH - 2 || cz < 1 || cz >= GD - 2) continue;
      
      const dx = gx - (cx + 0.5), dy = gy - (cy + 0.5), dz = gz - (cz + 0.5);
      const wxArr = [0.5 * (0.5 - dx) * (0.5 - dx), 0.75 - dx * dx, 0.5 * (0.5 + dx) * (0.5 + dx)];
      const wyArr = [0.5 * (0.5 - dy) * (0.5 - dy), 0.75 - dy * dy, 0.5 * (0.5 + dy) * (0.5 + dy)];
      const wzArr = [0.5 * (0.5 - dz) * (0.5 - dz), 0.75 - dz * dz, 0.5 * (0.5 + dz) * (0.5 + dz)];

      // Gather density
      let dens = 0;
      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++)
          for (let c = 0; c < 3; c++) {
            const ix = cx + a - 1, iy = cy + b - 1, iz = cz + c - 1;
            if (ix < 0 || ix >= GW || iy < 0 || iy >= GH || iz < 0 || iz >= GD) continue;
            dens += this.gMass[this.gi(ix, iy, iz)] * wxArr[a] * wyArr[b] * wzArr[c];
          }
      this.density[i] = dens;

      // Pressure from equation of state
      const volume = 1.0 / Math.max(0.01, dens);
      const pressure = Math.max(0, STIFFNESS * (dens / REST_DENSITY - 1));

      // Stress tensor: -pI + μ(∇v + ∇vᵀ)
      const Ci = i * 9;
      const s00 = -pressure + VISCOSITY * 2 * this.C[Ci];
      const s11 = -pressure + VISCOSITY * 2 * this.C[Ci + 4];
      const s22 = -pressure + VISCOSITY * 2 * this.C[Ci + 8];
      const s01 = VISCOSITY * (this.C[Ci + 1] + this.C[Ci + 3]);
      const s02 = VISCOSITY * (this.C[Ci + 2] + this.C[Ci + 6]);
      const s12 = VISCOSITY * (this.C[Ci + 5] + this.C[Ci + 7]);

      const term = -volume * 4 * clamped_dt;

      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++)
          for (let c = 0; c < 3; c++) {
            const w = wxArr[a] * wyArr[b] * wzArr[c];
            const ix = cx + a - 1, iy = cy + b - 1, iz = cz + c - 1;
            if (ix < 0 || ix >= GW || iy < 0 || iy >= GH || iz < 0 || iz >= GD) continue;

            const cdx = (ix + 0.5) - gx, cdy = (iy + 0.5) - gy, cdz = (iz + 0.5) - gz;
            const g = this.gi(ix, iy, iz);
            this.gVx[g] += term * w * (s00 * cdx + s01 * cdy + s02 * cdz);
            this.gVy[g] += term * w * (s01 * cdx + s11 * cdy + s12 * cdz);
            this.gVz[g] += term * w * (s02 * cdx + s12 * cdy + s22 * cdz);
          }
    }

    // ═══ Grid update: normalize, gravity, boundaries ═══
    const total = GW * GH * GD;
    for (let g = 0; g < total; g++) {
      if (this.gMass[g] <= 0) continue;
      const invM = 1.0 / this.gMass[g];
      this.gVx[g] *= invM;
      this.gVy[g] *= invM;
      this.gVz[g] *= invM;
      this.gVy[g] += GRAVITY * clamped_dt;

      // Boundary enforcement (slip walls)
      const iz = g % GD;
      const iy = ((g / GD) | 0) % GH;
      const ix = ((g / (GD * GH)) | 0);
      if (ix < 3 || ix >= GW - 3) this.gVx[g] = 0;
      if (iy < 3) this.gVy[g] = Math.max(0, this.gVy[g]);
      if (iy >= GH - 3) this.gVy[g] = Math.min(0, this.gVy[g]);
      if (iz < 3 || iz >= GD - 3) this.gVz[g] = 0;
    }

    // ═══ G2P: gather velocity + APIC B matrix, advect ═══
    let bMinX = 1e9, bMinY = 1e9, bMinZ = 1e9;
    let bMaxX = -1e9, bMaxY = -1e9, bMaxZ = -1e9;

    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue;

      const [gx, gy, gz] = this.w2g(this.px[i], this.py[i], this.pz[i]);
      const cx = Math.floor(gx), cy = Math.floor(gy), cz = Math.floor(gz);
      if (cx < 1 || cx >= GW - 2 || cy < 1 || cy >= GH - 2 || cz < 1 || cz >= GD - 2) {
        this.alive[i] = 0;
        continue;
      }
      
      const dx = gx - (cx + 0.5), dy = gy - (cy + 0.5), dz = gz - (cz + 0.5);
      const wxArr = [0.5 * (0.5 - dx) * (0.5 - dx), 0.75 - dx * dx, 0.5 * (0.5 + dx) * (0.5 + dx)];
      const wyArr = [0.5 * (0.5 - dy) * (0.5 - dy), 0.75 - dy * dy, 0.5 * (0.5 + dy) * (0.5 + dy)];
      const wzArr = [0.5 * (0.5 - dz) * (0.5 - dz), 0.75 - dz * dz, 0.5 * (0.5 + dz) * (0.5 + dz)];

      let nvx = 0, nvy = 0, nvz = 0;
      const Ci = i * 9;
      this.C.fill(0, Ci, Ci + 9);

      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++)
          for (let c = 0; c < 3; c++) {
            const w = wxArr[a] * wyArr[b] * wzArr[c];
            const ix = cx + a - 1, iy = cy + b - 1, iz = cz + c - 1;
            if (ix < 0 || ix >= GW || iy < 0 || iy >= GH || iz < 0 || iz >= GD) continue;

            const g = this.gi(ix, iy, iz);
            const gvx = this.gVx[g], gvy = this.gVy[g], gvz = this.gVz[g];
            nvx += w * gvx; nvy += w * gvy; nvz += w * gvz;

            // APIC B matrix: B = Σ w_ip * v_i * (x_i - x_p)^T
            const cdx = (ix + 0.5) - gx, cdy = (iy + 0.5) - gy, cdz = (iz + 0.5) - gz;
            const w4 = 4 * w;
            this.C[Ci]     += w4 * gvx * cdx;
            this.C[Ci + 1] += w4 * gvx * cdy;
            this.C[Ci + 2] += w4 * gvx * cdz;
            this.C[Ci + 3] += w4 * gvy * cdx;
            this.C[Ci + 4] += w4 * gvy * cdy;
            this.C[Ci + 5] += w4 * gvy * cdz;
            this.C[Ci + 6] += w4 * gvz * cdx;
            this.C[Ci + 7] += w4 * gvz * cdy;
            this.C[Ci + 8] += w4 * gvz * cdz;
          }

      this.vx[i] = nvx;
      this.vy[i] = nvy;
      this.vz[i] = nvz;

      // Advect
      this.px[i] += nvx * clamped_dt;
      this.py[i] += nvy * clamped_dt;
      this.pz[i] += nvz * clamped_dt;

      // Age
      this.age[i] += clamped_dt;

      // Reabsorption: kill particles that fall below ocean surface or are too old
      let kill = this.age[i] > MAX_AGE;

      // Reabsorption into ocean surface — only after particle has had time to arc
      if (oceanHeightAt && this.age[i] > 0.4) {
        const surfH = oceanHeightAt(this.px[i], this.pz[i]);
        // Kill if below surface AND moving downward (re-entering the ocean)
        if (this.py[i] < surfH - 0.1 && this.vy[i] < 0) {
          kill = true;
        }
      }

      if (kill) {
        this.alive[i] = 0;
      } else {
        if (this.px[i] < bMinX) bMinX = this.px[i];
        if (this.py[i] < bMinY) bMinY = this.py[i];
        if (this.pz[i] < bMinZ) bMinZ = this.pz[i];
        if (this.px[i] > bMaxX) bMaxX = this.px[i];
        if (this.py[i] > bMaxY) bMaxY = this.py[i];
        if (this.pz[i] > bMaxZ) bMaxZ = this.pz[i];
      }
    }

    this.boundsMin = [bMinX, bMinY, bMinZ];
    this.boundsMax = [bMaxX, bMaxY, bMaxZ];

    this.compact();
  }

  private compact() {
    let w = 0;
    for (let r = 0; r < this.count; r++) {
      if (!this.alive[r]) continue;
      if (w !== r) {
        this.px[w] = this.px[r]; this.py[w] = this.py[r]; this.pz[w] = this.pz[r];
        this.vx[w] = this.vx[r]; this.vy[w] = this.vy[r]; this.vz[w] = this.vz[r];
        this.C.copyWithin(w * 9, r * 9, r * 9 + 9);
        this.mass[w] = this.mass[r];
        this.density[w] = this.density[r];
        this.age[w] = this.age[r];
        this.alive[w] = 1;
      }
      w++;
    }
    this.count = w;
  }

  /**
   * Build Float32Array for DataTexture upload to shader.
   * Layout: width=MAX_PARTICLES, height=3, RGBA
   *   Row 0: (pos.x, pos.y, pos.z, radius)
   *   Row 1: (vel.x, vel.y, vel.z, density)
   *   Row 2: (age, regime, coherence, 0)
   */
  buildTexData(out?: Float32Array): Float32Array {
    const size = MAX_PARTICLES * 3 * 4;
    const data = out || new Float32Array(size);
    data.fill(0);

    for (let i = 0; i < this.count; i++) {
      // Row 0
      const r0 = i * 4;
      data[r0] = this.px[i];
      data[r0 + 1] = this.py[i];
      data[r0 + 2] = this.pz[i];
      const densRatio = this.density[i] / REST_DENSITY;
      data[r0 + 3] = 0.2 + 0.35 * Math.min(1.0, densRatio);

      // Row 1
      const r1 = MAX_PARTICLES * 4 + i * 4;
      data[r1] = this.vx[i];
      data[r1 + 1] = this.vy[i];
      data[r1 + 2] = this.vz[i];
      data[r1 + 3] = this.density[i];

      // Row 2: regime classification
      const r2 = MAX_PARTICLES * 4 * 2 + i * 4;
      data[r2] = this.age[i];
      const regime = densRatio > 0.7 ? 0.0 : densRatio > 0.25 ? 1.0 : 2.0;
      data[r2 + 1] = regime;
      data[r2 + 2] = Math.max(0, Math.min(1, densRatio * (1 - this.age[i] / MAX_AGE)));
      data[r2 + 3] = 0;
    }

    return data;
  }
}
