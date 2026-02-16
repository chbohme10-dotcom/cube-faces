/**
 * CubeFaceSolver — Full 6-face independent fluid simulation with edge coupling.
 *
 * Each face of the cube runs its own 2D Navier–Stokes solver (Stam stable fluids).
 * At the 12 shared edges, the perpendicular velocity transfer rule routes
 * vorticity around corners, producing full 3D vorticity transport:
 *
 *   v_perp_A = −v_perp_B   (sign flip routes flow into the cube interior)
 *   v_tang   = average(v_tang_A, v_tang_B)
 *
 * Face indices match Three.js BoxGeometry material slots:
 *   0: +X (right)   1: −X (left)
 *   2: +Y (top)     3: −Y (bottom)
 *   4: +Z (front)   5: −Z (back)
 *
 * Local coordinates per face:
 *   Side faces (0,1,4,5): i = horizontal, j = vertical (y-axis)
 *   Top/Bottom (2,3):     i = x-axis,    j = z-axis
 */

import { FluidSolver } from "./fluidSolver";

// ─── Edge side constants ───
const RIGHT  = 0; // i = N boundary
const LEFT   = 1; // i = 1 boundary
const TOP    = 2; // j = N boundary
const BOTTOM = 3; // j = 1 boundary

/**
 * Edge table: [faceA, sideA, faceB, sideB, flipIndex]
 *
 * 12 edges of the cube. flipIndex=true means the parametric index
 * runs in opposite directions on the two faces.
 */
const EDGE_TABLE: [number, number, number, number, boolean][] = [
  // ─── Top face (2, +Y) connects to 4 side faces at their top edges ───
  [2, RIGHT,  0, TOP,    false], // top→right  edge along z at (x=N, y=N)
  [2, LEFT,   1, TOP,    false], // top→left   edge along z at (x=0, y=N)
  [2, TOP,    4, TOP,    false], // top→front  edge along x at (z=N, y=N)
  [2, BOTTOM, 5, TOP,    false], // top→back   edge along x at (z=0, y=N)

  // ─── Bottom face (3, −Y) connects to 4 side faces at their bottom edges ───
  [3, RIGHT,  0, BOTTOM, false], // bottom→right
  [3, LEFT,   1, BOTTOM, false], // bottom→left
  [3, TOP,    4, BOTTOM, false], // bottom→front
  [3, BOTTOM, 5, BOTTOM, false], // bottom→back

  // ─── Vertical edges: side face ↔ side face ───
  [0, RIGHT,  4, RIGHT,  false], // +X right  ↔ +Z right  (corner x=N,z=N along y)
  [4, LEFT,   1, RIGHT,  false], // +Z left   ↔ −X right  (corner x=0,z=N along y)
  [1, LEFT,   5, RIGHT,  false], // −X left   ↔ −Z right  (corner x=0,z=0 along y)
  [5, LEFT,   0, LEFT,   false], // −Z left   ↔ +X left   (corner x=N,z=0 along y)
];

/**
 * Read the perpendicular and tangential velocity at a face's edge.
 *
 * Perpendicular = component normal to the edge, pointing outward from face center.
 * Tangential    = component parallel to the edge.
 */
function readEdge(
  solver: FluidSolver,
  side: number,
  t: number
): [number, number] {
  const N = solver.N;
  switch (side) {
    case RIGHT: // i=N, outward perp = +Vx
      return [solver.getVxAt(N, t), solver.getVyAt(N, t)];
    case LEFT:  // i=1, outward perp = −Vx
      return [-solver.getVxAt(1, t), solver.getVyAt(1, t)];
    case TOP:   // j=N, outward perp = +Vy
      return [solver.getVyAt(t, N), solver.getVxAt(t, N)];
    case BOTTOM: // j=1, outward perp = −Vy
      return [-solver.getVyAt(t, 1), solver.getVxAt(t, 1)];
    default:
      return [0, 0];
  }
}

/**
 * Write coupled velocity back into a face's interior edge cells.
 *
 * We blend into the first interior row/column rather than the boundary cells,
 * so the solver's own setBnd doesn't clobber our coupling.
 *
 * @param perpIn  - perpendicular velocity pointing INTO the face (positive = inward)
 * @param tang    - tangential velocity along the edge
 * @param blend   - blend rate (0–1)
 */
