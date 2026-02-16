import { useRef, useMemo, useCallback } from "react";
import { Canvas, useFrame, ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { CubeFaceSolver } from "@/lib/cubeFaceSolver";
import { createOceanSpectrum, evaluateGerstnerHeight } from "@/lib/gerstnerWaves";

// ─── Constants ───
const N = 48;
const DIFFUSION = 0.00001;
const VISCOSITY = 0.000001;
const CUBE_SIZE = 2.8;

// ─── Color palettes per face ───
// [base_r, base_g, base_b, highlight_r, highlight_g, highlight_b]
const FACE_PALETTES: [number, number, number, number, number, number][] = [
  [10, 60, 160,   30, 180, 255],  // 0: +X right  — deep→cyan
  [8,  50, 150,   20, 160, 240],  // 1: −X left   — deep→blue
  [20, 80, 200,   60, 200, 255],  // 2: +Y top    — ocean surface
  [5,  12, 50,    15, 30,  120],  // 3: −Y bottom — abyss
  [12, 70, 155,   40, 190, 200],  // 4: +Z front  — deep→teal
  [15, 45, 170,   50, 120, 240],  // 5: −Z back   — deep→indigo
];

// ─── WaveField: 2D wave equation for the top face heightfield ───
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
    const N = this.N, r = Math.ceil(radius);
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
    const N = this.N, outer = Math.ceil(radius + width);
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

// ─── Rendering helpers ───

/** Render the top face (+Y) with Gerstner waves + fluid vorticity */
function renderTopFace(
  data: Uint8Array, N: number, waveField: WaveField,
  solver: CubeFaceSolver, gerstnerWaves: any[], time: number,
  palette: [number, number, number, number, number, number]
) {
  const face = solver.getFace(2); // +Y
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const gi = i + 1, gj = j + 1;
      const gerstnerH = evaluateGerstnerHeight(gi, gj, time, gerstnerWaves);
      const h = waveField.getHeight(gi, gj) + gerstnerH;
      const d = face.getDensityAt(gi, gj);
      const vx = face.getVxAt(gi, gj);
      const vy = face.getVyAt(gi, gj);
      const vel = Math.sqrt(vx * vx + vy * vy);

      // Height → brightness with Fresnel-like brightening at peaks
      const hNorm = h * 0.006;
      const bright = Math.max(0, Math.min(1, 0.2 + hNorm * 0.3 + Math.abs(hNorm) * 0.4));
      const swirl = Math.min(1, d * 0.006 + vel * 0.03);

      // Foam at wave crests
      const foam = Math.max(0, hNorm - 0.3) * 2.0;

      const idx = (j * N + i) * 4;
      const r = bright * palette[3] + swirl * 40 + foam * 80;
      const g = bright * palette[4] + swirl * 60 + foam * 100;
      const b = bright * palette[5] + swirl * 20 + foam * 60;
      data[idx]     = Math.floor(Math.min(255, palette[0] + r));
      data[idx + 1] = Math.floor(Math.min(255, palette[1] + g));
      data[idx + 2] = Math.floor(Math.min(255, palette[2] + b));
      data[idx + 3] = 255;
    }
  }
}

/** Render a side face (0,1,4,5) from its own fluid solver data */
function renderSideFace(
  data: Uint8Array, N: number, faceIdx: number,
  solver: CubeFaceSolver, time: number,
  palette: [number, number, number, number, number, number]
) {
  const face = solver.getFace(faceIdx);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const gi = i + 1, gj = j + 1;
      const d = face.getDensityAt(gi, gj);
      const vx = face.getVxAt(gi, gj);
      const vy = face.getVyAt(gi, gj);
      const vel = Math.sqrt(vx * vx + vy * vy);

      // Depth gradient: top of face (j=N) is bright, bottom (j=1) is dark
      // j in texture coords: j=0 is top of texture
      // For side faces, we want j=0 (top of texture) to be top of water
      const depthFrac = j / N; // 0 = top of face, 1 = bottom
      const depthDarken = 1.0 - depthFrac * 0.6;

      // Fluid energy
      const energy = Math.min(1, d * 0.015 + vel * 0.06);
      const energy2 = energy * energy;

      // Underwater caustic-like shimmer
      const caustic = Math.max(0,
        Math.sin(gi * 0.4 + time * 1.8) *
        Math.sin(gj * 0.3 + time * 1.2 + gi * 0.15)
      ) * energy * 0.4 * depthDarken;

      // Vorticity visualization — curl approximation
      const curl = Math.abs(
        (face.getVxAt(Math.min(N, gi + 1), gj) - face.getVxAt(Math.max(1, gi - 1), gj)) -
        (face.getVyAt(gi, Math.min(N, gj + 1)) - face.getVyAt(gi, Math.max(1, gj - 1)))
      ) * 0.02;

      const idx = (j * N + i) * 4;
      const r = depthDarken * (energy2 * palette[3] + curl * 20 + caustic * 25);
      const g = depthDarken * (energy2 * palette[4] + curl * 40 + caustic * 50);
      const b = depthDarken * (energy2 * palette[5] + curl * 15 + caustic * 30);
      data[idx]     = Math.floor(Math.min(255, palette[0] * depthDarken + r));
      data[idx + 1] = Math.floor(Math.min(255, palette[1] * depthDarken + g));
      data[idx + 2] = Math.floor(Math.min(255, palette[2] * depthDarken + b));
      data[idx + 3] = 255;
    }
  }
}

