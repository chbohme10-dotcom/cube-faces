import { useRef, useMemo, useCallback } from "react";
import { Canvas, useFrame, useThree, ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { FluidSolver } from "@/lib/fluidSolver";
import { createOceanSpectrum, evaluateGerstnerHeight, GerstnerWaveComponent } from "@/lib/gerstnerWaves";

const N = 48;
const DIFFUSION = 0.00001;
const VISCOSITY = 0.000001;
const DEPTH_DECAY_WAVE = 4.0;
const DEPTH_DECAY_VORTEX = 2.0;
const PROXIMITY_RATE = 3.0;
const CUBE_SIZE = 2.8;

const TOP_COLOR = [30, 120, 255] as const;
const BOTTOM_COLOR = [20, 30, 100] as const;
const SIDE_COLORS: readonly (readonly [number, number, number])[] = [
  [0, 180, 230],
  [0, 160, 210],
  [0, 200, 190],
  [100, 80, 240],
];

const SIDE_CONFIGS: [number, number, number, readonly [number, number, number]][] = [
  [0, 0, 0, SIDE_COLORS[0]], // +X right
  [1, 1, 0, SIDE_COLORS[1]], // -X left
  [4, 2, 1, SIDE_COLORS[2]], // +Z front
  [5, 3, 1, SIDE_COLORS[3]], // -Z back
];

/**
 * 2D wave equation solver for the top face.
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

    for (let k = 1; k <= N; k++) {
      this.hTemp[this.IX(0, k)] = this.hTemp[this.IX(1, k)] * 0.7;
      this.hTemp[this.IX(N + 1, k)] = this.hTemp[this.IX(N, k)] * 0.7;
      this.hTemp[this.IX(k, 0)] = this.hTemp[this.IX(k, 1)] * 0.7;
      this.hTemp[this.IX(k, N + 1)] = this.hTemp[this.IX(k, N)] * 0.7;
    }

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
  const { raycaster, camera } = useThree();

  const ctx = useMemo(() => {
    const waveField = new WaveField(N);
    const solver = new FluidSolver(N);
    const gerstnerWaves = createOceanSpectrum(N);

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

    const proximityWeights = Array.from({ length: 4 }, () => new Float32Array(N));
    for (let k = 0; k < N; k++) {
      const pos = k + 1;
      proximityWeights[0][k] = Math.exp(-PROXIMITY_RATE * (N - pos) / N);
      proximityWeights[1][k] = Math.exp(-PROXIMITY_RATE * (pos - 1) / N);
      proximityWeights[2][k] = Math.exp(-PROXIMITY_RATE * (N - pos) / N);
      proximityWeights[3][k] = Math.exp(-PROXIMITY_RATE * (pos - 1) / N);
    }
    const proxSum = proximityWeights[0].reduce((a, b) => a + b, 0);

    const depthDecayW = new Float32Array(N);
    const depthDecayV = new Float32Array(N);
    for (let d = 0; d < N; d++) {
      depthDecayW[d] = Math.exp(-DEPTH_DECAY_WAVE * d / N);
      depthDecayV[d] = Math.exp(-DEPTH_DECAY_VORTEX * d / N);
    }

    const topWave = new Float32Array(N * N);
    const topVortex = new Float32Array(N * N);

    // Pending click impulses from raycasting
    const pendingImpulses: { x: number; y: number; strength: number }[] = [];

    return {
      waveField, solver, gerstnerWaves, textures, materials,
      proximityWeights, proxSum, depthDecayW, depthDecayV,
      topWave, topVortex, pendingImpulses,
    };
  }, []);

  const setMesh = useCallback((mesh: THREE.Mesh | null) => {
    if (mesh) {
      (mesh as any).material = ctx.materials;
      meshRef.current = mesh;
    }
  }, [ctx.materials]);

  /**
   * Handle click/touch on the cube — raycast to find top face hit point
   * and inject a wave impulse at that location.
   */
  const handlePointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const mesh = meshRef.current;
    if (!mesh || !event.face) return;

    // Check if we hit the top face (+Y). The face normal should point up.
    const normal = event.face.normal;
    if (normal.y < 0.5) return; // Not the top face

    // Convert hit point to local cube coordinates
    const localPoint = mesh.worldToLocal(event.point.clone());

    // Map from cube local coords [-1.4, 1.4] to grid coords [1, N]
    const halfSize = CUBE_SIZE / 2;
    const gx = Math.round(((localPoint.x + halfSize) / CUBE_SIZE) * (N - 1) + 1);
    const gz = Math.round(((localPoint.z + halfSize) / CUBE_SIZE) * (N - 1) + 1);

    if (gx >= 1 && gx <= N && gz >= 1 && gz <= N) {
      // Queue impulse + ring wave for natural water drop effect
      ctx.pendingImpulses.push({ x: gx, y: gz, strength: 120 });

      // Also inject vorticity at the click point for swirling effect
      const r = 5;
      const str = 80;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0.5 && dist <= r) {
            const xi = gx + dx, yi = gz + dy;
            if (xi >= 1 && xi <= N && yi >= 1 && yi <= N) {
              const falloff = 1 - dist / r;
              ctx.solver.addVelocity(xi, yi, -dy / dist * str * falloff, dx / dist * str * falloff);
              ctx.solver.addDensity(xi, yi, str * falloff * 0.3);
            }
          }
        }
      }
    }
  }, [ctx]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.016);
    frameRef.current++;
    timeRef.current += dt;
    const time = timeRef.current;
    const frame = frameRef.current;
    const {
      waveField, solver, gerstnerWaves, textures,
      proximityWeights, proxSum, depthDecayW, depthDecayV,
      topWave, topVortex, pendingImpulses,
    } = ctx;

    // ─── Process pending click impulses ───
    while (pendingImpulses.length > 0) {
      const imp = pendingImpulses.pop()!;
      waveField.addImpulse(imp.x, imp.y, 5, imp.strength);
      waveField.addRingWave(imp.x, imp.y, 3, 2, imp.strength * 0.6);
    }

    // ─── Autonomous wave sources ───
    if (frame % 50 === 0) {
      const cx = Math.floor(N / 2 + Math.cos(time * 0.4) * N * 0.28);
      const cy = Math.floor(N / 2 + Math.sin(time * 0.4) * N * 0.28);
      waveField.addImpulse(cx, cy, 3, 50);
    }

    if (frame % 50 === 25) {
      const cx = Math.floor(N / 2 + Math.cos(time * 0.6 + Math.PI) * N * 0.22);
      const cy = Math.floor(N / 2 + Math.sin(time * 0.6 + Math.PI) * N * 0.22);
      waveField.addImpulse(cx, cy, 2, 35);
    }

    if (frame % 120 === 0) {
      const cx = Math.floor(N * 0.3 + Math.sin(time * 0.2) * N * 0.2);
      const cy = Math.floor(N * 0.3 + Math.cos(time * 0.3) * N * 0.2);
      waveField.addRingWave(cx, cy, 2, 2, 30);
    }

    // Vortex injection
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

    // ─── Build top-face energy fields with Gerstner waves ───
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const gi = i + 1, gj = j + 1;

        // Gerstner wave evaluation — replaces the simple sine swell
        const gerstnerH = evaluateGerstnerHeight(gi, gj, time, gerstnerWaves);

        const h = waveField.getHeight(gi, gj) + gerstnerH;
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
          const gerstnerH = evaluateGerstnerHeight(gi, gj, time, gerstnerWaves);
          const h = waveField.getHeight(gi, gj) + gerstnerH;
          const d = solver.getDensityAt(gi, gj);
          const vx = solver.getVxAt(gi, gj);
          const vy = solver.getVyAt(gi, gj);
          const vel = Math.sqrt(vx * vx + vy * vy);

          const hNorm = h * 0.008;
          const bright = Math.max(0, Math.min(1, 0.15 + hNorm * 0.35 + Math.abs(hNorm) * 0.4));
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

    // ─── Render side faces ───
    const invProxSum = 1.0 / proxSum;

    for (const [matIdx, proxIdx, intAxis, color] of SIDE_CONFIGS) {
      const data = textures[matIdx].image.data as Uint8Array;
      const proxW = proximityWeights[proxIdx];

      for (let tj = 0; tj < N; tj++) {
        const depth = N - 1 - tj;
        const wDecay = depthDecayW[depth];
        const vDecay = depthDecayV[depth];

        for (let ti = 0; ti < N; ti++) {
          let waveVal = 0;
          let vortexVal = 0;

          if (intAxis === 0) {
            const z = ti;
            for (let x = 0; x < N; x++) {
              const w = proxW[x];
              waveVal += topWave[z * N + x] * w;
              vortexVal += topVortex[z * N + x] * w;
            }
          } else {
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
          const t2 = t * t;

          const idx = (tj * N + ti) * 4;
          data[idx] = Math.floor(3 + t2 * color[0]);
          data[idx + 1] = Math.floor(3 + t2 * color[1]);
          data[idx + 2] = Math.floor(5 + t2 * color[2]);
          data[idx + 3] = 255;
        }
      }
      textures[matIdx].needsUpdate = true;
    }

    // ─── Render bottom face (material 3, -Y) ───
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
    <mesh ref={setMesh} onPointerDown={handlePointerDown}>
      <boxGeometry args={[CUBE_SIZE, CUBE_SIZE, CUBE_SIZE]} />
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