function writeEdge(
  solver: FluidSolver,
  side: number,
  t: number,
  perpIn: number,
  tang: number,
  blend: number
) {
  const N = solver.N;
  switch (side) {
    case RIGHT: { // i=N, inward = −Vx direction, so Vx = −perpIn
      const idx = ix(solver, N, t);
      solver.Vx[idx] += blend * (-perpIn - solver.Vx[idx]);
      solver.Vy[idx] += blend * (tang - solver.Vy[idx]);
      break;
    }
    case LEFT: { // i=1, inward = +Vx direction, so Vx = +perpIn
      const idx = ix(solver, 1, t);
      solver.Vx[idx] += blend * (perpIn - solver.Vx[idx]);
      solver.Vy[idx] += blend * (tang - solver.Vy[idx]);
      break;
    }
    case TOP: { // j=N, inward = −Vy direction, so Vy = −perpIn
      const idx = ix(solver, t, N);
      solver.Vy[idx] += blend * (-perpIn - solver.Vy[idx]);
      solver.Vx[idx] += blend * (tang - solver.Vx[idx]);
      break;
    }
    case BOTTOM: { // j=1, inward = +Vy direction, so Vy = +perpIn
      const idx = ix(solver, t, 1);
      solver.Vy[idx] += blend * (perpIn - solver.Vy[idx]);
      solver.Vx[idx] += blend * (tang - solver.Vx[idx]);
      break;
    }
  }
}

/** Helper: compute flat index for a solver */
function ix(solver: FluidSolver, i: number, j: number): number {
  return i + j * (solver.N + 2);
}

// ─── Main class ───

export class CubeFaceSolver {
  readonly N: number;
  readonly faces: FluidSolver[];

  // Coupling parameters
  edgeBlend: number = 0.25;      // How strongly edges couple (0–1)
  cornerIterations: number = 2;  // Jacobi iterations for corner consistency

  constructor(N: number) {
    this.N = N;
    this.faces = Array.from({ length: 6 }, () => new FluidSolver(N));
  }

