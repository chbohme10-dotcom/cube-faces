/**
 * SplashParticles — 3D ballistic droplet system for the SDF ocean.
 *
 * When a splash is triggered, a burst of instanced sphere particles erupts
 * from the click point. They follow real ballistic trajectories with gravity
 * and air drag, stretch along their velocity vector (ribbon → droplet transition),
 * and report re-entry positions for secondary ripple generation.
 *
 * Physics:
 *   - Gravity: -9.81 m/s²
 *   - Quadratic air drag (Cd ≈ 0.47 for spheres)
 *   - Velocity-dependent elongation (stretch factor)
 *   - Surface tension clustering at low velocity
 *   - Random jitter for organic breakup
 */

import { useRef, useMemo, useCallback, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

// ─── Constants ───
const MAX_PARTICLES = 512;
const GRAVITY = -14.0; // slightly exaggerated for visual drama
const AIR_DRAG = 0.012;
const PARTICLE_RADIUS = 0.08;

export interface SplashEvent {
  x: number;
  z: number;
  time: number; // clock.elapsedTime when splash was created
  amplitude: number;
}

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  active: boolean;
  phase: number; // 0 = column/ribbon, 1 = free droplet
  delay: number; // staggered launch
}

function createParticle(): Particle {
  return {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    life: 0,
    maxLife: 0,
    size: 1,
    active: false,
    phase: 0,
    delay: 0,
  };
}

