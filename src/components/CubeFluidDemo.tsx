import { useRef, useMemo, useCallback } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { FluidSolver } from "@/lib/fluidSolver";

const N = 48;
const DIFFUSION = 0.00001;
const VISCOSITY = 0.000001;
const DEPTH_DECAY_WAVE = 4.0;
const DEPTH_DECAY_VORTEX = 2.0;
const PROXIMITY_RATE = 3.0;

const TOP_COLOR = [30, 120, 255] as const;
const BOTTOM_COLOR = [20, 30, 100] as const;
const SIDE_COLORS: readonly (readonly [number, number, number])[] = [
  [0, 180, 230],   // +X right
  [0, 160, 210],   // -X left
  [0, 200, 190],   // +Z front
  [100, 80, 240],  // -Z back
];

// Side face config: [materialIndex, proximityIndex, integrateAxis]
// integrateAxis: 0 = integrate over x (side faces ±X), 1 = integrate over z (side faces ±Z)
const SIDE_CONFIGS: [number, number, number, readonly [number, number, number]][] = [
  [0, 0, 0, SIDE_COLORS[0]], // +X right
  [1, 1, 0, SIDE_COLORS[1]], // -X left
  [4, 2, 1, SIDE_COLORS[2]], // +Z front
  [5, 3, 1, SIDE_COLORS[3]], // -Z back
];

/**
 * 2D wave equation solver for the top face.
 * Produces real circular wave propagation with interference patterns.
 */
class WaveField {
  N: number;
  size: number;
  h: Float32Array;
  hPrev: Float32Array;
  hTemp: Float32Array;

  constructor(N: number) {
    this.N = N;
    this.size = (N + 2) * (N + 2);
    this.h = new Float32Array(this.size);
    this.hPrev = new Float32Array(this.size);
    this.hTemp = new Float32Array(this.size);
  }

  IX(i: number, j: number) { return i + j * (this.N + 2); }

  addImpulse(cx: number, cy: number, radius: number, strength: number) {
    const N = this.N;
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= radius) {
          const x = Math.round(cx + dx), y = Math.round(cy + dy);
          if (x >= 1 && x <= N && y >= 1 && y <= N) {
            const f = Math.cos(dist / radius * Math.PI * 0.5);
            this.h[this.IX(x, y)] += strength * f * f;
          }
        }
      }
    }
  }

  /** Add a ring-shaped wave (like a pebble drop) */
  addRingWave(cx: number, cy: number, radius: number, width: number, strength: number) {
    const N = this.N;
    const outer = Math.ceil(radius + width);
    for (let dy = -outer; dy <= outer; dy++) {
      for (let dx = -outer; dx <= outer; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        const ringDist = Math.abs(dist - radius);
        if (ringDist <= width) {
          const x = Math.round(cx + dx), y = Math.round(cy + dy);
          if (x >= 1 && x <= N && y >= 1 && y <= N) {
            const f = Math.cos(ringDist / width * Math.PI * 0.5);
            this.h[this.IX(x, y)] += strength * f;
          }
        }
      }
    }
  }

  step(dt: number) {
    const N = this.N;
    const c2 = 0.15 * N * N * dt * dt;
    const damp = 0.997;

    this.hTemp.fill(0);

    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = this.IX(i, j);
        const lap = this.h[this.IX(i - 1, j)] + this.h[this.IX(i + 1, j)] +
          this.h[this.IX(i, j - 1)] + this.h[this.IX(i, j + 1)] - 4 * this.h[idx];
        this.hTemp[idx] = (2 * this.h[idx] - this.hPrev[idx] + c2 * lap) * damp;
      }
    }

    // Absorbing boundary
    for (let k = 1; k <= N; k++) {
      this.hTemp[this.IX(0, k)] = this.hTemp[this.IX(1, k)] * 0.7;
      this.hTemp[this.IX(N + 1, k)] = this.hTemp[this.IX(N, k)] * 0.7;
      this.hTemp[this.IX(k, 0)] = this.hTemp[this.IX(k, 1)] * 0.7;
      this.hTemp[this.IX(k, N + 1)] = this.hTemp[this.IX(k, N)] * 0.7;
    }

    // Rotate buffers
    const tmp = this.hPrev;
    this.hPrev = this.h;
    this.h = this.hTemp;
    this.hTemp = tmp;
  }

  getHeight(i: number, j: number) { return this.h[this.IX(i, j)]; }
}