  /** Step all 6 faces, then apply edge + corner coupling. */
  step(dt: number, diffusion: number, viscosity: number) {
    // 1. Step all 6 independent solvers
    for (let f = 0; f < 6; f++) {
      this.faces[f].step(dt, diffusion, viscosity);
    }

    // 2. Apply gravitational bias on side faces (gentle downward flow)
    const gravityStrength = 8.0 * dt;
    for (const fi of [0, 1, 4, 5]) {
      const s = this.faces[fi];
      const N = this.N;
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          // Gravity pulls density downward (−j direction)
          const d = s.getDensityAt(i, j);
          if (d > 0.01) {
            s.Vy[ix(s, i, j)] -= gravityStrength * Math.min(d, 5);
          }
        }
      }
    }

    // 3. Edge coupling pass
    this.coupleEdges();

    // 4. Corner consistency
    this.coupleCorners();

    // 5. Also transfer density across edges (mass transport)
    this.coupleDensity();
  }

  /** Apply perpendicular velocity transfer at all 12 edges. */
  private coupleEdges() {
    const N = this.N;
    const blend = this.edgeBlend;

    for (const [fA, sA, fB, sB, flip] of EDGE_TABLE) {
      const solverA = this.faces[fA];
      const solverB = this.faces[fB];

      for (let t = 1; t <= N; t++) {
        const tB = flip ? (N + 1 - t) : t;

        // Read outward perpendicular + tangential from each face
        const [perpOutA, tangA] = readEdge(solverA, sA, t);
        const [perpOutB, tangB] = readEdge(solverB, sB, tB);

        // Core rule: v_perp_A_out = −v_perp_B_out
        // So the inward flow on A = outward flow on B, and vice versa
        const perpInA = perpOutB;  // What flows out of B flows into A
        const perpInB = perpOutA;  // What flows out of A flows into B
        const avgTang = (tangA + tangB) * 0.5;

        // Write coupled values back (blended into interior edge cells)
        writeEdge(solverA, sA, t, perpInA, avgTang, blend);
        writeEdge(solverB, sB, tB, perpInB, avgTang, blend);
      }
    }
  }

  /**
   * Corner consistency: 8 cube corners, each shared by 3 faces.
   * Run Jacobi iterations to make the three perpendicular components consistent.
   */
  private coupleCorners() {
    const N = this.N;

    // 8 corners: [face1, i1, j1, face2, i2, j2, face3, i3, j3]
    const corners: [number, number, number, number, number, number, number, number, number][] = [
      // Top-front-right:  +Y(2) at (N,N), +X(0) at (N,N), +Z(4) at (N,N)
      [2, N, N,  0, N, N,  4, N, N],
      // Top-front-left:   +Y(2) at (1,N), -X(1) at (N,N), +Z(4) at (1,N)
      [2, 1, N,  1, N, N,  4, 1, N],
      // Top-back-right:   +Y(2) at (N,1), +X(0) at (1,N), -Z(5) at (N,N)
      [2, N, 1,  0, 1, N,  5, N, N],
      // Top-back-left:    +Y(2) at (1,1), -X(1) at (1,N), -Z(5) at (1,N)
      [2, 1, 1,  1, 1, N,  5, 1, N],
      // Bottom-front-right: -Y(3) at (N,N), +X(0) at (N,1), +Z(4) at (N,1)
      [3, N, N,  0, N, 1,  4, N, 1],
      // Bottom-front-left:  -Y(3) at (1,N), -X(1) at (N,1), +Z(4) at (1,1)
      [3, 1, N,  1, N, 1,  4, 1, 1],
      // Bottom-back-right:  -Y(3) at (N,1), +X(0) at (1,1), -Z(5) at (N,1)
      [3, N, 1,  0, 1, 1,  5, N, 1],
      // Bottom-back-left:   -Y(3) at (1,1), -X(1) at (1,1), -Z(5) at (1,1)
      [3, 1, 1,  1, 1, 1,  5, 1, 1],
    ];

    for (let iter = 0; iter < this.cornerIterations; iter++) {
      for (const [f1, i1, j1, f2, i2, j2, f3, i3, j3] of corners) {
        const s1 = this.faces[f1], s2 = this.faces[f2], s3 = this.faces[f3];

        // Average velocity magnitudes at corners across all three faces
        const vx1 = s1.getVxAt(i1, j1), vy1 = s1.getVyAt(i1, j1);
        const vx2 = s2.getVxAt(i2, j2), vy2 = s2.getVyAt(i2, j2);
        const vx3 = s3.getVxAt(i3, j3), vy3 = s3.getVyAt(i3, j3);

        // Simple averaging for consistency
        const avgMag = (Math.sqrt(vx1*vx1+vy1*vy1) + Math.sqrt(vx2*vx2+vy2*vy2) + Math.sqrt(vx3*vx3+vy3*vy3)) / 3;
        const scale = 0.15; // Gentle correction

        // Dampen corner velocities toward the average magnitude
        for (const [s, ci, cj] of [[s1,i1,j1],[s2,i2,j2],[s3,i3,j3]] as const) {
          const cvx = s.getVxAt(ci, cj), cvy = s.getVyAt(ci, cj);
          const mag = Math.sqrt(cvx*cvx + cvy*cvy);
          if (mag > 0.001) {
            const correction = 1 + scale * (avgMag / mag - 1);
            s.Vx[ix(s, ci, cj)] *= correction;
            s.Vy[ix(s, ci, cj)] *= correction;
          }
        }
      }
    }
  }

  /**
   * Transfer density across edges — mass transport between faces.
   * When fluid flows through an edge (perpendicular velocity > 0),
   * it carries density with it.
   */
  private coupleDensity() {
    const N = this.N;
    const transportRate = 0.15;

    for (const [fA, sA, fB, sB, flip] of EDGE_TABLE) {
      const solverA = this.faces[fA];
      const solverB = this.faces[fB];

      for (let t = 1; t <= N; t++) {
        const tB = flip ? (N + 1 - t) : t;

        // Read perpendicular flow at edge
        const [perpOutA] = readEdge(solverA, sA, t);
        const [perpOutB] = readEdge(solverB, sB, tB);

        // Get density at edge cells
        let iA: number, jA: number, iB: number, jB: number;
        switch (sA) {
          case RIGHT:  iA = N; jA = t; break;
          case LEFT:   iA = 1; jA = t; break;
          case TOP:    iA = t; jA = N; break;
          case BOTTOM: iA = t; jA = 1; break;
          default: iA = 1; jA = 1;
        }
        switch (sB) {
          case RIGHT:  iB = N; jB = tB; break;
          case LEFT:   iB = 1; jB = tB; break;
          case TOP:    iB = tB; jB = N; break;
          case BOTTOM: iB = tB; jB = 1; break;
          default: iB = 1; jB = 1;
        }

        const dA = solverA.getDensityAt(iA, jA);
        const dB = solverB.getDensityAt(iB, jB);

        // Flow carries density: if perpOut > 0, density moves from A to B
        if (perpOutA > 0.1 && dA > 0.01) {
          const transfer = Math.min(dA * 0.5, perpOutA * dA * transportRate);
          solverA.addDensity(iA, jA, -transfer);
          solverB.addDensity(iB, jB, transfer);
        }
        if (perpOutB > 0.1 && dB > 0.01) {
          const transfer = Math.min(dB * 0.5, perpOutB * dB * transportRate);
          solverB.addDensity(iB, jB, -transfer);
          solverA.addDensity(iA, jA, transfer);
        }
      }
    }
  }

  // ─── Convenience accessors ───

  getFace(index: number): FluidSolver {
    return this.faces[index];
  }

  /** Add velocity to a specific face */
  addVelocity(face: number, x: number, y: number, vx: number, vy: number) {
    this.faces[face].addVelocity(x, y, vx, vy);
  }

  /** Add density to a specific face */
  addDensity(face: number, x: number, y: number, amount: number) {
    this.faces[face].addDensity(x, y, amount);
  }

  /** Inject a vortex on a specific face */
  addVortex(face: number, cx: number, cy: number, radius: number, strength: number) {
    const N = this.N;
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0.5 && dist <= radius) {
          const xi = cx + dx, yi = cy + dy;
          if (xi >= 1 && xi <= N && yi >= 1 && yi <= N) {
            const falloff = 1 - dist / radius;
            this.faces[face].addVelocity(xi, yi,
              -dy / dist * strength * falloff,
               dx / dist * strength * falloff
            );
            this.faces[face].addDensity(xi, yi, strength * falloff * 0.4);
          }
        }
      }
    }
  }
}
