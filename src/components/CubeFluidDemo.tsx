import { useRef, useMemo, useCallback } from "react";
import { Canvas, useFrame, useThree, ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { FluidSolver } from "@/lib/fluidSolver";
import { createOceanSpectrum, evaluateGerstnerHeight } from "@/lib/gerstnerWaves";
import { VolumetricSlab, SlabCoupler, SLAB_DEPTH } from "@/lib/volumetricSlab";

// ─── Constants ───
const N = 48;
const D = SLAB_DEPTH; // Slab depth layers
const DIFFUSION = 0.00001;
const VISCOSITY = 0.000001;
const CUBE_SIZE = 2.8;

// Color palettes — deep ocean tones
const TOP_COLOR = [30, 120, 255] as const;
const BOTTOM_COLOR = [8, 15, 55] as const;
const SIDE_COLORS: readonly (readonly [number, number, number])[] = [
  [15, 140, 220],  // +X
  [10, 120, 200],  // -X  
  [20, 160, 180],  // +Z
  [60, 50, 200],   // -Z
];

// Side config: [materialIndex, sideIndex, integrationAxis, color]
const SIDE_CONFIGS: [number, number, number, readonly [number, number, number]][] = [
  [0, 0, 0, SIDE_COLORS[0]], // +X right
  [1, 1, 0, SIDE_COLORS[1]], // -X left
  [4, 2, 1, SIDE_COLORS[2]], // +Z front
  [5, 3, 1, SIDE_COLORS[3]], // -Z back
];

// ─── WaveField: 2D wave equation for top face ───
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

  /** Apply pressure feedback from volumetric interior (upwelling) */
  applyPressureFeedback(pressureField: Float32Array, strength: number) {
    const N = this.N;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        this.h[this.IX(i, j)] += pressureField[(j - 1) * N + (i - 1)] * strength;
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

    // Reflective boundaries with damping
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

// ─── Main Scene Component ───
function FluidCube() {
  const meshRef = useRef<THREE.Mesh>(null);
  const frameRef = useRef(0);
  const timeRef = useRef(0);

  const ctx = useMemo(() => {
    const waveField = new WaveField(N);
    const solver = new FluidSolver(N);
    const gerstnerWaves = createOceanSpectrum(N);

    // Volumetric slabs — one per side face (4 sides)
    const slabs = Array.from({ length: 4 }, () => new VolumetricSlab(N, D));
    const coupler = new SlabCoupler(N, D);

    // Textures & materials for the 6 cube faces
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

    // Scratch buffers for surface injection
    const surfaceVelocity = new Float32Array(N * N);
    const surfaceVorticity = new Float32Array(N * N);
    const surfacePressure = new Float32Array(N * N); // Feedback from slabs

    // Pending click impulses
    const pendingImpulses: { x: number; y: number; strength: number }[] = [];

    return {
      waveField, solver, gerstnerWaves, slabs, coupler,
      textures, materials,
      surfaceVelocity, surfaceVorticity, surfacePressure,
      pendingImpulses,
    };
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

    if (event.face.normal.y < 0.5) return; // Not top face

    const localPoint = mesh.worldToLocal(event.point.clone());
    const halfSize = CUBE_SIZE / 2;
    const gx = Math.round(((localPoint.x + halfSize) / CUBE_SIZE) * (N - 1) + 1);
    const gz = Math.round(((localPoint.z + halfSize) / CUBE_SIZE) * (N - 1) + 1);

    if (gx >= 1 && gx <= N && gz >= 1 && gz <= N) {
      ctx.pendingImpulses.push({ x: gx, y: gz, strength: 150 });

      // Inject strong vortex at click point
      const r = 6;
      const str = 100;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0.5 && dist <= r) {
            const xi = gx + dx, yi = gz + dy;
            if (xi >= 1 && xi <= N && yi >= 1 && yi <= N) {
              const falloff = 1 - dist / r;
              ctx.solver.addVelocity(xi, yi, -dy / dist * str * falloff, dx / dist * str * falloff);
              ctx.solver.addDensity(xi, yi, str * falloff * 0.4);
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
      waveField, solver, gerstnerWaves, slabs, coupler,
      textures, surfaceVelocity, surfaceVorticity, surfacePressure,
      pendingImpulses,
    } = ctx;

    // ─── 1. Process click impulses ───
    while (pendingImpulses.length > 0) {
      const imp = pendingImpulses.pop()!;
      waveField.addImpulse(imp.x, imp.y, 5, imp.strength);
      waveField.addRingWave(imp.x, imp.y, 4, 2.5, imp.strength * 0.7);
    }

    // ─── 2. Autonomous wave sources ───
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
      waveField.addRingWave(cx, cy, 3, 2, 30);
    }

    // Autonomous vortex injection
    if (frame % 100 === 0) {
      const cx = Math.floor(N * 0.3 + Math.sin(time * 0.25) * N * 0.3);
      const cy = Math.floor(N * 0.3 + Math.cos(time * 0.25) * N * 0.3);
      const r = 6, str = 60;
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

    // ─── 3. Apply volumetric pressure feedback to surface ───
    // Upwelling from the interior volume drives the surface waves
    surfacePressure.fill(0);
    for (let s = 0; s < 4; s++) {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          surfacePressure[j * N + i] += slabs[s].getSurfacePressure(i, j) * 0.25;
        }
      }
    }
    waveField.applyPressureFeedback(surfacePressure, dt * 0.8);

    // ─── 4. Step physics ───
    waveField.step(dt);
    solver.step(dt, DIFFUSION, VISCOSITY);

    // ─── 5. Build surface energy fields ───
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const gi = i + 1, gj = j + 1;
        const gerstnerH = evaluateGerstnerHeight(gi, gj, time, gerstnerWaves);
        const h = waveField.getHeight(gi, gj) + gerstnerH;

        const vx = solver.getVxAt(gi, gj);
        const vy = solver.getVyAt(gi, gj);
        const vel = Math.sqrt(vx * vx + vy * vy);
        const vort = solver.getDensityAt(gi, gj);

        const idx = j * N + i;
        // Perpendicular velocity = wave height gradient (approximation)
        surfaceVelocity[idx] = Math.abs(h) * 0.5 + vel * 0.3;
        // Vorticity = density + velocity curl
        surfaceVorticity[idx] = vort * 0.5 + vel * 0.4;
      }
    }

    // ─── 6. Inject surface energy into volumetric slabs ───
    // Each slab gets the full surface but weighted by proximity to its face
    for (let s = 0; s < 4; s++) {
      const slab = slabs[s];
      const cfg = SIDE_CONFIGS[s];
      const intAxis = cfg[2]; // 0 = integrates along X, 1 = integrates along Z

      // Build proximity-weighted surface for this face
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = j * N + i;
          // Proximity weight: how close is this point to the face edge?
          let proxWeight: number;
          if (s === 0) { // +X: strong when i is high
            proxWeight = Math.exp(-3.0 * (1 - i / N));
          } else if (s === 1) { // -X: strong when i is low  
            proxWeight = Math.exp(-3.0 * (i / N));
          } else if (s === 2) { // +Z: strong when j is high
            proxWeight = Math.exp(-3.0 * (1 - j / N));
          } else { // -Z: strong when j is low
            proxWeight = Math.exp(-3.0 * (j / N));
          }

          surfaceVelocity[idx] *= proxWeight;
          surfaceVorticity[idx] *= proxWeight;
        }
      }

      slab.injectSurface(surfaceVelocity, surfaceVorticity);

      // Restore unweighted values for next slab
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const gi = i + 1, gj = j + 1;
          const gerstnerH = evaluateGerstnerHeight(gi, gj, time, gerstnerWaves);
          const h = waveField.getHeight(gi, gj) + gerstnerH;
          const vx = solver.getVxAt(gi, gj);
          const vy = solver.getVyAt(gi, gj);
          const vel = Math.sqrt(vx * vx + vy * vy);
          const vort = solver.getDensityAt(gi, gj);
          const idx = j * N + i;
          surfaceVelocity[idx] = Math.abs(h) * 0.5 + vel * 0.3;
          surfaceVorticity[idx] = vort * 0.5 + vel * 0.4;
        }
      }
    }

    // ─── 7. Step volumetric slabs ───
    for (let s = 0; s < 4; s++) {
      slabs[s].step(dt, 0.02);
    }

    // ─── 8. Couple adjacent slabs (hypergraph interaction) ───
    // Adjacent side slabs share edges where their volumetric extrusions overlap
    coupler.coupleSlabs(slabs[0], slabs[2], 0.1); // +X ↔ +Z
    coupler.coupleSlabs(slabs[0], slabs[3], 0.1); // +X ↔ -Z
    coupler.coupleSlabs(slabs[1], slabs[2], 0.1); // -X ↔ +Z
    coupler.coupleSlabs(slabs[1], slabs[3], 0.1); // -X ↔ -Z

    // ─── 9. Render top face ───
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

          // Height-based lighting with Fresnel-like effect
          const hNorm = h * 0.008;
          const bright = Math.max(0, Math.min(1, 0.15 + hNorm * 0.35 + Math.abs(hNorm) * 0.4));
          const swirl = Math.min(1, d * 0.008 + vel * 0.04);

          // Caustic shimmer from volumetric pressure feedback
          const pFeedback = surfacePressure[j * N + i] * 0.02;
          const caustic = Math.max(0, Math.sin(h * 3 + time * 2) * 0.15 + pFeedback);

          const idx = (j * N + i) * 4;
          data[idx]     = Math.floor(Math.min(255, bright * TOP_COLOR[0] + swirl * 50 + caustic * 40));
          data[idx + 1] = Math.floor(Math.min(255, bright * TOP_COLOR[1] + swirl * 70 + caustic * 80));
          data[idx + 2] = Math.floor(Math.min(255, bright * TOP_COLOR[2] + swirl * 30 + caustic * 20));
          data[idx + 3] = 255;
        }
      }
      textures[2].needsUpdate = true;
    }

    // ─── 10. Render side faces from volumetric slabs ───
    for (let si = 0; si < 4; si++) {
      const [matIdx, , intAxis, color] = SIDE_CONFIGS[si];
      const slab = slabs[si];
      const data = textures[matIdx].image.data as Uint8Array;

      for (let tj = 0; tj < N; tj++) {
        // Map vertical pixel to depth layer
        const depthFrac = tj / N; // 0 = top, 1 = bottom
        const kFloat = depthFrac * (D - 1);
        const k0 = Math.floor(kFloat);
        const k1 = Math.min(D - 1, k0 + 1);
        const kFrac = kFloat - k0;

        for (let ti = 0; ti < N; ti++) {
          // Sample the volumetric slab with interpolation
          const [vort0, perp0, pres0] = slab.sample(ti, ti, k0);
          const [vort1, perp1, pres1] = slab.sample(ti, ti, k1);

          const vort = vort0 * (1 - kFrac) + vort1 * kFrac;
          const perp = perp0 * (1 - kFrac) + perp1 * kFrac;
          const pres = pres0 * (1 - kFrac) + pres1 * kFrac;

          // Also integrate from top face for columnar projection
          let columnEnergy = 0;
          if (intAxis === 0) {
            // Integrates along X axis — sample column from top face
            for (let x = 0; x < N; x++) {
              const proxW = (si === 0) 
                ? Math.exp(-3.0 * (1 - x / N))
                : Math.exp(-3.0 * (x / N));
              const topIdx = ti * N + x;
              columnEnergy += surfaceVorticity[topIdx] * proxW;
            }
          } else {
            for (let z = 0; z < N; z++) {
              const proxW = (si === 2)
                ? Math.exp(-3.0 * (1 - z / N))
                : Math.exp(-3.0 * (z / N));
              const topIdx = z * N + ti;
              columnEnergy += surfaceVorticity[topIdx] * proxW;
            }
          }
          columnEnergy /= N;

          // Combined energy from volumetric slab + column projection
          const depthDecay = Math.exp(-3.0 * depthFrac) * 0.6 + 
                            (1.0 / (1.0 + 10.0 * depthFrac * depthFrac)) * 0.4;
          
          const volEnergy = (vort + Math.abs(perp) * 0.5 + pres * 0.3) * 0.02;
          const colEnergy = columnEnergy * depthDecay * 0.015;
          const totalEnergy = Math.min(1, volEnergy + colEnergy);

          // Caustic-like light patterns on sides
          const causticPhase = ti * 0.3 + tj * 0.2 + time * 1.5;
          const caustic = Math.max(0, Math.sin(causticPhase) * Math.sin(causticPhase * 0.7)) * totalEnergy * 0.3;

          const t = totalEnergy;
          const t2 = t * t;

          const idx = (tj * N + ti) * 4;
          data[idx]     = Math.floor(Math.min(255, 2 + t2 * color[0] + caustic * 30));
          data[idx + 1] = Math.floor(Math.min(255, 2 + t2 * color[1] + caustic * 50));
          data[idx + 2] = Math.floor(Math.min(255, 4 + t2 * color[2] + caustic * 20));
          data[idx + 3] = 255;
        }
      }
      textures[matIdx].needsUpdate = true;
    }

    // ─── 11. Render bottom face from deepest slab layers ───
    {
      const data = textures[3].image.data as Uint8Array;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          // Sample deepest layer of all 4 slabs and combine
          let energy = 0;
          for (let s = 0; s < 4; s++) {
            const [vort, perp, pres] = slabs[s].sample(i, j, D - 1);
            energy += (vort + Math.abs(perp) * 0.3 + pres * 0.2) * 0.25;
          }

          // Add direct top-face projection through full depth
          const topVort = surfaceVorticity[j * N + i];
          const fullDecay = Math.exp(-3.0) * 0.6 + (1 / 11) * 0.4; // depthFrac = 1
          energy += topVort * fullDecay * 0.008;

          const t = Math.min(1, energy * 0.015);
          const t2 = t * t;

          // Deep caustics — slower, more diffuse
          const caustic = Math.max(0, 
            Math.sin(i * 0.15 + j * 0.12 + time * 0.8) * 
            Math.sin(i * 0.08 - time * 0.5)
          ) * t * 0.25;

          const idx = (j * N + i) * 4;
          data[idx]     = Math.floor(2 + t2 * BOTTOM_COLOR[0] + caustic * 15);
          data[idx + 1] = Math.floor(2 + t2 * BOTTOM_COLOR[1] + caustic * 25);
          data[idx + 2] = Math.floor(4 + t2 * BOTTOM_COLOR[2] + caustic * 40);
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
