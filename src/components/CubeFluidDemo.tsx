import { useRef, useMemo, useCallback } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { FluidSolver } from "@/lib/fluidSolver";

const N = 48;
const DIFFUSION = 0.00001;
const VISCOSITY = 0.000001;

const FACE_COLORS: [number, number, number][] = [
  [0, 190, 220],   // +X cyan
  [0, 170, 200],   // -X teal
  [90, 150, 255],  // +Y blue
  [70, 130, 240],  // -Y indigo
  [0, 220, 180],   // +Z emerald
  [150, 100, 255], // -Z violet
];

// Edge definitions: [faceA, sideA, faceB, sideB]
// Sides: 0=bottom(j=1), 1=right(i=N), 2=top(j=N), 3=left(i=1)
const EDGES: [number, number, number, number][] = [
  [4, 1, 0, 3], [4, 3, 1, 1], [4, 2, 2, 0], [4, 0, 3, 2],
  [5, 1, 1, 3], [5, 3, 0, 1], [5, 2, 2, 2], [5, 0, 3, 0],
  [0, 2, 2, 1], [0, 0, 3, 1], [1, 2, 2, 3], [1, 0, 3, 3],
];

function getEdgeCoord(side: number, k: number): [number, number] {
  switch (side) {
    case 0: return [k, 1];
    case 1: return [N, k];
    case 2: return [k, N];
    case 3: return [1, k];
    default: return [1, 1];
  }
}

function coupleEdges(faces: FluidSolver[]) {
  for (const [fA, sA, fB, sB] of EDGES) {
    const solverA = faces[fA], solverB = faces[fB];
    for (let k = 1; k <= N; k++) {
      const [iA, jA] = getEdgeCoord(sA, k);
      const [iB, jB] = getEdgeCoord(sB, k);

      // Average density
      const avg = (solverA.getDensityAt(iA, jA) + solverB.getDensityAt(iB, jB)) * 0.5;
      solverA.setDensityAt(iA, jA, avg);
      solverB.setDensityAt(iB, jB, avg);

      // Perpendicular velocity transfer
      const perpA = (sA === 0 || sA === 2) ? solverA.getVyAt(iA, jA) : solverA.getVxAt(iA, jA);
      const perpB = (sB === 0 || sB === 2) ? solverB.getVyAt(iB, jB) : solverB.getVxAt(iB, jB);

      if (sA === 0 || sA === 2) solverA.setVyAt(iA, jA, -perpB * 0.5);
      else solverA.setVxAt(iA, jA, -perpB * 0.5);
      if (sB === 0 || sB === 2) solverB.setVyAt(iB, jB, -perpA * 0.5);
      else solverB.setVxAt(iB, jB, -perpA * 0.5);
    }
  }
}

function FluidCube() {
  const meshRef = useRef<THREE.Mesh>(null);
  const frameCount = useRef(0);

  const { faces, textures, materials } = useMemo(() => {
    const faces = Array.from({ length: 6 }, () => new FluidSolver(N));
    const textures = Array.from({ length: 6 }, () => {
      const data = new Uint8Array(N * N * 4);
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      return tex;
    });
    const materials = textures.map((tex) => new THREE.MeshBasicMaterial({ map: tex }));
    return { faces, textures, materials };
  }, []);

  const setMesh = useCallback(
    (mesh: THREE.Mesh | null) => {
      if (mesh) {
        (mesh as any).material = materials;
        meshRef.current = mesh;
      }
    },
    [materials]
  );

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.016);
    frameCount.current++;

    // Auto-spawn swirling dye
    if (frameCount.current % 25 === 0) {
      const face = Math.floor(Math.random() * 6);
      const cx = Math.floor(Math.random() * (N - 14)) + 7;
      const cy = Math.floor(Math.random() * (N - 14)) + 7;
      const r = 4;
      const strength = 100 + Math.random() * 150;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= r * r) {
            faces[face].addDensity(cx + dx, cy + dy, strength);
            faces[face].addVelocity(cx + dx, cy + dy, -dy * 10, dx * 10);
          }
        }
      }
    }

    // Step all solvers
    for (const face of faces) {
      face.step(dt, DIFFUSION, VISCOSITY);
    }
    coupleEdges(faces);

    // Update textures
    for (let f = 0; f < 6; f++) {
      const solver = faces[f];
      const data = textures[f].image.data as Uint8Array;
      const color = FACE_COLORS[f];

      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const d = Math.min(1, solver.getDensityAt(i + 1, j + 1) / 120);
          const idx = (j * N + i) * 4;
          const t = d * d;
          data[idx] = Math.floor(4 + t * color[0]);
          data[idx + 1] = Math.floor(4 + t * color[1]);
          data[idx + 2] = Math.floor(6 + t * color[2]);
          data[idx + 3] = 255;
        }
      }
      textures[f].needsUpdate = true;
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