function FluidCube() {
  const meshRef = useRef<THREE.Mesh>(null);
  const frameRef = useRef(0);
  const timeRef = useRef(0);

  const ctx = useMemo(() => {
    const waveField = new WaveField(N);
    const solver = new FluidSolver(N);

    const textures = Array.from({ length: 6 }, () => {
      const data = new Uint8Array(N * N * 4);
      for (let k = 3; k < data.length; k += 4) data[k] = 255;
      const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      return tex;
    });

    const materials = textures.map(tex => new THREE.MeshBasicMaterial({ map: tex }));

    // Proximity weights: how strongly a given x or z position contributes to each side face
    const proximityWeights = Array.from({ length: 4 }, () => new Float32Array(N));
    let proxSum = 0;
    for (let k = 0; k < N; k++) {
      const pos = k + 1;
      proximityWeights[0][k] = Math.exp(-PROXIMITY_RATE * (N - pos) / N); // +X: high x = strong
      proximityWeights[1][k] = Math.exp(-PROXIMITY_RATE * (pos - 1) / N); // -X: low x = strong
      proximityWeights[2][k] = Math.exp(-PROXIMITY_RATE * (N - pos) / N); // +Z: high z = strong
      proximityWeights[3][k] = Math.exp(-PROXIMITY_RATE * (pos - 1) / N); // -Z: low z = strong
    }
    proxSum = proximityWeights[0].reduce((a, b) => a + b, 0);

    // Depth decay lookup tables
    const depthDecayW = new Float32Array(N);
    const depthDecayV = new Float32Array(N);
    for (let d = 0; d < N; d++) {
      depthDecayW[d] = Math.exp(-DEPTH_DECAY_WAVE * d / N);
      depthDecayV[d] = Math.exp(-DEPTH_DECAY_VORTEX * d / N);
    }

    // Pre-allocated projection buffers
    const topWave = new Float32Array(N * N);
    const topVortex = new Float32Array(N * N);

    return { waveField, solver, textures, materials, proximityWeights, proxSum, depthDecayW, depthDecayV, topWave, topVortex };
  }, []);

  const setMesh = useCallback((mesh: THREE.Mesh | null) => {
    if (mesh) {
      (mesh as any).material = ctx.materials;
      meshRef.current = mesh;
    }
  }, [ctx.materials]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.016);
    frameRef.current++;
    timeRef.current += dt;
    const time = timeRef.current;
    const frame = frameRef.current;
    const { waveField, solver, textures, proximityWeights, proxSum, depthDecayW, depthDecayV, topWave, topVortex } = ctx;

    // ─── Wave sources: deterministic, physically motivated ───

    // Primary orbiting dropper — creates expanding circular waves
    if (frame % 35 === 0) {
      const cx = Math.floor(N / 2 + Math.cos(time * 0.4) * N * 0.28);
      const cy = Math.floor(N / 2 + Math.sin(time * 0.4) * N * 0.28);
      waveField.addImpulse(cx, cy, 3, 70);
    }

    // Secondary dropper — counter-orbit for interference
    if (frame % 35 === 17) {
      const cx = Math.floor(N / 2 + Math.cos(time * 0.6 + Math.PI) * N * 0.22);
      const cy = Math.floor(N / 2 + Math.sin(time * 0.6 + Math.PI) * N * 0.22);
      waveField.addImpulse(cx, cy, 2, 50);
    }

    // Ring wave — pebble drop expanding outward
    if (frame % 90 === 0) {
      const cx = Math.floor(N * 0.3 + Math.sin(time * 0.2) * N * 0.2);
      const cy = Math.floor(N * 0.3 + Math.cos(time * 0.3) * N * 0.2);
      waveField.addRingWave(cx, cy, 2, 2, 40);
    }

    // Edge-proximity wave — demonstrates face projection asymmetry
    if (frame % 70 === 0) {
      const side = Math.floor(time * 0.15) % 4;
      let cx: number, cy: number;
      switch (side) {
        case 0: cx = N - 3; cy = N / 2; break;
        case 1: cx = 4; cy = N / 2; break;
        case 2: cx = N / 2; cy = N - 3; break;
        default: cx = N / 2; cy = 4; break;
      }
      waveField.addImpulse(Math.floor(cx), Math.floor(cy), 4, 90);
    }

    // Vortex injection into fluid solver — swirling motion
    if (frame % 100 === 0) {
      const cx = Math.floor(N * 0.3 + Math.sin(time * 0.25) * N * 0.3);
      const cy = Math.floor(N * 0.3 + Math.cos(time * 0.25) * N * 0.3);
      const r = 6;
      const str = 60;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0.5 && dist <= r) {
            const xi = cx + dx, yi = cy + dy;
            if (xi >= 1 && xi <= N && yi >= 1 && yi <= N) {
              const falloff = 1 - dist / r;
              solver.addVelocity(xi, yi, -dy / dist * str * falloff, dx / dist * str * falloff);
              solver.addDensity(xi, yi, str * falloff * 0.4);
            }
          }
        }
      }
    }

    // ─── Step simulations ───
    waveField.step(dt);
    solver.step(dt, DIFFUSION, VISCOSITY);

    // ─── Build top-face energy fields for projection ───
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const gi = i + 1, gj = j + 1;
        // Background ocean swell (rendering-only, doesn't affect simulation)
        const swell = Math.sin(time * 1.2 + gi * 0.13 + gj * 0.09) * 1.5
          + Math.sin(time * 0.7 + gi * 0.08 - gj * 0.12) * 1.0;
        const h = waveField.getHeight(gi, gj) + swell;
        topWave[j * N + i] = Math.abs(h);

        const vx = solver.getVxAt(gi, gj);
        const vy = solver.getVyAt(gi, gj);
        topVortex[j * N + i] = solver.getDensityAt(gi, gj) * 0.4 + Math.sqrt(vx * vx + vy * vy) * 0.35;
      }
    }

    // ─── Render top face (material 2, +Y) ───
    {
      const data = textures[2].image.data as Uint8Array;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const gi = i + 1, gj = j + 1;
          const swell = Math.sin(time * 1.2 + gi * 0.13 + gj * 0.09) * 1.5
            + Math.sin(time * 0.7 + gi * 0.08 - gj * 0.12) * 1.0;
          const h = waveField.getHeight(gi, gj) + swell;
          const d = solver.getDensityAt(gi, gj);
          const vx = solver.getVxAt(gi, gj);
          const vy = solver.getVyAt(gi, gj);
          const vel = Math.sqrt(vx * vx + vy * vy);

          const hNorm = h * 0.012;
          const bright = Math.max(0, Math.min(1, 0.12 + hNorm * 0.4 + Math.abs(hNorm) * 0.45));
          const swirl = Math.min(1, d * 0.008 + vel * 0.04);

          const idx = (j * N + i) * 4;
          data[idx] = Math.floor(Math.min(255, bright * TOP_COLOR[0] + swirl * 50));
          data[idx + 1] = Math.floor(Math.min(255, bright * TOP_COLOR[1] + swirl * 70));
          data[idx + 2] = Math.floor(Math.min(255, bright * TOP_COLOR[2] + swirl * 30));
          data[idx + 3] = 255;
        }
      }
      textures[2].needsUpdate = true;
    }

    // ─── Render side faces — orthographic depth projection ───
    const invProxSum = 1.0 / proxSum;

    for (const [matIdx, proxIdx, intAxis, color] of SIDE_CONFIGS) {
      const data = textures[matIdx].image.data as Uint8Array;
      const proxW = proximityWeights[proxIdx];

      for (let tj = 0; tj < N; tj++) {
        const depth = N - 1 - tj; // tj=N-1 → top (depth 0), tj=0 → bottom (depth N-1)
        const wDecay = depthDecayW[depth];
        const vDecay = depthDecayV[depth];

        for (let ti = 0; ti < N; ti++) {
          let waveVal = 0;
          let vortexVal = 0;

          if (intAxis === 0) {
            // Integrate over x, ti maps to z-axis of top face
            const z = ti;
            for (let x = 0; x < N; x++) {
              const w = proxW[x];
              waveVal += topWave[z * N + x] * w;
              vortexVal += topVortex[z * N + x] * w;
            }
          } else {
            // Integrate over z, ti maps to x-axis of top face
            const x = ti;
            for (let z = 0; z < N; z++) {
              const w = proxW[z];
              waveVal += topWave[z * N + x] * w;
              vortexVal += topVortex[z * N + x] * w;
            }
          }

          waveVal *= invProxSum;
          vortexVal *= invProxSum;

          const val = waveVal * wDecay + vortexVal * vDecay;
          const t = Math.min(1, val * 0.018);
          const t2 = t * t; // quadratic for more contrast

          const idx = (tj * N + ti) * 4;
          data[idx] = Math.floor(3 + t2 * color[0]);
          data[idx + 1] = Math.floor(3 + t2 * color[1]);
          data[idx + 2] = Math.floor(5 + t2 * color[2]);
          data[idx + 3] = 255;
        }
      }
      textures[matIdx].needsUpdate = true;
    }

    // ─── Render bottom face (material 3, -Y) — full-depth attenuation ───
    {
      const data = textures[3].image.data as Uint8Array;
      const wFull = depthDecayW[N - 1];
      const vFull = depthDecayV[N - 1];

      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const val = topWave[j * N + i] * wFull + topVortex[j * N + i] * vFull;
          const t = Math.min(1, val * 0.012);
          const t2 = t * t;

          const idx = (j * N + i) * 4;
          data[idx] = Math.floor(2 + t2 * BOTTOM_COLOR[0]);
          data[idx + 1] = Math.floor(2 + t2 * BOTTOM_COLOR[1]);
          data[idx + 2] = Math.floor(4 + t2 * BOTTOM_COLOR[2]);
          data[idx + 3] = 255;
        }
      }
      textures[3].needsUpdate = true;
    }
  });

  return (
    <mesh ref={setMesh}>
      <boxGeometry args={[2.8, 2.8, 2.8]} />
    </mesh>
  );
}

export default function CubeFluidDemo() {
  return (
    <Canvas
      camera={{ position: [4.5, 3.5, 4.5], fov: 45 }}
      gl={{ antialias: true }}
      style={{ background: "transparent" }}
    >
      <FluidCube />
      <OrbitControls
        autoRotate
        autoRotateSpeed={0.6}
        enableZoom={true}
        enablePan={false}
        minDistance={5}
        maxDistance={12}
      />
    </Canvas>
  );
}