/** Render the bottom face (−Y) from its own solver data */
function renderBottomFace(
  data: Uint8Array, N: number,
  solver: CubeFaceSolver, time: number,
  palette: [number, number, number, number, number, number]
) {
  const face = solver.getFace(3); // −Y
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const gi = i + 1, gj = j + 1;
      const d = face.getDensityAt(gi, gj);
      const vx = face.getVxAt(gi, gj);
      const vy = face.getVyAt(gi, gj);
      const vel = Math.sqrt(vx * vx + vy * vy);

      const energy = Math.min(1, d * 0.012 + vel * 0.05);
      const energy2 = energy * energy;

      // Deep caustics — slow, diffuse light patterns
      const caustic = Math.max(0,
        Math.sin(gi * 0.12 + gj * 0.1 + time * 0.6) *
        Math.sin(gi * 0.08 - gj * 0.06 + time * 0.4)
      ) * (0.15 + energy * 0.4);

      const idx = (j * N + i) * 4;
      data[idx]     = Math.floor(Math.min(255, palette[0] + energy2 * palette[3] + caustic * 12));
      data[idx + 1] = Math.floor(Math.min(255, palette[1] + energy2 * palette[4] + caustic * 20));
      data[idx + 2] = Math.floor(Math.min(255, palette[2] + energy2 * palette[5] + caustic * 35));
      data[idx + 3] = 255;
    }
  }
}

// ─── Main scene component ───