export default function SplashParticles({
  splashEvents,
  onSecondaryRipple,
}: {
  splashEvents: SplashEvent[];
  onSecondaryRipple?: (x: number, z: number, amplitude: number) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const particles = useRef<Particle[]>([]);
  const processedCount = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tempVec = useMemo(() => new THREE.Vector3(), []);

  // Initialize particle pool
  useEffect(() => {
    if (particles.current.length === 0) {
      for (let i = 0; i < MAX_PARTICLES; i++) {
        particles.current.push(createParticle());
      }
    }
  }, []);

  // Spawn particles for new splash events
  const spawnSplash = useCallback(
    (x: number, z: number, amplitude: number) => {
      const pool = particles.current;
      const count = Math.min(80, Math.floor(40 + amplitude * 15)); // 40-80 particles per splash

      let spawned = 0;
      for (let i = 0; i < pool.length && spawned < count; i++) {
        if (pool[i].active) continue;

        const p = pool[i];
        p.active = true;

        // Staggered launch for ribbon effect
        const launchGroup = spawned / count;
        p.delay = launchGroup * 0.15; // first particles launch immediately, later ones delayed
        p.life = -p.delay; // negative life = waiting
        p.maxLife = 2.0 + Math.random() * 2.5;
        p.phase = 0;

        // Position: cluster at click point with slight random spread
        const spreadRadius = 0.3 + launchGroup * 1.5;
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * spreadRadius;
        p.pos.set(
          x + Math.cos(angle) * r,
          0.1 + Math.random() * 0.5 * launchGroup, // slight height variation
          z + Math.sin(angle) * r
        );

        // Velocity: upward column with outward spread
        const upSpeed = amplitude * (4.0 + Math.random() * 6.0) * (1.0 - launchGroup * 0.5);
        const outSpeed = amplitude * (0.5 + Math.random() * 3.0) * launchGroup;
        const outAngle = angle + (Math.random() - 0.5) * 0.8;

        p.vel.set(
          Math.cos(outAngle) * outSpeed,
          upSpeed,
          Math.sin(outAngle) * outSpeed
        );

        // Add some turbulent jitter
        p.vel.x += (Math.random() - 0.5) * 2.0;
        p.vel.z += (Math.random() - 0.5) * 2.0;

        // Size variation: larger for column base, smaller for spray
        p.size = (0.5 + Math.random() * 1.0) * (1.0 - launchGroup * 0.4);

        spawned++;
      }
    },
    []
  );

  // Check for new splash events
  useEffect(() => {
    const newEvents = splashEvents.slice(processedCount.current);
    for (const ev of newEvents) {
      spawnSplash(ev.x, ev.z, ev.amplitude);
    }
    processedCount.current = splashEvents.length;
  }, [splashEvents, spawnSplash]);

  useFrame(({ clock }, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const dt = Math.min(delta, 0.05); // cap delta
    const pool = particles.current;
    let visibleCount = 0;

    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!p.active) {
        // Hide inactive
        dummy.position.set(0, -1000, 0);
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        continue;
      }

      p.life += dt;

      // Still in delay period
      if (p.life < 0) {
        dummy.position.set(0, -1000, 0);
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        continue;
      }

      // ─── Physics integration ───
      const speed = p.vel.length();

      // Gravity
      p.vel.y += GRAVITY * dt;

      // Quadratic air drag
      if (speed > 0.01) {
        const dragForce = AIR_DRAG * speed * speed;
        const dragAccel = Math.min(dragForce / 1.0, speed / dt * 0.5); // don't reverse
        tempVec.copy(p.vel).normalize().multiplyScalar(-dragAccel * dt);
        p.vel.add(tempVec);
      }

      // Random turbulent jitter (organic breakup)
      if (p.life > 0.3) {
        p.vel.x += (Math.random() - 0.5) * 0.8 * dt;
        p.vel.z += (Math.random() - 0.5) * 0.8 * dt;
      }

      // Integrate position
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;

      // ─── Water re-entry detection ───
      if (p.pos.y < -0.2 && p.vel.y < 0 && p.life > 0.2) {
        // Fire secondary ripple
        if (onSecondaryRipple && speed > 1.0) {
          const rippleAmp = Math.min(0.8, speed * 0.04 * p.size);
          onSecondaryRipple(p.pos.x, p.pos.z, rippleAmp);
        }
        p.active = false;
        continue;
      }

      // Lifetime kill
      if (p.life > p.maxLife) {
        p.active = false;
        continue;
      }

      // ─── Visual: velocity-stretched ellipsoid ───
      const lifeRatio = p.life / p.maxLife;
      const fadeIn = Math.min(1.0, p.life * 5.0);
      const fadeOut = 1.0 - Math.pow(Math.max(0, lifeRatio - 0.7) / 0.3, 2);
      const baseScale = PARTICLE_RADIUS * p.size * fadeIn * fadeOut;

      // Stretch along velocity direction (ribbon effect)
      const stretchFactor = 1.0 + Math.min(4.0, speed * 0.3);
      const lateralScale = Math.max(0.3, 1.0 - speed * 0.05);

      dummy.position.copy(p.pos);

      // Orient along velocity
      if (speed > 0.5) {
        tempVec.copy(p.vel).normalize();
        // Look along velocity direction
        dummy.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          tempVec
        );
        dummy.scale.set(
          baseScale * lateralScale,
          baseScale * stretchFactor,
          baseScale * lateralScale
        );
      } else {
        // At low speed, become round droplet
        dummy.quaternion.identity();
        dummy.scale.set(baseScale, baseScale, baseScale);
      }

      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Color: white spray at top, blueish as it falls
      const heightFactor = Math.max(0, Math.min(1, p.pos.y * 0.1));
      const color = new THREE.Color().setHSL(
        0.55 - heightFactor * 0.05, // slight hue shift
        0.15 + (1.0 - heightFactor) * 0.3, // more saturated lower
        0.7 + heightFactor * 0.3 // brighter at top
      );
      mesh.setColorAt(i, color);

      visibleCount++;
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.count = MAX_PARTICLES;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, MAX_PARTICLES]}
      frustumCulled={false}
    >
      <sphereGeometry args={[1, 6, 4]} />
      <meshStandardMaterial
        color="#c8dde8"
        transparent
        opacity={0.85}
        roughness={0.1}
        metalness={0.0}
        envMapIntensity={0.5}
      />
    </instancedMesh>
  );
}
