/**
 * MLS-MPM 3D Fluid Solver — CPU Implementation
 * 
 * Full Moving Least Squares Material Point Method with:
 * - Quadratic B-spline weight functions
 * - APIC (Affine Particle-In-Cell) velocity transfers
 * - Equation-of-state pressure model
 * - Viscosity via strain rate tensor
 * - Gravity and boundary enforcement
 * - Particle spawning, aging, reabsorption, compaction
 * - Density-based regime classification (sheet/filament/droplet)
 *
 * Reference: Hu et al. "A Moving Least Squares Material Point Method" (2018)
 */

// Grid dimensions (cells)
const GW = 48, GH = 40, GD = 48;
const CELL_SIZE = 0.5; // world units per cell
const INV_CELL = 1.0 / CELL_SIZE;

// Domain origin in world space (grid cell 0,0,0 maps here)
const ORIGIN_X = -12, ORIGIN_Y = -6, ORIGIN_Z = -12;

// Solver constants
const MAX_PARTICLES = 512;
const GRAVITY = -14.0;
const REST_DENSITY = 4.0;
const STIFFNESS = 40.0;
const VISCOSITY = 0.15;
const MAX_AGE = 8.0;

// Regime thresholds (density-based)
const SHEET_DENSITY = REST_DENSITY * 0.7;
const FILAMENT_DENSITY = REST_DENSITY * 0.25;

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
   * Spawn particles at a world position with initial velocity.
   * Creates a cone of particles above the surface for organic splash shape.
   */
  spawn(
    wx: number, wz: number,
    surfaceH: number,
    count: number,
    baseVel: [number, number, number],
    amplitude = 2.5,
  ) {
    for (let i = 0; i < count && this.count < MAX_PARTICLES; i++) {
      const idx = this.count;
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * amplitude * 0.6;
      const upJitter = Math.random();

      this.px[idx] = wx + Math.cos(angle) * r;
      this.py[idx] = surfaceH + upJitter * 0.3;
      this.pz[idx] = wz + Math.sin(angle) * r;

      // Initial velocity: upward thrust + outward spread + inherited surface momentum
      const outSpeed = (1.5 + Math.random() * 3.0) * amplitude;
      const upSpeed = (4.0 + Math.random() * 6.0) * amplitude;

      this.vx[idx] = baseVel[0] + Math.cos(angle) * outSpeed;
      this.vy[idx] = upSpeed;
      this.vz[idx] = baseVel[2] + Math.sin(angle) * outSpeed;

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

    const clamped_dt = Math.min(dt, 0.008); // stability cap

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
      if (ix < 2 || ix >= GW - 2) this.gVx[g] = 0;
      if (iy < 2) this.gVy[g] = Math.max(0, this.gVy[g]);
      if (iy >= GH - 2) this.gVy[g] = Math.min(0, this.gVy[g]);
      if (iz < 2 || iz >= GD - 2) this.gVz[g] = 0;
    }

    // ═══ G2P: gather velocity + APIC B matrix, advect ═══
    let bMinX = 1e9, bMinY = 1e9, bMinZ = 1e9;
    let bMaxX = -1e9, bMaxY = -1e9, bMaxZ = -1e9;

    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue;

      const [gx, gy, gz] = this.w2g(this.px[i], this.py[i], this.pz[i]);
      const cx = Math.floor(gx), cy = Math.floor(gy), cz = Math.floor(gz);
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
            const w4 = 4 * w; // Scale factor for B→C conversion
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
      
      // Out of domain check
      const [pgx, pgy, pgz] = this.w2g(this.px[i], this.py[i], this.pz[i]);
      if (pgx < 1 || pgx >= GW - 1 || pgy < 1 || pgy >= GH - 1 || pgz < 1 || pgz >= GD - 1) {
        kill = true;
      }

      // Reabsorption into ocean surface
      if (oceanHeightAt && this.age[i] > 0.3) {
        const surfH = oceanHeightAt(this.px[i], this.pz[i]);
        if (this.py[i] < surfH - 0.3) {
          kill = true; // Reabsorbed into ocean
        }
      }

      if (kill) {
        this.alive[i] = 0;
      } else {
        // Update bounds
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

    // Compact dead particles
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
      // Radius varies with density: dense = larger (sheet), sparse = smaller (droplet)
      const densRatio = this.density[i] / REST_DENSITY;
      data[r0 + 3] = 0.25 + 0.3 * Math.min(1.0, densRatio);

      // Row 1
      const r1 = MAX_PARTICLES * 4 + i * 4;
      data[r1] = this.vx[i];
      data[r1 + 1] = this.vy[i];
      data[r1 + 2] = this.vz[i];
      data[r1 + 3] = this.density[i];

      // Row 2: regime classification
      const r2 = MAX_PARTICLES * 4 * 2 + i * 4;
      data[r2] = this.age[i];
      // Regime: 0=sheet (dense), 1=filament (medium), 2=droplet (sparse)
      const regime = densRatio > 0.7 ? 0.0 : densRatio > 0.25 ? 1.0 : 2.0;
      data[r2 + 1] = regime;
      // Coherence: based on density and age
      data[r2 + 2] = Math.max(0, Math.min(1, densRatio * (1 - this.age[i] / MAX_AGE)));
      data[r2 + 3] = 0;
    }

    return data;
  }
}
