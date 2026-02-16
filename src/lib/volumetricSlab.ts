/**
 * VolumetricSlab — A 3D extrusion of perpendicular energy from a face.
 * 
 * Each face of the cube extrudes its 2D vorticity/velocity into a shallow
 * 3D slab (N × N × D) where D is the extrusion depth. The slab stores
 * the perpendicular velocity component that extends into the cube interior.
 * 
 * Where slabs from different faces overlap, their vorticity components
 * interact via cross-coupling — this is the "hypergraph" structure.
 * 
 * Architecture:
 *   - Each slab has dimensions [N × N × D] 
 *   - Stores: velocity (perpendicular component), vorticity magnitude, pressure
 *   - Advection uses semi-Lagrangian with the 2D face velocity + perpendicular decay
 *   - Diffusion via Gauss-Seidel relaxation in 3D
 */

const SLAB_DEPTH = 16; // Number of layers in each extrusion slab

export class VolumetricSlab {
  readonly N: number;
  readonly D: number;
  readonly slabSize: number;

  // Primary fields — perpendicular velocity extruded into volume
  perpV: Float32Array;      // Perpendicular velocity magnitude
  perpVPrev: Float32Array;
  vorticity: Float32Array;  // Local vorticity magnitude  
  pressure: Float32Array;   // Pressure field (for upwelling feedback)

  // Scratch buffers
  private scratch: Float32Array;

  constructor(N: number, D: number = SLAB_DEPTH) {
    this.N = N;
    this.D = D;
    this.slabSize = N * N * D;

    this.perpV = new Float32Array(this.slabSize);
    this.perpVPrev = new Float32Array(this.slabSize);
    this.vorticity = new Float32Array(this.slabSize);
    this.pressure = new Float32Array(this.slabSize);
    this.scratch = new Float32Array(this.slabSize);
  }

  /** 3D index into slab: (i, j) is face-local, k is depth (0 = surface, D-1 = deepest) */
  IX(i: number, j: number, k: number): number {
    return i + j * this.N + k * this.N * this.N;
  }

  /**
   * Inject surface energy from a 2D face solver into the slab surface layer.
   * Takes the 2D velocity field and vorticity and writes them to k=0.
   */
  injectSurface(
    velocityField: Float32Array, // N*N perpendicular velocity magnitudes
    vorticityField: Float32Array  // N*N vorticity magnitudes
  ) {
    const NN = this.N * this.N;
    for (let idx = 0; idx < NN; idx++) {
      this.perpV[idx] = velocityField[idx]; // k=0 layer
      this.vorticity[idx] = vorticityField[idx];
    }
  }

  /**
   * Step the volumetric slab forward in time.
   * 1. Diffuse perpendicular velocity into depth
   * 2. Advect vorticity along the perpendicular direction
   * 3. Apply exponential decay with physically-motivated profile
   * 4. Build pressure field from vorticity convergence
   */
  step(dt: number, viscosity: number = 0.02) {
    const { N, D, perpV, vorticity, pressure } = this;

    // ─── 1. Diffuse perpendicular velocity into depth (anisotropic) ───
    // Lateral diffusion is slow, depth diffusion is fast (simulating pressure waves)
    const aLateral = dt * viscosity * N * 0.5;
    const aDepth = dt * viscosity * N * 4.0; // Much faster in depth direction
    
    this.scratch.set(perpV);

    for (let iter = 0; iter < 3; iter++) {
      for (let k = 0; k < D; k++) {
        for (let j = 1; j < N - 1; j++) {
          for (let i = 1; i < N - 1; i++) {
            const idx = this.IX(i, j, k);
            const src = this.scratch[idx];

            // Lateral neighbors
            const lateral = 
              perpV[this.IX(i - 1, j, k)] + perpV[this.IX(i + 1, j, k)] +
              perpV[this.IX(i, j - 1, k)] + perpV[this.IX(i, j + 1, k)];
            
            // Depth neighbors (clamped at boundaries)
            const above = k > 0 ? perpV[this.IX(i, j, k - 1)] : src;
            const below = k < D - 1 ? perpV[this.IX(i, j, k + 1)] : src * 0.5; // Open bottom absorbs

            perpV[idx] = (src + aLateral * lateral + aDepth * (above + below)) / 
                         (1 + 4 * aLateral + 2 * aDepth);
          }
        }
      }
    }

    // ─── 2. Advect vorticity downward (gravity-driven transport) ───
    // Vorticity is carried downward by the perpendicular flow
    this.scratch.set(vorticity);
    
    for (let k = D - 1; k >= 1; k--) {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = this.IX(i, j, k);
          // Semi-Lagrangian: trace back along perpendicular velocity
          const vel = Math.abs(perpV[idx]) * 0.3; // Scaled transport speed
          const srcK = Math.max(0, k - vel * dt * D);
          const k0 = Math.floor(srcK);
          const k1 = Math.min(D - 1, k0 + 1);
          const frac = srcK - k0;
          
          vorticity[idx] = (1 - frac) * this.scratch[this.IX(i, j, k0)] +
                           frac * this.scratch[this.IX(i, j, k1)];
        }
      }
    }

    // ─── 3. Physical decay profile ───
    // Real vortices in water decay roughly as exp(-z/L) where L depends on 
    // the vortex strength and Reynolds number. We use a combined profile:
    // fast exponential near surface + slower algebraic tail at depth.
    for (let k = 1; k < D; k++) {
      const depthFrac = k / D;
      // Combined decay: exponential envelope × (1 + algebraic tail)
      const expDecay = Math.exp(-3.0 * depthFrac);
      const algTail = 1.0 / (1.0 + 8.0 * depthFrac * depthFrac);
      const decay = 0.7 * expDecay + 0.3 * algTail;
      
      const kOffset = k * N * N;
      for (let idx = 0; idx < N * N; idx++) {
        vorticity[kOffset + idx] *= (0.993 + 0.005 * decay); // Per-step damping
        perpV[kOffset + idx] *= (0.990 + 0.008 * decay);
      }
    }

    // ─── 4. Build pressure field from vorticity convergence ───
    // Pressure = integral of vorticity from bottom to top (hydrostatic-like)
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let pAccum = 0;
        for (let k = D - 1; k >= 0; k--) {
          pAccum += vorticity[this.IX(i, j, k)] * 0.15;
          pressure[this.IX(i, j, k)] = pAccum;
        }
      }
    }
  }

  /**
   * Get the pressure at the surface (k=0) — this feeds back to the 2D solver
   * as "upwelling" force from the interior volume.
   */
  getSurfacePressure(i: number, j: number): number {
    return this.pressure[this.IX(i, j, 0)];
  }

  /**
   * Sample the slab at a given face position and depth for rendering.
   * Returns [vorticity, perpV, pressure] at that point.
   */
  sample(i: number, j: number, k: number): [number, number, number] {
    const idx = this.IX(
      Math.max(0, Math.min(this.N - 1, i)),
      Math.max(0, Math.min(this.N - 1, j)),
      Math.max(0, Math.min(this.D - 1, k))
    );
    return [this.vorticity[idx], this.perpV[idx], this.pressure[idx]];
  }

  /**
   * Read an entire depth column at face position (i, j).
   * Returns array of D values [vorticity at each depth].
   */
  getColumn(i: number, j: number): Float32Array {
    const col = new Float32Array(this.D);
    const ci = Math.max(0, Math.min(this.N - 1, i));
    const cj = Math.max(0, Math.min(this.N - 1, j));
    for (let k = 0; k < this.D; k++) {
      col[k] = this.vorticity[this.IX(ci, cj, k)];
    }
    return col;
  }
}

