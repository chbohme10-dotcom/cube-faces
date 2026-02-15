export class FluidSolver {
  N: number;
  size: number;
  density: Float32Array;
  density0: Float32Array;
  Vx: Float32Array;
  Vy: Float32Array;
  Vx0: Float32Array;
  Vy0: Float32Array;

  constructor(N: number) {
    this.N = N;
    this.size = (N + 2) * (N + 2);
    this.density = new Float32Array(this.size);
    this.density0 = new Float32Array(this.size);
    this.Vx = new Float32Array(this.size);
    this.Vy = new Float32Array(this.size);
    this.Vx0 = new Float32Array(this.size);
    this.Vy0 = new Float32Array(this.size);
  }

  private IX(i: number, j: number): number {
    return i + j * (this.N + 2);
  }

  addDensity(x: number, y: number, amount: number) {
    if (x < 1 || x > this.N || y < 1 || y > this.N) return;
    this.density[this.IX(x, y)] += amount;
  }

  addVelocity(x: number, y: number, ax: number, ay: number) {
    if (x < 1 || x > this.N || y < 1 || y > this.N) return;
    const idx = this.IX(x, y);
    this.Vx[idx] += ax;
    this.Vy[idx] += ay;
  }

  private setBnd(b: number, x: Float32Array) {
    const N = this.N;
    for (let i = 1; i <= N; i++) {
      x[this.IX(0, i)] = b === 1 ? -x[this.IX(1, i)] : x[this.IX(1, i)];
      x[this.IX(N + 1, i)] = b === 1 ? -x[this.IX(N, i)] : x[this.IX(N, i)];
      x[this.IX(i, 0)] = b === 2 ? -x[this.IX(i, 1)] : x[this.IX(i, 1)];
      x[this.IX(i, N + 1)] = b === 2 ? -x[this.IX(i, N)] : x[this.IX(i, N)];
    }
    x[this.IX(0, 0)] = 0.5 * (x[this.IX(1, 0)] + x[this.IX(0, 1)]);
    x[this.IX(0, N + 1)] = 0.5 * (x[this.IX(1, N + 1)] + x[this.IX(0, N)]);
    x[this.IX(N + 1, 0)] = 0.5 * (x[this.IX(N, 0)] + x[this.IX(N + 1, 1)]);
    x[this.IX(N + 1, N + 1)] = 0.5 * (x[this.IX(N, N + 1)] + x[this.IX(N + 1, N)]);
  }

  private diffuse(b: number, x: Float32Array, x0: Float32Array, diff: number, dt: number) {
    const N = this.N;
    const a = dt * diff * N * N;
    const c = 1 + 4 * a;
    for (let iter = 0; iter < 4; iter++) {
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          x[this.IX(i, j)] =
            (x0[this.IX(i, j)] +
              a *
                (x[this.IX(i - 1, j)] +
                  x[this.IX(i + 1, j)] +
                  x[this.IX(i, j - 1)] +
                  x[this.IX(i, j + 1)])) /
            c;
        }
      }
      this.setBnd(b, x);
    }
  }

  private advect(b: number, d: Float32Array, d0: Float32Array, u: Float32Array, v: Float32Array, dt: number) {
    const N = this.N;
    const dt0 = dt * N;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        let x = i - dt0 * u[this.IX(i, j)];
        let y = j - dt0 * v[this.IX(i, j)];
        x = Math.max(0.5, Math.min(N + 0.5, x));
        y = Math.max(0.5, Math.min(N + 0.5, y));
        const i0 = Math.floor(x),
          i1 = i0 + 1;
        const j0 = Math.floor(y),
          j1 = j0 + 1;
        const s1 = x - i0,
          s0 = 1 - s1;
        const t1 = y - j0,
          t0 = 1 - t1;
        d[this.IX(i, j)] =
          s0 * (t0 * d0[this.IX(i0, j0)] + t1 * d0[this.IX(i0, j1)]) +
          s1 * (t0 * d0[this.IX(i1, j0)] + t1 * d0[this.IX(i1, j1)]);
      }
    }
    this.setBnd(b, d);
  }

  private project(u: Float32Array, v: Float32Array, p: Float32Array, div: Float32Array) {
    const N = this.N;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        div[this.IX(i, j)] =
          (-0.5 * (u[this.IX(i + 1, j)] - u[this.IX(i - 1, j)] + v[this.IX(i, j + 1)] - v[this.IX(i, j - 1)])) / N;
        p[this.IX(i, j)] = 0;
      }
    }
    this.setBnd(0, div);
    this.setBnd(0, p);
    for (let iter = 0; iter < 4; iter++) {
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          p[this.IX(i, j)] =
            (div[this.IX(i, j)] +
              p[this.IX(i - 1, j)] +
              p[this.IX(i + 1, j)] +
              p[this.IX(i, j - 1)] +
              p[this.IX(i, j + 1)]) /
            4;
        }
      }
      this.setBnd(0, p);
    }
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        u[this.IX(i, j)] -= 0.5 * N * (p[this.IX(i + 1, j)] - p[this.IX(i - 1, j)]);
        v[this.IX(i, j)] -= 0.5 * N * (p[this.IX(i, j + 1)] - p[this.IX(i, j - 1)]);
      }
    }
    this.setBnd(1, u);
    this.setBnd(2, v);
  }

  step(dt: number, diffusion: number, viscosity: number) {
    this.diffuse(1, this.Vx0, this.Vx, viscosity, dt);
    this.diffuse(2, this.Vy0, this.Vy, viscosity, dt);
    this.project(this.Vx0, this.Vy0, this.Vx, this.Vy);
    this.advect(1, this.Vx, this.Vx0, this.Vx0, this.Vy0, dt);
    this.advect(2, this.Vy, this.Vy0, this.Vx0, this.Vy0, dt);
    this.project(this.Vx, this.Vy, this.Vx0, this.Vy0);

    this.diffuse(0, this.density0, this.density, diffusion, dt);
    this.advect(0, this.density, this.density0, this.Vx, this.Vy, dt);

    for (let i = 0; i < this.size; i++) {
      this.density[i] *= 0.997;
    }
  }

  getDensityAt(i: number, j: number): number {
    return this.density[this.IX(i, j)];
  }
  setDensityAt(i: number, j: number, val: number) {
    this.density[this.IX(i, j)] = val;
  }
  getVxAt(i: number, j: number): number {
    return this.Vx[this.IX(i, j)];
  }
  getVyAt(i: number, j: number): number {
    return this.Vy[this.IX(i, j)];
  }
  setVxAt(i: number, j: number, val: number) {
    this.Vx[this.IX(i, j)] = val;
  }
  setVyAt(i: number, j: number, val: number) {
    this.Vy[this.IX(i, j)] = val;
  }
}