function FluidCube() {
  const meshRef = useRef<THREE.Mesh>(null);
  const frameRef = useRef(0);
  const timeRef = useRef(0);

  const ctx = useMemo(() => {
    const cubeSolver = new CubeFaceSolver(N);
    const waveField = new WaveField(N);
    const gerstnerWaves = createOceanSpectrum(N);

    // Textures & materials for 6 faces
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

    const pendingImpulses: { x: number; y: number; strength: number }[] = [];

    return { cubeSolver, waveField, gerstnerWaves, textures, materials, pendingImpulses };
  }, []);

  const setMesh = useCallback((mesh: THREE.Mesh | null) => {
    if (mesh) {
      (mesh as any).material = ctx.materials;
      meshRef.current = mesh;
    }
  }, [ctx.materials]);

  // ─── Click interaction: raycast to top face ───
  const handlePointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const mesh = meshRef.current;
    if (!mesh || !event.face) return;
    if (event.face.normal.y < 0.5) return;

    const localPoint = mesh.worldToLocal(event.point.clone());
    const halfSize = CUBE_SIZE / 2;
    const gx = Math.round(((localPoint.x + halfSize) / CUBE_SIZE) * (N - 1) + 1);
    const gz = Math.round(((localPoint.z + halfSize) / CUBE_SIZE) * (N - 1) + 1);

    if (gx >= 1 && gx <= N && gz >= 1 && gz <= N) {
      ctx.pendingImpulses.push({ x: gx, y: gz, strength: 150 });
      // Inject vortex on top face
      ctx.cubeSolver.addVortex(2, gx, gz, 6, 120);
    }
  }, [ctx]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.016);
    frameRef.current++;
    timeRef.current += dt;
    const time = timeRef.current;
    const frame = frameRef.current;
    const { cubeSolver, waveField, gerstnerWaves, textures, pendingImpulses } = ctx;

    // ─── 1. Process click impulses on top face ───
    while (pendingImpulses.length > 0) {
      const imp = pendingImpulses.pop()!;
      waveField.addImpulse(imp.x, imp.y, 5, imp.strength);
      waveField.addRingWave(imp.x, imp.y, 4, 2.5, imp.strength * 0.7);
    }

    // ─── 2. Autonomous sources on top face ───
    if (frame % 45 === 0) {
      const cx = Math.floor(N / 2 + Math.cos(time * 0.4) * N * 0.28);
      const cy = Math.floor(N / 2 + Math.sin(time * 0.4) * N * 0.28);
      waveField.addImpulse(cx, cy, 3, 45);
      cubeSolver.addVortex(2, cx, cy, 4, 40);
    }
    if (frame % 45 === 22) {
      const cx = Math.floor(N / 2 + Math.cos(time * 0.6 + Math.PI) * N * 0.22);
      const cy = Math.floor(N / 2 + Math.sin(time * 0.6 + Math.PI) * N * 0.22);
      waveField.addImpulse(cx, cy, 2, 30);
      cubeSolver.addVortex(2, cx, cy, 3, 30);
    }
    if (frame % 100 === 0) {
      const cx = Math.floor(N * 0.3 + Math.sin(time * 0.2) * N * 0.2);
      const cy = Math.floor(N * 0.3 + Math.cos(time * 0.3) * N * 0.2);
      waveField.addRingWave(cx, cy, 3, 2, 25);
    }

    // ─── 3. Drive top face solver from wave field + Gerstner ───
    // Wave heights create velocity divergence → drives fluid from surface
    const topFace = cubeSolver.getFace(2);
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const gH = evaluateGerstnerHeight(i, j, time, gerstnerWaves);
        const h = waveField.getHeight(i, j) + gH;

        // Height gradient → velocity forcing (shallow water approximation)
        const hRight = waveField.getHeight(Math.min(N, i + 1), j) +
                       evaluateGerstnerHeight(Math.min(N, i + 1), j, time, gerstnerWaves);
        const hUp    = waveField.getHeight(i, Math.min(N, j + 1)) +
                       evaluateGerstnerHeight(i, Math.min(N, j + 1), time, gerstnerWaves);
        const gradX = (hRight - h) * 0.8;
        const gradY = (hUp - h) * 0.8;

        topFace.addVelocity(i, j, gradX * dt * 30, gradY * dt * 30);

        // Wave energy → density (visible fluid tracer)
        if (Math.abs(h) > 1.0) {
          topFace.addDensity(i, j, Math.abs(h) * dt * 8);
        }
      }
    }

    // ─── 4. Inject energy near edges of top face → drives side faces ───
    // This seeds the edge coupling: vorticity near top face edges
    // flows into side faces through the perpendicular transfer
    const edgeStrength = 15 * dt;
    for (let t = 1; t <= N; t++) {
      const gH = evaluateGerstnerHeight(N, t, time, gerstnerWaves);
      const h = Math.abs(waveField.getHeight(N, t) + gH);
      if (h > 0.5) {
        topFace.addDensity(N, t, h * edgeStrength);     // right edge → +X
        topFace.addDensity(1, t, h * edgeStrength);     // left edge → −X
      }
      const gH2 = evaluateGerstnerHeight(t, N, time, gerstnerWaves);
      const h2 = Math.abs(waveField.getHeight(t, N) + gH2);
      if (h2 > 0.5) {
        topFace.addDensity(t, N, h2 * edgeStrength);    // top edge → +Z
        topFace.addDensity(t, 1, h2 * edgeStrength);    // bottom edge → −Z
      }
    }

    // ─── 5. Step all physics ───
    waveField.step(dt);
    cubeSolver.step(dt, DIFFUSION, VISCOSITY);

    // ─── 6. Render all 6 faces ───
    // Top face
    renderTopFace(
      textures[2].image.data as Uint8Array, N,
      waveField, cubeSolver, gerstnerWaves, time,
      FACE_PALETTES[2]
    );
    textures[2].needsUpdate = true;

    // Side faces
    for (const fi of [0, 1, 4, 5]) {
      renderSideFace(
        textures[fi].image.data as Uint8Array, N,
        fi, cubeSolver, time,
        FACE_PALETTES[fi]
      );
      textures[fi].needsUpdate = true;
    }

    // Bottom face
    renderBottomFace(
      textures[3].image.data as Uint8Array, N,
      cubeSolver, time,
      FACE_PALETTES[3]
    );
    textures[3].needsUpdate = true;
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
        enableZoom
        enablePan={false}
        minDistance={5}
        maxDistance={12}
      />
    </Canvas>
  );
}