/**
 * SlabCoupler — Manages interaction between overlapping volumetric slabs.
 * 
 * Where two slabs from perpendicular faces overlap in 3D space, their
 * vorticity components interact. This is the "hypergraph" coupling that
 * produces true 3D rotational dynamics from surface-driven slabs.
 */
export class SlabCoupler {
  readonly N: number;
  readonly D: number;

  constructor(N: number, D: number = SLAB_DEPTH) {
    this.N = N;
    this.D = D;
  }

  /**
   * Couple two perpendicular slabs at their intersection line.
   * 
   * For example, the +X slab and +Z slab intersect along a line
   * parallel to Y. At each point on this line, we transfer vorticity
   * between the two slabs using the perpendicular velocity rule:
   *   v_perp_A = -v_perp_B (with mixing coefficient)
   * 
   * @param slabA - First slab (e.g., from +X face)
   * @param slabB - Second slab (e.g., from +Z face) 
   * @param axisA - Which axis of slabA aligns with the intersection (0=i, 1=j)
   * @param axisB - Which axis of slabB aligns with the intersection (0=i, 1=j)
   * @param posA - Position along slabA's depth axis where intersection occurs
   * @param posB - Position along slabB's depth axis where intersection occurs
   * @param mixRate - Coupling strength (0-1)
   */
  coupleSlabs(
    slabA: VolumetricSlab,
    slabB: VolumetricSlab,
    mixRate: number = 0.15
  ) {
    const { N, D } = this;
    
    // Couple at each depth layer where slabs overlap
    // The overlap region is a D × D square in the interior
    for (let kA = 0; kA < D; kA++) {
      // slabA's depth kA maps to slabB's face coordinate
      const jB = Math.floor((kA / D) * N);
      
      for (let kB = 0; kB < D; kB++) {
        // slabB's depth kB maps to slabA's face coordinate  
        const jA = Math.floor((kB / D) * N);
        
        // Along the shared edge line
        for (let t = 0; t < N; t++) {
          const idxA = slabA.IX(t, jA, kA);
          const idxB = slabB.IX(t, jB, kB);
          
          // Perpendicular velocity transfer with sign flip
          const perpA = slabA.perpV[idxA];
          const perpB = slabB.perpV[idxB];
          
          slabA.perpV[idxA] += mixRate * (-perpB - perpA);
          slabB.perpV[idxB] += mixRate * (-perpA - perpB);
          
          // Vorticity exchange (conservative)
          const vortA = slabA.vorticity[idxA];
          const vortB = slabB.vorticity[idxB];
          const avgVort = (vortA + vortB) * 0.5;
          
          slabA.vorticity[idxA] += mixRate * (avgVort - vortA) * 0.5;
          slabB.vorticity[idxB] += mixRate * (avgVort - vortB) * 0.5;
        }
      }
    }
  }
}

export { SLAB_DEPTH };
