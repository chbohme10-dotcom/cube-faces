# ProFlow HyperReal Ocean — The Definitive Specification

> **Codename:** ProFlow Continuum  
> **Revision:** MASTERCLASS v5.0 — Single Source of Truth  
> **Date:** 2026-02-15  
> **Authority:** This document supersedes ALL prior specifications. Where any prior document contradicts this one, this one wins.  
> **Synthesized from:** 9 UltimateSplash proposals (V1–V9), 13 HyperRealOcean variants, 7 WebGPU drafts, GPT 5.2 meta-analysis, ULTIMATE_PROPOSAL v2.0, Validated Build Plan v3.0, OCEAN_SIMULATION_ENCYCLOPEDIA (Parts A–K), hyperwebgpubuildv1, NorthStar v2.1.0, and the full ProFlow codebase (1265+ files, 45+ engines).  
> **Architecture Spine:** V8 orchestration → V6 physics/stability → V9 implementation gotchas → V2 perf budget → V7 scope discipline  
> **Scope:** The most advanced real-time water system ever built for browser — continuous water from horizon to droplet, zero seams, in WebGPU.

---

## Table of Contents

| § | Section | Purpose |
|---|---------|---------|
| I | [Vision & North Star](#i-vision--north-star) | Why this exists |
| II | [Acceptance Criteria](#ii-acceptance-criteria) | When we ship |
| III | [Hard Constraints (C1–C12)](#iii-hard-constraints) | What we never violate |
| IV | [Data Contracts](#iv-data-contracts) | The typed ABI between all passes |
| V | [System Architecture](#v-system-architecture) | How it's wired |
| VI | [Compute Pipeline (P01–P05)](#vi-compute-pipeline) | The simulation engine |
| VII | [Particle System](#vii-particle-system) | The heart — phase FSM & ride window |
| VIII | [Rendering — One Water](#viii-rendering--one-water) | Shared optics & compositing |
| IX | [Coupling Feedback](#ix-coupling-feedback) | Gated two-way interaction |
| X | [Performance Governor](#x-performance-governor) | Quality scaling at runtime |
| XI | [Development Gates](#xi-development-gates) | The build sequence |
| XII | [Validation & Debug](#xii-validation--debug) | How we prove it works |
| XIII | [Physics Reference](#xiii-physics-reference) | Governing equations |
| XIV | [Scope Guardrails](#xiv-scope-guardrails) | What does NOT belong |
| XV | [Evolution Path](#xv-evolution-path) | Post-ship expansion |
| XVI | [Implementation Reference](#xvi-implementation-reference) | Repo, versions, constants |
| XVII | [Appendices](#xvii-appendices) | Glossary, attribution, decisions |

---

# I. Vision & North Star

## I.1 The Problem

Every real-time water system in existence — Unreal WaveWorks, Sea of Thieves, NVIDIA Flow, Crest, even offline Houdini FLIP — makes the same fatal compromise: **the moment water breaks, it stops being water.** It becomes particles pasted onto a surface. Two separate rendering systems with a visible seam. The spray doesn't remember it was once part of a wave crest.

This is not a rendering problem. It is an **identity** problem. The optical properties diverge at the fracture boundary — different Fresnel, different absorption, different tint. Two waters. The seam is not geometric. It is photometric.

## I.2 The Thesis

This compromise is no longer necessary in 2026. WebGPU compute shaders provide GPU-side particle simulation without CPU readback. Zero-copy `StorageBufferAttribute` eliminates the compute→render copy. Screen-space fluid rendering can smooth particle boundaries. And shared optical models — one file, one import, one water — kill the photometric seam.

We build **continuous water**: from spectral ocean at the horizon to the individual droplet falling from a crest, with no seam, no identity change, no "effect" boundary.

## I.3 The One Sentence

> **A wave crest rises, thins into a translucent sheet, stretches into ligaments, tears into droplets, those droplets fall back, create ring waves, and entrain foam — and at no point does the visual identity of "water" change.**

100% consensus across all 9 proposals (V1–V9). This sentence is the non-negotiable design north star. Every subsystem, every constraint, every pass exists to serve it.

## I.4 The Seam Truth

Many systems fail not because particles are "bad," but because optical identity changes at the fracture boundary. The seam reappears when ocean and spray use different Fresnel/absorption/tint. **Shared optics is the fix.** If ocean mesh and spray particles import identical optical constants, the seam disappears regardless of rendering technique.

---

# II. Acceptance Criteria

The system ships when — and only when — it passes all three tests. Everything else is negotiable. These are not.

## II.1 The Orbit Test

| | |
|---|---|
| **Procedure** | Orbit camera 360° around a breaking wave at 5 m distance |
| **Pass** | At no angle can you identify where "the ocean" ends and "the effect" begins. One water. |
| **Fail** | Two separate rendering systems with visible boundary, color shift, or reflection break |
| **Lighting** | Must pass under noon sun, golden hour, AND overcast |
| **Proves** | Seam elimination via shared optics + depth compositing |

## II.2 The Slow-Mo Test

| | |
|---|---|
| **Procedure** | Play breaking sequence at 0.25× speed |
| **Pass** | Visible continuous progression: sheet → elongating ligaments → pinching droplets → ballistic arcs → surface re-entry → ring waves |
| **Fail** | Particles pop in/out. No intermediate states. Confetti. |
| **Proves** | Physics progression via ride window + phase FSM |

## II.3 The Horizon Test

| | |
|---|---|
| **Procedure** | Camera at 500 m altitude |
| **Pass** | Seamless tiling, natural foam streaks, no computational artifacts (grid boundaries, spawn zones, particle regions) |
| **Fail** | Visible repetition, grid edges, particle pop-in at distance |
| **Proves** | Scale stability + LOD + foam advection correctness |

---

# III. Hard Constraints

These rules cannot be bent. Every one exists because violating it destroyed prior attempts across 20+ proposals and 7 WebGPU drafts.

## III.1 Constraint Table

| ID | Name | Group | One-Line Rule | Consensus |
|----|------|-------|---------------|-----------|
| **C1** | WebGPU-First | Platform | WebGPU is the engine; WebGL2 is degraded fallback only | 9/9 |
| **C2** | No API Mixing | Platform | One backend per session. `forceWebGL` is **FORBIDDEN**. | 9/9 |
| **C3** | No Readbacks | Performance | Zero `readBuffer`/`readTexture`/`readPixels` in hot path | 9/9 |
| **C4** | No Per-Frame Alloc | Performance | All resources at init. GC never touches hot path. | 9/9 |
| **C5** | Atomic-Free Crest | Simulation | Mask texture for spawn. No atomics, no append buffers. | 9/9 |
| **C6** | Ping-Pong | Simulation | Strict A↔B for all advected fields. Two nodes at init. | 9/9 |
| **C7** | Zero-Copy | Rendering | `StorageBufferAttribute` — compute writes, vertex reads. No CPU. | 9/9 |
| **C8** | Integration Resolved | Rendering | Committed approach (A or B). No ambiguity. | 9/9 |
| **C9** | Billboard Quads | Rendering | Instanced camera-facing quads. No `gl_PointSize`. | 9/9 |
| **C10** | Genesis First | Ordering | Spawn correct → tune ride → tune phase → enable coupling | 8/9 |
| **C11** | Format Matching | Quality | Explicit texture formats everywhere. No implicit conversions. | V6 |
| **C12** | Frame Ordering | Quality | Sequential compute passes. No parallel assumptions. | V6 |

## III.2 Critical Details

### C2: Correct Backend Selection

```typescript
// CORRECT — separate renderers
if (hasWebGPU) {
    this.renderer = new WebGPURenderer({ canvas, antialias: true });
    await this.renderer.init();
    this.isWebGPU = true;
} else {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.isWebGPU = false;
}

// FORBIDDEN — never do this
this.renderer = new WebGPURenderer({ canvas, forceWebGL: true });
```

`forceWebGL` creates WebGL through WebGPU's abstraction layer — slower than native `WebGLRenderer` and confusing for debugging.

### C5: MLS-MPM Exception

C5 applies to **spawn logic only**. MLS-MPM P2G (Phase 2) may use fixed-point atomics for grid scatter — explicitly permitted.

### C8: Two Valid Architectures

| Approach | When to Use | Key Requirement |
|----------|-------------|-----------------|
| **A: R3F Canvas + async gl factory** | Want R3F ecosystem | `gl={async (props) => { const r = new WebGPURenderer(props); await r.init(); return r; }}` |
| **B: React UI + vanilla three.js** | Want maximum control | `ref` to OceanEngine + telemetry callback; own frame loop |

**Recommendation:** Start with Approach B during development. Migrate to A after Gate 3.0 if needed.

### C10: V7 Divergence Resolved

V7 defines C10 as "Shared optics." Shared optics is correct but belongs in rendering architecture as an implicit Orbit Test requirement. **C10 = Genesis before feedback** — the ordering constraint.

---

# IV. Data Contracts

This is the typed ABI between all passes. The velocity packing fix (GPT 5.2 Contradiction C) is the single most critical correction in the entire specification.

## IV.1 Texture Packing (v3.0 CORRECTED)

> **MANDATORY FIX:** Store full surface-plane velocity `(vel.x, vel.z)` in velocityTex. Prior versions dropped `vel.z`, breaking foam advection and particle comovement on diagonal seas.

| Texture | Format | .x | .y | .z | .w | Ping-Pong? |
|---------|--------|----|----|----|----|------------|
| `heightTex` | RGBA32F 256² | disp.x | disp.y (η) | disp.z | **vel.y** | No |
| `normalTex` | RGBA32F 256² | N.x | N.y | N.z | **steepness** | No |
| `velocityTex` | RGBA32F 256² | **vel.x** | **vel.z** | curvature (κ) | reserved | No |
| `crestMaskTex` | RGBA32F 256² | intensity | breakType | crestAngle | steepExcess | Yes (V6 EMA) |
| `foamTexA/B` | RGBA32F 512² | density | age | — | — | Yes |
| `couplingTexA/B` | RGBA32F 256² | Δη | Δη̇ | Δfoam | energy | Yes (gated) |

### Downstream Impact of Velocity Fix

| Consumer | What It Reads | Corrected Source |
|----------|---------------|------------------|
| P02 CrestMask — vertical velocity | `heightTex.w` | (was velocityTex.y) |
| P02 CrestMask — steepness | `normalTex.w` | (was velocityTex.w) |
| P03 Foam — advection | `velocityTex.xy` = (vel.x, vel.z) | Both horizontal components |
| P04 Particles — co-movement | `velocityTex.xy` = (vel.x, vel.z) | Both horizontal components |
| P04 Particles — vertical velocity | `heightTex.w` = vel.y | For ride window attachment |

## IV.2 Particle Buffers (32K × vec4, Zero-Copy via C7)

| Buffer | .x | .y | .z | .w |
|--------|----|----|----|----|
| `positionBuf` | world x | world y | world z | phase (0–5) |
| `dataBuf` | vel.x | vel.y | vel.z | age (seconds) |
| `renderBuf` | size (m) | alpha (0–1) | thickness | elongation (1–4) |

## IV.3 Spectrum Buffer

```
waveBuf: vec4 × MAX_WAVE_COMPONENTS × 2
  [i×2+0]: (dirX, dirZ, amplitude, frequency)
  [i×2+1]: (phase, Q, reserved, reserved)
```

## IV.4 Memory Budget

| Resource | Memory |
|----------|--------|
| heightTex + normalTex + velocityTex (3 × RGBA32F × 256²) | 3 MB |
| crestMaskTex ×2 (ping-pong) | 2 MB |
| foamTexA + foamTexB (2 × RGBA32F × 512²) | 8 MB |
| couplingTexA + couplingTexB (2 × RGBA32F × 256²) | 2 MB |
| positionBuf + dataBuf + renderBuf (3 × vec4 × 32K) | 1.5 MB |
| waveBuf (vec4 × 96) | <1 KB |
| **Total** | **~16.5 MB** |

Lean. Fits on any discrete GPU. No mid-frame allocations.

---

# V. System Architecture

## V.1 Topology

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          React Application Layer                          │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────────────┐  │
│   │ Leva     │  │ PerfHUD  │  │ Debug    │  │ Validation Scene       │  │
│   │ Controls │  │ Overlay  │  │ Views    │  │ Selector               │  │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────────────────┘  │
│        └──────────────┴────────────┴────────────────┘                    │
│                       │ ref + telemetry callback                          │
├───────────────────────▼──────────────────────────────────────────────────┤
│                     OceanEngine (owns everything below)                   │
│                                                                          │
│  ┌─── COMPUTE PHASE (5 sequential dispatches — ORDER IS LAW) ────────┐  │
│  │  P01 WaveField → P02 CrestMask → P03 Foam → P04 Particles →      │  │
│  │  P05 Coupling [GATED — disabled until Gate 3.1]                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌─── RENDER PHASE ───────────────────────────────────────────────────┐  │
│  │  R01 Ocean Mesh (opaque, depth write ON)                           │  │
│  │  R02 Spray Billboards (transparent, additive, depth write OFF)     │  │
│  │  R03 Sky Dome (procedural)                                         │  │
│  │  R04 Debug Overlay (opt-in)                                        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌─── SERVICES ───────────────────────────────────────────────────────┐  │
│  │  PassRegistry  │  ResourcePool  │  Governor  │  Telemetry           │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

## V.2 Pass Registry (Canonical)

| ID | Name | Type | Res/Size | Est. Cost | Governor Fallback |
|----|------|------|----------|-----------|-------------------|
| P01 | WaveFieldCompute | compute | 256² | 0.8 ms | 128² |
| P02 | CrestMaskDetect | compute | 256² | 0.3 ms | 128² |
| P03 | FoamCompute | compute | 512² | 0.5 ms | 256² |
| P04 | ParticleSim | compute | 32K | 2.0 ms | 16K → 8K |
| P05 | CouplingFeedback | compute | 256² | 0.3 ms | DISABLE |
| R01 | OceanMeshRender | render | screen | 1.0 ms | LOD reduce |
| R02 | SprayBillboardRender | render | instanced | 0.8 ms | particle cap |
| R03 | SkyRender | render | screen | 0.1 ms | always on |
| R04 | DebugOverlay | render | screen | 0.1 ms | toggle |
| | **Compute total** | | | **~3.9 ms** | |
| | **Render total** | | | **~2.0 ms** | |
| | **Grand total** | | | **~5.9 ms** | **10.7 ms headroom at 60 fps** |

**Workgroup convention:** 2D textures: `[16, 16, 1]`. Particles: `[256, 1, 1]`.

## V.3 Init Order (Load-Bearing — Misordering Causes Silent Failures)

```
1.  navigator.gpu check → select backend
2.  Create WebGPURenderer OR WebGLRenderer (C2: NEVER forceWebGL)
3.  await renderer.init()              ← CRITICAL: before ANY resource creation
4.  Create Camera, OrbitControls
5.  ResourcePool.allocateAll(isWebGPU)  ← C4: ALL textures + buffers here
6.  WaveCompute(pool, waveBuf)
7.  CrestDetect(pool)                  ← creates ping-pong nodes (V6 EMA)
8.  FoamCompute(pool)                  ← creates BOTH ping-pong nodes
9.  ParticleSim(pool)
10. CouplingBridge(pool)
11. PassRegistry.register([P01..P05, R01..R04])
12. Governor(passRegistry, degradeLadder)
13. OceanMesh, SprayRenderer, Sky       ← scene objects
14. Resize handler
```

## V.4 Animate Loop

```typescript
private animate(time: number) {
    const dt = Math.min((time - this.lastTime) / 1000, 0.05);
    this.lastTime = time;
    const t0 = performance.now();

    if (this.isWebGPU) {
        // Sequential compute — ORDER IS LAW (C12)
        if (registry.isEnabled('P01')) renderer.compute(waveCompute.getNode());
        if (registry.isEnabled('P02')) renderer.compute(crestDetect.getNode());
        if (registry.isEnabled('P03')) renderer.compute(foamCompute.tick());     // ping-pong
        if (registry.isEnabled('P04')) renderer.compute(particleSim.getNode());
        if (registry.isEnabled('P05')) renderer.compute(couplingBridge.tick());   // gated
    } else {
        this.tickWebGLFallback(time);   // C2: never both
    }

    renderer.render(scene, camera);
    governor.update(performance.now() - t0);
    emitTelemetry();
}
```

## V.5 Service Layer

| Service | Role |
|---------|------|
| **PassRegistry** | Central list of all passes. Enable/disable. Cost tracking. Governor calls here. |
| **ResourcePool** | Pre-allocates ALL textures + buffers at init. No lazy alloc. Ping-pong management. |
| **Governor** | Monitors p95 frame time. Degrades in ordered steps. Restores in reverse. Hysteresis. |
| **Telemetry** | FPS, frame time, compute time, particle count. Throttled, opt-in, **no readbacks** (C3). |

---

# VI. Compute Pipeline

## VI.1 P01: Wave Field Computation

### Approach: Multi-Component Gerstner (Single Dispatch)

**Why Gerstner over FFT for Day 1:** FFT requires multiple passes (butterfly, IFFT, permutation), twiddle textures, sync. Gerstner is one dispatch, identical visual quality for 16–48 components, trivially parallel, exact analytical normals/curvature. **FFT is Phase 2** — same output contract, drop-in replacement.

### Governing Equations (V6 Physics-Corrected)

```
Displacement:
  x  = x₀ − Σᵢ Qᵢ Aᵢ Dᵢₓ cos(θᵢ)
  y  =      Σᵢ Aᵢ sin(θᵢ)
  z  = z₀ − Σᵢ Qᵢ Aᵢ Dᵢz cos(θᵢ)
  θᵢ = kᵢ(Dᵢ · x₀) − ωᵢt + φᵢ

Velocity (time derivatives):
  vₓ  = Σᵢ Qᵢ Aᵢ Dᵢₓ ωᵢ sin(θᵢ)
  v_y = Σᵢ Aᵢ ωᵢ cos(θᵢ)
  v_z = Σᵢ Qᵢ Aᵢ Dᵢz ωᵢ sin(θᵢ)

Normal (approximate, drops Q² terms):
  N ≈ normalize(−Σ kᵢAᵢDᵢₓcos(θ), 1 − Σ Qᵢkᵢ²Aᵢsin(θ), −Σ kᵢAᵢDᵢzcos(θ))

Steepness:  S = Σᵢ kᵢ Aᵢ Qᵢ |cos(θᵢ)|     (≥1 indicates breaking)
Curvature:  κ = −Σᵢ kᵢ² Aᵢ sin(θᵢ)
Dispersion: ω² = gk  (deep water)
Q:          min(choppiness / (k × A × N), 1.0)
```

### TSL Output (CORRECTED v3.0)

```
textureStore(heightTex,   ivec2(ix,iy), vec4(disp.x, disp.y, disp.z, vel.y));
textureStore(normalTex,   ivec2(ix,iy), vec4(norm.x, norm.y, norm.z, steep));
textureStore(velocityTex, ivec2(ix,iy), vec4(vel.x, vel.z, curv, 0.0));
```

### Spectrum Generation (CPU, at init or wind change)

JONSWAP spectral density with directional cos²ˢ spreading, stratified frequency sampling. Seeded RNG for determinism. 16–48 components typical.

---

## VI.2 P02: Crest Mask Detection

### Logic

```
steepExcess = smoothstep(crestThreshold, crestThreshold+0.3, steepness)
isRising    = smoothstep(0, 0.5, vertVel)          // from heightTex.w
curveFactor = smoothstep(0.5, 2.0, curvature)      // from velocityTex.z
intensity   = steepExcess × isRising × (curveFactor×0.5 + 0.5)

plungeScore = curvature × max(0, vertVel)           // Iribarren proxy
breakType   = smoothstep(0, 5.0, plungeScore)       // 0=spilling, 1=plunging
crestAngle  = atan2(gradZ, gradX)                   // from height finite differences
```

### V6 Enhancements (Gem 2 — Adopted)

- **EMA temporal smoothing:** Prevents single-frame flicker
- **3×3 neighborhood spatial smoothing:** Reduces noise
- **Ping-pong crest textures:** V6 caught the illegal read/write-to-same-texture bug. Crest needs A↔B like foam.

---

## VI.3 P03: Foam Compute (Deterministic Ping-Pong)

**C6 compliance:** Two StorageTextures, two compute nodes at init, XOR toggle each frame.

### Per-Texel Logic

```
1. ADVECTION:  Semi-Lagrangian trace-back by (vel.x, vel.z) — BOTH horizontals
2. DECAY:      Age-dependent tau (young ~2s, old ~8s)
3. INJECTION:  crestMask.x × foamInjectGain
4. STRETCH:    stretchDecay = clamp(1 − |vel|×0.1, 0.8, 1.0)
5. OUTPUT:     newDensity = clamp(max(decayed × stretchDecay, injection), 0, 1)
```

---

# VII. Particle System

This is the heart of the system. 32K particles, each independently executing a finite state machine.

## VII.1 Phase State Machine

```
DEAD (0) ──[crest mask sample > threshold]──→ RIDING (1)
  ▲                                              │
  │                              age > rideDuration OR
  │                              |gap| > detachDist OR
  │                              κ < kappaDetachThresh
  │                                              ▼
  │                                         SHEET (2)
  │                                              │
  │                              We < weCritSheet OR age > maxSheetAge
  │                                              ▼
  │                                       LIGAMENT (3)
  │                                              │
  │                              age > ligamentDuration
  │                                              ▼
  │                                        DROPLET (4)
  │                                         ╱        ╲
  │                          y > surf+thresh      ballistic
  │                              ▼                    │
  │                           SPRAY (5)               │
  │                              │            re-entry│
  └───── FEEDBACK_ELIGIBLE ──────┴────────────────────┘
              → DEAD
```

| Phase | Value | Entry | Exit | Physics |
|-------|-------|-------|------|---------|
| DEAD | 0 | Spawn/recycle | Crest mask > threshold | — |
| RIDING | 1 | Spawn from crest | Timer OR gap OR curvature drop | Attach, co-move, lift, damping |
| SHEET | 2 | RIDING exit | We < We_crit OR age > 4s | Gravity, thickness decay |
| LIGAMENT | 3 | SHEET breakup | age > ligamentDuration | Elongation, pinch |
| DROPLET | 4 | LIGAMENT pinch | y>surface → SPRAY; y<surface → DEAD | Ballistic + drag |
| SPRAY | 5 | DROPLET above surface | y<surface → DEAD; age>8 → DEAD | Ballistic + wind drag |

**Phase distribution during active break:** ~40% sheet, ~25% ligament, ~35% droplet.

## VII.2 Spawning (C5: Atomic-Free)

Dead particles sample crest mask at deterministic pseudo-random UV `(particleIndex + time hash)`. Probabilistic accept: `roll < intensity × spawnRate`.

**Genesis (C10):**
- **Position:** ON wave surface — sample heightTex at spawn UV
- **Velocity:** INHERITED from wave — sample velocityTex `(vel.x, vel.z)` + heightTex.w for vel.y

### Manual Bilinear Sampling (Gem 4 — NOT OPTIONAL)

StorageTexture has no sampler. `textureLoad()` returns point samples only. When particles sample off-texel, you **MUST** implement manual bilinear interpolation:

```
bilinearLoad(tex, uv, texSize):
  fx = uv.x × texSize;  fy = uv.y × texSize
  ix0 = floor(fx);       iy0 = floor(fy)
  s00 = textureLoad(tex, ivec2(ix0,   iy0))
  s10 = textureLoad(tex, ivec2(ix0+1, iy0))
  s01 = textureLoad(tex, ivec2(ix0,   iy0+1))
  s11 = textureLoad(tex, ivec2(ix0+1, iy0+1))
  return mix(mix(s00, s10, fract(fx)), mix(s01, s11, fract(fx)), fract(fy))
```

This lives in `compute/bilinearHelper.ts`. Bare `textureLoad()` for off-grid queries produces visible stepping artifacts.

## VII.3 Ride Window Forces (Gem 1 — The Critical Visual Gate)

**This is where cinematic believability is won or lost.** The difference between "water" and "confetti."

### Three-Force Model + Damping

| Force | Equation | Purpose |
|-------|----------|---------|
| **F_attach** | `gap.negate() × kAttach × rideAlpha` along normal | Soft spring toward wave surface |
| **F_comove** | `(targetVel − vel) × comoveGain × rideAlpha` | Bias velocity toward wave motion |
| **F_lift** | `max(0, κ − κLiftThresh) × liftGain` upward | Curvature-driven upward throw |
| **F_damp** | `−(vel − targetVel) × dampCoeff × rideAlpha` | Oscillation suppression |

**`rideAlpha`** = `1 − age / rideDuration` — decays linearly over ride window.

### Detach Conditions (Any Triggers Exit)

- `rideTimer > rideDuration` — time expired
- `|gap| > detachDist` — particle drifted from surface
- `curvature < kappaDetachThresh` — crest passed; let go

### No Velocity Discontinuity Rule

At detach: particle **keeps current velocity** + smooth lift boost. **Never** instant swap to new velocity.

### Parameters (All Leva-Tunable)

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| rideDuration | 0.4 s | 0.1–2.0 | How long sheet tracks crest |
| kAttach | 200 | 50–500 | Spring stiffness to surface |
| comoveGain | 15 | 5–50 | Velocity bias toward wave |
| liftGain | 5.0 | 1–20 | Curvature throw strength |
| dampCoeff | 10 | 2–50 | Oscillation damping |
| detachDist | 0.3 m | 0.05–1.0 | Max gap before forced detach |
| kappaLiftThresh | 1.5 | 0.5–5.0 | Curvature onset for throw |
| kappaDetachThresh | 0.2 | 0–1.0 | Curvature drop = detach |
| crestBoost | 0.3 | 0.1–1.0 | Spawn velocity multiplier |

## VII.4 Phase Transitions

### SHEET (Phase 2)
Gravity + thickness decay: `thickness -= dt × 0.5; clamp(0.02, 1.0)`. Weber-like breakup: `We = ρ·v²·L/σ` (V6 dimensionally correct). If `We < weCritSheet` OR `age > maxSheetAge` → LIGAMENT.

### LIGAMENT (Phase 3)
Elongation increases: `elongation += dt × 0.5; clamp(1.0, 4.0)`. After `ligamentDuration` → DROPLET. Jitter velocity at pinch-off for varied trajectories.

### DROPLET (Phase 4)
Ballistic + mild air drag (`vel *= 0.998`). If `y > surface + sprayThreshold` → SPRAY. If `y < surface − 0.2` → DEAD (FEEDBACK_ELIGIBLE).

### SPRAY (Phase 5)
Sphere drag: `F_drag = −0.5 × ρ_air × C_d × |v_rel| × v_rel / mass`. Wind influence. Re-entry → DEAD (FEEDBACK_ELIGIBLE).

---

# VIII. Rendering — One Water

## VIII.1 Shared Optics (Gem 5 — The Seam Killer)

**Both the ocean mesh AND the spray billboards import `sharedOptics.ts`.** Identical Fresnel, absorption, scatter, tint. One file. One import. If they diverge under any camera angle, the seam reappears. **This is architecture, not suggestion.**

```typescript
// sharedOptics.ts — THE SEAM KILLER
// Imported by BOTH WaterMaterial.ts AND SprayRenderer.ts

export const WATER_IOR     = 1.333;
export const WATER_F0      = 0.02;      // ((1-IOR)/(1+IOR))²

export const DEEP_COLOR    = [0.0, 0.05, 0.15];
export const SHALLOW_COLOR = [0.0, 0.15, 0.25];
export const FOAM_COLOR    = [0.85, 0.88, 0.92];
export const SSS_TINT      = [0.1, 0.4, 0.35];

export const ABSORPTION    = [0.45, 0.09, 0.06];   // per meter (Beer-Lambert)
export const SCATTER_COLOR = [0.02, 0.08, 0.12];

// Fresnel (Schlick): F = F0 + (1−F0)(1−N·V)⁵
// Absorption (Beer-Lambert): color × exp(−absorption × pathLength)
```

## VIII.2 Render Pass Order

| Pass | Purpose | Depth | Blend |
|------|---------|-------|-------|
| **R01 Ocean Mesh** | Displaced vertices from heightTex; Fresnel + absorption + foam + SSS | Write ON | Opaque |
| **R02 Spray Billboards** | Instanced quads from particle buffers; shared optics | Write OFF, Test ON | Additive |
| **R03 Sky Dome** | Procedural environment | — | Behind |
| **R04 Debug Overlay** | Opt-in fullscreen quad texture view | — | Overlay |

## VIII.3 Composite Strategy

**Day 1 (Gates 2.7–3.0):** Ocean mesh (opaque, depth writes) → Spray billboards (transparent, additive, depth test) → Shared optics ensures visual continuity. **Billboards pass Orbit at 5 m** if spawn density, shared optics, depth test, and ride window are all correct.

**Phase 2 (Post-Gate 4.0):** Screen-space fluid — depth splat → bilateral smooth → normal reconstruction → composite. Architecture supports drop-in without restructuring.

---

# IX. Coupling Feedback

## IX.1 Gating Protocol

**Default: DISABLED.** Only enabled after Gate 3.0 (seam elimination) passes. `passRegistry.isEnabled('P05')` = false until Gate 3.1. This prevents tuning feedback on a system whose visual output is wrong. (C10)

## IX.2 Mechanism

On particle re-entry (DEAD + FEEDBACK_ELIGIBLE flag):
1. **Ring wave seed:** Radial ∂η/∂t impulse at impact point
2. **Foam deposition:** Impact energy → foam injection
3. **Energy accumulator:** For runaway detection

## IX.3 Runaway Prevention — Triple Safety (Gem 3)

| Safety | Mechanism |
|--------|-----------|
| **1. Per-texel clamp** | No single texel > MAX_IMPULSE |
| **2. Temporal smoothing** | New feedback blended with previous (alpha = 0.3) |
| **3. Global energy cap** | Hierarchical mip chain reduction over .w channel. If total > cap, scale all. **GPU-side only — no readback.** |

## IX.4 Stability Protocol (5-Step Escalation)

| Step | Action | Duration | Verify |
|------|--------|----------|--------|
| 1 | Enable foam deposition only | 60 s | No foam runaway |
| 2 | Enable ring waves at gain = 0.1 | 60 s | No oscillation |
| 3 | Increase gain to 0.5 | 60 s | Stable |
| 4 | Gain = 1.0, storm conditions | 60 s | Bounded energy |
| 5 | If any step fails | — | Freeze at previous gain, investigate |

---

# X. Performance Governor

## X.1 Degrade Ladder (Canonical Order — Least Visual Impact First)

**Restore in REVERSE order.** Hysteresis prevents thrashing.

| Step | Action | Est. Save | Visual Impact |
|------|--------|-----------|---------------|
| 1 | Reduce particles 32K → 16K | 1.0 ms | Low |
| 2 | Reduce particles 16K → 8K | 0.5 ms | Medium |
| 3 | Reduce foam 512² → 256² | 0.3 ms | Low |
| 4 | Reduce crest smoothing radius | — | Low |
| 5 | Disable coupling (if enabled) | 0.3 ms | Medium |
| 6 | Disable screen-space fluid (if enabled) | — | Medium |
| 7 | Disable breakers (P02 + P04 off) | 2.3 ms | **High (last resort)** |

## X.2 Trigger Logic

```
DEGRADE:  p95 frametime > 16.6ms × 1.3  (sustained)
RESTORE:  p95 frametime < 16.6ms × 0.8  for 120+ frames (~2 seconds)
```

Use **exponential smoothing** on frame time, not raw values. V9 identified real bugs with naive implementation — governor must restore in reverse order, and each step requires both `apply()` and `restore()`.

---

# XI. Development Gates

## XI.1 Current State

| Gate | Status |
|------|--------|
| W0: WebGPU Lifecycle | ✅ |
| W1: Crest Mask Debug | ✅ |
| W2: Foam Ping-Pong Stable | ✅ |
| W3: Billboard Render | ✅ |
| 2.5: Genesis Position | ✅ |
| 2.6: Genesis Velocity | ✅ |
| **2.7: Ride Window** | **🔴 CURRENT BLOCKER** |
| 2.8–4.0 | ⬜ Pending |

## XI.2 Gate Definitions of Done

| Gate | Name | Definition of Done |
|------|------|-------------------|
| **2.7** | **Ride Window** | Sheet rides crest ≥0.3 s. Smooth attach, co-move, lift. Side camera at 0.25×: sheets track then peel away. No confetti. |
| **2.8** | Phase Transitions | Sheet→Lig→Drop visible at 0.25×. ≥2 distinct ligament frames. Phase histogram: ~40/25/35. |
| **3.0** | Seam Elimination | Orbit Test passes. Cannot find seam at noon, golden hour, overcast. |
| **3.1** | Coupling Feedback | Ring waves visible. Foam deposit. No runaway in 60 s storm. Stability protocol passes. |
| **4.0** | Perf No-Stall | 60 fps sustained. p99 < 16.6 ms. Governor degrades and restores smoothly. |

## XI.3 Advancement Rules

```
2.5 → 2.6 → 2.7 → 2.8 → 3.0 → 3.1 → 4.0

RULE: No gate N+1 work until gate N passes.
RULE: Coupling tuning FORBIDDEN until 2.7 + 2.8 visually pass.
```

## XI.4 Sprint Plan

| Sprint | Gate | Duration | Focus | Note |
|--------|------|----------|-------|------|
| **1** | **2.7** | **5 days** | Ride window: F_attach + F_comove + F_lift + detach | **MAKE-OR-BREAK** |
| 2 | 2.8 | 4 days | Phase transitions: Weber breakup cascade | Slow-Mo Test |
| 3 | 3.0 | 3 days | Seam elimination: shared optics, depth compositing | Orbit Test ×3 lighting |
| 4 | 3.1 | 3 days | Coupling: P05, triple safety, stability protocol | 5-step escalation |
| 5 | 4.0 | 2 days | Governor: degrade ladder, restore, stress test | Storm scene 60 fps |
| | | **~17 days** | | |

## XI.5 Ride Window Tuning Protocol (Gate 2.7)

1. Start with defaults: rideDuration=0.4, kAttach=200, comoveGain=15, liftGain=5
2. Run Ride Window validation scene at 0.25× speed
3. Ask Braden: "Does the sheet track the crest? How long? Is detach smooth?"
4. Adjust **one parameter at a time** (isolate variables)
5. Iterate until sheet visibly rides crest ≥0.3 s with smooth detach
6. Record final tuned values as new defaults

---

# XII. Validation & Debug

## XII.1 Debug Views (GPU-Only, Zero Readback)

| Key | View | Shows |
|-----|------|-------|
| F1 | Height Map | Wave displacement gradient |
| F2 | Normal Map | Surface normals → RGB |
| F3 | Crest Mask | Break intensity (red heat) |
| F4 | Steepness | normalTex.w as gradient |
| F5 | Foam Density | Foam texture (white overlay) |
| F6 | Particle Phase | RIDING=green, SHEET=cyan, LIGAMENT=yellow, DROPLET=red, SPRAY=white |
| F7 | Ride Timer | Age as green→red (detached=gray) |
| F8 | Pass Timing | Per-pass cost + governor state |

## XII.2 Validation Scenes

| Scene | Camera | Settings | Validates |
|-------|--------|----------|-----------|
| **Cinematic Breaker** | (15,5,20)→origin | wind 12, chop 1.5, 32 waves, seed 42 | Gates 2.7, 2.8, 3.0 |
| **Mid Storm** | (40,20,50)→origin | wind 20, chop 2.0, 48 waves, seed 137 | Gate 4.0 (perf) |
| **Far Horizon** | (0,8,150)→origin | wind 8, chop 1.0, 24 waves, seed 7 | Horizon Test |
| **Genesis Verify** | Freeze at t₀ | — | Particles on surface, vel correct |
| **Ride Window** | Side view, 0.25× | rideDuration 0.4 | Sheet tracks crest |
| **Seam Test** | Orbit 360° at 5m | — | Noon, golden hour, overcast |

## XII.3 Anti-Cue Catalog

| Anti-Cue | Likely Cause | Fix |
|----------|-------------|-----|
| Particles float above crest | kAttach too low | Increase kAttach |
| Particles slide backward | comoveGain too low | Increase comoveGain |
| Instant confetti | Ride window not applied | Code bug — verify RIDING path |
| Welded forever | rideDuration too high | Lower duration; check detach |
| Visible seam at boundary | Separate optics | Verify sharedOptics.ts import |
| Foam pulsing | Non-ping-pong foam | Verify A↔B toggle |
| Grid edges at horizon | Tile/resolution mismatch | Adjust tileSize; LOD |
| Goo (never breaks) | weCritSheet too low | Sheet should break within 0.8 s |
| Dust (instant scatter) | No cohesion | Ensure connected sheet ≥2 frames |
| Velocity pop at detach | Instant swap | Keep vel + smooth lift boost |
| Foam drifts one direction | vel.z dropped | Apply velocity packing fix (§IV.1) |

## XII.4 Red-Team Checklist (Pre-Ship — All Must Pass)

| # | Check | Method |
|---|-------|--------|
| 1 | velocityTex stores (vel.x, vel.z) not (vel.x, vel.y) | Inspect WaveCompute textureStore |
| 2 | heightTex.w = vel.y; normalTex.w = steepness | Inspect WaveCompute textureStore |
| 3 | Foam advection uses both horizontal components | Check FoamCompute trace-back |
| 4 | No readBuffer/mapAsync in animate | `grep -r "readBuffer\|mapAsync" src/` |
| 5 | No createTexture/createBuffer in animate | `grep -r "createTexture\|createBuffer" src/` |
| 6 | No new Float32Array in animate | `grep -r "new Float32Array" src/` |
| 7 | Crest uses mask texture, no atomics | No atomicAdd in spawn path |
| 8 | Foam has two textures with XOR toggle | foamA, foamB, two nodes |
| 9 | Crest detection uses EMA + ping-pong (V6) | crestA, crestB confirmed |
| 10 | Coupling gated — P05 disabled by default | passRegistry check |
| 11 | Shared optics — one import for both materials | sharedOptics.ts in both |
| 12 | Billboard quads, not points | InstancedMesh + PlaneGeometry |
| 13 | Zero-copy rendering | StorageBufferAttribute confirmed |
| 14 | Pass order P01→P02→P03→P04→P05 | No reorder in animate |
| 15 | Governor restores in reverse order | Each step has restore() |
| 16 | Manual bilinear for off-grid sampling | bilinearHelper.ts used |
| 17 | No forceWebGL on WebGPURenderer | Separate WebGLRenderer |
| 18 | Deterministic seed for spectrum | Same seed = same ocean |
| 19 | ResourcePool.allocateAll() at init | No lazy alloc |
| 20 | All texture formats explicitly matched (C11) | No implicit conversions |

## XII.5 PerfHUD Overlay

```
┌──────────────────────────────────────┐
│  PERF HUD                           │
│  Frame: 5.2ms  ■■■░░░░░░░  60 FPS  │
│  Compute: 3.8ms (P01:0.8 P02:0.3   │
│           P03:0.5 P04:2.0 P05:off)  │
│  Render: 1.8ms                       │
│  Particles: 24,391 / 32,768         │
│  Governor: FULL ●                    │
│  Backend: WebGPU                     │
└──────────────────────────────────────┘
```

---

# XIII. Physics Reference

## XIII.1 Governing Equations

| Equation | Formula |
|----------|---------|
| Deep-water dispersion | ω² = gk; c = √(g/k) |
| Finite depth | ω² = gk·tanh(kd) |
| Capillary-gravity | ω² = gk + (σ/ρ)k³ |
| Gerstner Q | min(choppiness / (k·A·N), 1.0) |
| JONSWAP | S(ω) = (αg²/ω⁵)·exp(−5/4·(ωp/ω)⁴)·γ^r |
| Directional spread | cos²ˢ(θ/2); s = 6–16 |
| Weber number | We = ρ·v²·L/σ |
| Monahan whitecap | W = 3.84×10⁻⁶·U₁₀^3.41 |
| Fresnel (Schlick) | F = F₀ + (1−F₀)(1−N·V)⁵ |
| Beer-Lambert | I = I₀·exp(−α·d) |
| Iribarren | ξ = tan(β)/√(H/L) |

## XIII.2 Breakup Thresholds

| Phenomenon | Formula | Critical Value |
|------------|---------|----------------|
| Sheet breakup | We = ρv²L/σ | We_crit ≈ 12 |
| Ligament (Rayleigh-Plateau) | We | We ≈ 40 |
| Wave breaking onset | S = Σ kᵢAᵢQᵢ\|cos θ\| | S ≥ 1 |
| Spilling vs plunging | ξ = tan(β)/√(H/L) | ξ < 0.5 spilling; 0.5–3.3 plunging |

## XIII.3 Physical Constants

| Constant | Value |
|----------|-------|
| g (gravity) | 9.81 m/s² |
| ρ_water | 1000 kg/m³ |
| ρ_air | 1.225 kg/m³ |
| σ (surface tension) | 0.073 N/m |
| C_d (sphere) | 0.44 |
| IOR (water) | 1.333 |
| F₀ (Fresnel at normal) | ~0.02 |

## XIII.4 Phenomenon → Engine Mapping

| Phenomenon | Scale | Engine Pass | Day 1? |
|------------|-------|-------------|--------|
| Deep-water swell | λ=30–300 m | P01 | ✅ |
| Wind sea | λ=1–30 m | P01 (higher-k) | ✅ |
| Micro ripples | λ<17 mm | **Shading-only. NEVER write to η.** | Partial |
| Whitecap foam | 0.5–5 m patches | P03 | ✅ |
| Breaking types | Per-crest | P02 | ✅ |
| Crest→Sheet genesis | Sheet 0.5–5 m | P02→P04 | ✅ |
| Sheet→Lig→Drop breakup | τ=1–10 mm | P04 | ✅ |
| Spray/spindrift | d=0.05–2 mm | P04 (SPRAY) | ✅ |
| Seam elimination | Rendering | R01+R02 shared optics | ✅ |

---

# XIV. Scope Guardrails

**Gem 6 (V7): This list is a survival manual.** Without explicit exclusions, every cool idea becomes a feature that blocks shipping.

| Feature | Why Excluded | Risk If Included |
|---------|--------------|------------------|
| Bubble plume simulation | Not visible in Three Tests | Months of work, marginal gain |
| God ray post-processing | Rendering polish, not water | Distraction from core gates |
| Nearshore bathymetry | Requires terrain system | Dependency chain blocker |
| Surface tension CSF model | MLS-MPM complexity | Performance cost, tuning nightmare |
| Rayleigh-Plateau pinch-off | Research physics | Over-engineering |
| Phenomenon Cards as build artifacts | Process overhead | Bureaucracy |
| 14-texture atlas | Premature optimization | Complexity without payoff |
| Multi-resolution cascade FFT | Phase 2 feature | Blocks shipping |
| Screen-space fluid for MVP | Post-Gate 4.0 | Billboards pass Orbit at 5 m |

**Philosophy:** Ship the minimum system that passes the Three Tests. Architecture supports all — they're not Gate 1–4.

---

# XV. Evolution Path

Every evolution adds passes to the registry and resources to the pool. The architecture is designed for this expansion.

| Phase | Feature | Integration Point |
|-------|---------|-------------------|
| 2.1 | FFT spectral ocean | Replace P01 Gerstner. Same output contract. |
| 2.2 | SWE heightfield dynamics | Object wakes, reflections. Feeds crestMask. |
| 2.3 | Screen-space fluid rendering | Depth splat → bilateral → normals → composite |
| 3.0 | MLS-MPM detail simulation | Replace/enhance P04. Same particle buffers. |
| 3.1 | Underwater camera optics | Post-process. Shared optics constants. |
| 3.2 | Caustics | Separate compute pass. Reads heightMap. |
| 4.0 | Multi-domain SWE nesting | Nested heightfields at different scales. |
| 4.1 | 3D volumetric wind | Wind texture drives spectrum generation. |
| 5.0 | Object physics (hulls, boards) | Buoyancy. Reads heightMap. |

---

# XVI. Implementation Reference

## XVI.1 Repository Structure

```
hyper-real-ocean/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
└── src/
    ├── main.tsx                      # React entry point
    ├── App.tsx                       # Canvas + UI overlay bridge
    ├── OceanEngine.ts                # Core orchestrator (init, animate, dispose)
    ├── types.ts                      # OceanSettings, OceanTelemetry, PassDescriptor
    ├── constants.ts                  # Single source of truth (§XVI.3)
    │
    ├── compute/
    │   ├── WaveCompute.ts            # P01: Gerstner wave field
    │   ├── CrestDetect.ts            # P02: Crest mask (EMA + ping-pong)
    │   ├── FoamCompute.ts            # P03: Foam advection (ping-pong)
    │   ├── ParticleSim.ts            # P04: Particle FSM + ride window + phases
    │   ├── CouplingBridge.ts         # P05: Coupling feedback (gated)
    │   ├── spectrum.ts               # JONSWAP generation (CPU, at init)
    │   └── bilinearHelper.ts         # Manual bilinear for StorageTexture (Gem 4)
    │
    ├── render/
    │   ├── OceanMesh.ts              # R01: Displaced mesh
    │   ├── SprayRenderer.ts          # R02: Instanced billboard quads
    │   ├── WaterMaterial.ts          # TSL node material
    │   ├── sharedOptics.ts           # Gem 5: ONE FILE for ALL water optics
    │   ├── Sky.ts                    # R03: Procedural sky dome
    │   └── DebugViews.ts             # R04: Fullscreen debug overlays
    │
    ├── services/
    │   ├── PassRegistry.ts           # Enable/disable/cost tracking
    │   ├── ResourcePool.ts           # Pre-allocate ALL resources (C4)
    │   └── Governor.ts               # Degrade ladder, restore, hysteresis
    │
    ├── ui/
    │   ├── Controls.tsx              # Leva panels
    │   ├── PerfHUD.tsx               # Performance overlay
    │   └── DebugOverlay.tsx          # Debug view selector
    │
    └── scenes/
        └── presets.ts                # Validation scene definitions
```

## XVI.2 Version Pinning

```json
{
    "three": "^0.172.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@react-three/fiber": "^9.0.0",
    "leva": "^0.9.35",
    "vite": "^6.0.0",
    "typescript": "^5.8.0"
}
```

**Vite aliases (required):**
```typescript
resolve: {
    alias: {
        'three/webgpu': 'three/build/three.webgpu.js',
        'three/tsl': 'three/build/three.tsl.js',
    }
}
```

## XVI.3 Constants (Single Source of Truth)

```typescript
// ═══ RESOLUTION ═══
export const WAVE_TEX_SIZE         = 256;
export const FOAM_TEX_SIZE         = 512;
export const COUPLING_TEX_SIZE     = 256;

// ═══ PARTICLES ═══
export const MAX_PARTICLES         = 32768;    // WebGPU
export const MAX_PARTICLES_WEBGL   = 8192;     // WebGL2 fallback
export const MAX_WAVE_COMPONENTS   = 48;

// ═══ PHASES ═══
export const PHASE_DEAD = 0, PHASE_RIDING = 1, PHASE_SHEET = 2;
export const PHASE_LIGAMENT = 3, PHASE_DROPLET = 4, PHASE_SPRAY = 5;

// ═══ RIDE WINDOW ═══
export const RIDE_DURATION         = 0.4;
export const K_ATTACH              = 200;
export const COMOVE_GAIN           = 15;
export const LIFT_GAIN             = 5.0;
export const DAMP_COEFF            = 10;
export const DETACH_DIST           = 0.3;
export const KAPPA_LIFT_THRESH     = 1.5;
export const KAPPA_DETACH_THRESH   = 0.2;
export const CREST_BOOST           = 0.3;

// ═══ PHASE TRANSITIONS ═══
export const WE_CRIT_SHEET         = 0.5;
export const WE_CRIT_LIGAMENT      = 40;
export const LIGAMENT_DURATION     = 1.0;
export const DROPLET_JITTER        = 0.5;
export const SPRAY_THRESHOLD       = 0.5;

// ═══ FOAM ═══
export const FOAM_INJECT_GAIN      = 0.8;
export const TAU_FOAM_YOUNG        = 2.0;
export const TAU_FOAM_OLD          = 8.0;

// ═══ COUPLING SAFETY ═══
export const FEEDBACK_GAIN         = 0.5;
export const IMPACT_GAIN           = 0.01;
export const MAX_IMPULSE           = 0.5;
export const COUPLING_ALPHA        = 0.3;
export const GLOBAL_ENERGY_CAP     = 1000;

// ═══ PHYSICS ═══
export const GRAVITY               = 9.81;
export const RHO_WATER             = 1000;
export const RHO_AIR               = 1.225;
export const CD_SPHERE             = 0.44;
export const SIGMA_WATER           = 0.073;

// ═══ OPTICS (SHARED — ONE WATER) ═══
export const WATER_IOR             = 1.333;
export const WATER_F0              = 0.02;
export const ABSORPTION            = [0.45, 0.09, 0.06] as const;
export const SCATTER_COLOR         = [0.02, 0.08, 0.12] as const;

// ═══ GOVERNOR ═══
export const GOVERNOR_TARGET_MS    = 16.6;
export const GOVERNOR_DEGRADE_RATIO = 1.3;
export const GOVERNOR_RESTORE_RATIO = 0.8;
export const GOVERNOR_RESTORE_FRAMES = 120;
```

## XVI.4 Leva Control Panel

```
Presets       │ scene: [cinematic-breaker, mid-storm, far-horizon]
Ocean         │ windSpeed [1,25], windDirection [-π,π], choppiness [0.1,3],
              │ waveCount [8,48], tileSize [50,500]
Breakers      │ enableBreakers, crestThreshold [0.1,1.5], maxParticles [8K-64K]
Ride Window   │ rideDuration, kAttach, comoveGain, liftGain, dampCoeff,
              │ detachDist, kappaLiftThresh, kappaDetachThresh, crestBoost
Phase Trans   │ enablePhaseTransitions, weCritSheet, weCritLigament,
              │ ligamentDuration, dropletJitter
Foam          │ enableFoam, foamInjectGain, foamDecayYoung, foamDecayOld
Coupling      │ enableCoupling (default false), feedbackGain, impactGain,
              │ maxImpulse, globalEnergyCap
Debug         │ debugView [none/F1-F8], showPerfHUD, timeScale [0.1,2]
Seed          │ seed [0,9999], regenerate (button)
```

---

# XVII. Appendices

## XVII.A The Six Gems (Preserved Insights)

These are the load-bearing insights from GPT 5.2's cross-analysis. Each is the difference between shipping and failing.

| Gem | Name | What It Means | Impact |
|-----|------|--------------|--------|
| **1** | Ride Window | F_attach + F_comove + F_lift make sheets track crests cinematically | Confetti vs water |
| **2** | Crest Stability | V6 EMA + ping-pong + 3×3 smoothing for crest detection | No flicker |
| **3** | Coupling Safety | Triple safety (clamp + temporal + global cap) prevents runaway | System doesn't explode |
| **4** | Manual Bilinear | StorageTexture has no sampler; off-grid reads need manual interpolation | No stepping artifacts |
| **5** | Shared Optics | One file for ocean + spray. The seam killer. | Orbit Test pass |
| **6** | Scope Guardrails | V7's exclusion list prevents feature creep from killing the project | Ship on time |

## XVII.B Glossary

| Term | Definition |
|------|------------|
| **η** | Surface elevation (height) |
| **κ** | Curvature (second spatial derivative of η) |
| **η̇** | ∂η/∂t — vertical velocity |
| **We** | Weber number: ρ·v²·L/σ |
| **ξ** | Iribarren number: tan(β)/√(H/L) |
| **Q** | Gerstner steepness parameter (0–1) |
| **Genesis** | Particle spawn ON wave surface with inherited velocity (Gates 2.5, 2.6) |
| **Ride Window** | RIDING phase: attach + co-move + lift forces (Gate 2.7) |
| **rideAlpha** | 1 − age/rideDuration — fade-out factor |
| **Crest Mask** | P02 output; .x = break intensity. Atomic-free spawn source (C5). |
| **Ping-Pong** | Read A → write B; swap next frame (C6) |
| **Zero-Copy** | Same GPU buffer for compute + vertex (C7) |
| **Shared Optics** | sharedOptics.ts — one file, both materials (Gem 5) |
| **Gated** | Feature disabled until specific gate passes |
| **One Water** | No visible seam. Orbit Test. |
| **Tuning in the Dark** | Adjusting gains when Genesis is wrong (C10 prevents) |
| **FEEDBACK_ELIGIBLE** | Sentinel on particle re-entry; triggers coupling |
| **EMA** | Exponential moving average (V6 crest stability) |

## XVII.C Decision Log

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| Wave model Day 1 | Gerstner | FFT | Single dispatch; FFT = Phase 2 |
| Crest spawn | Mask texture | Atomic append | TSL constrains atomics; mask universal (C5) |
| Foam strategy | Ping-pong A↔B | Single buffer | Nondeterminism is uncalibratable (C6) |
| Particle render | Instanced quads | Point sprites | gl_PointSize unreliable in WebGPU (C9) |
| React + WebGPU | React UI + three.js (Day 1) | R3F-only | Maximum control; async gl available later (C8) |
| Coupling default | Gated OFF | Always on | Runaway risk; Genesis first (C10) |
| C10 definition | Genesis before feedback | Shared optics (V7) | Ordering constraint; optics → rendering |
| WebGL2 fallback | Separate WebGLRenderer | forceWebGL | Faster, cleaner, C2 compliant |
| SSF for Gate 3.0 | Post-Gate 4.0 | Required for 3.0 | Billboards pass Orbit at 5 m |
| Weber formula | V6: ρv²L/σ | V1: vel²×thickness | Dimensionally correct |
| Crest detection | V6 EMA + ping-pong | Single-frame | Reduces flicker (Gem 2) |

## XVII.D Source Attribution

| Concept | Primary Source |
|---------|---------------|
| One Sentence, Three Tests | All V1–V9 (100% consensus) |
| C1–C10 | All V1–V9 (C11/C12: V6 only) |
| Ride window forces (Gem 1) | V1, V6, V8 |
| EMA crest + ping-pong (Gem 2) | V6 |
| Coupling triple safety (Gem 3) | V6 |
| Manual bilinear (Gem 4) | V9 |
| Shared optics (Gem 5) | V7 |
| Scope exclusions (Gem 6) | V7 |
| Velocity packing fix | GPT 5.2 Contradiction C |
| R3F async gl factory | GPT 5.2 Contradiction B |
| Gates system | HyperRealOcean v1 + V8 orchestration |
| Weber correction | V6 Changelog |
| Governor degrade order | V9 bug callout |
| Consolidated spine | GPT 5.2 §K.9 |
| Sprint schedule | V2 (time/cost realism) |

## XVII.E Cross-Reference Matrix

| Phenomenon | Pass | Constraint | Gate | Gem |
|------------|------|------------|------|-----|
| Crest detection | P02 | C5 | W1 | 2 |
| Foam advection | P03 | C6 | W2 | — |
| Particle spawn | P04 | C5, C10 | 2.5, 2.6 | — |
| Ride window | P04 | C10 | **2.7** | **1** |
| Phase transitions | P04 | — | 2.8 | — |
| Seam elimination | R01+R02 | — | 3.0 | **5** |
| Coupling | P05 | C10 | 3.1 | **3** |
| Off-grid sampling | P04 | — | — | **4** |
| Scope control | — | — | — | **6** |
| Performance | Governor | C3, C4 | 4.0 | — |

## XVII.F Agent Orchestration Protocol

### Roles

- **Agent:** Writes code. Reads this spec. Implements gates.
- **Braden (User):** Runs builds. Evaluates visually. Final call on "does this look like water?"
- **This Document:** The spec. All technical decisions defer here. All visual decisions defer to Braden.

### Per-Gate Protocol

```
1. Agent reads spec section for current gate
2. Agent implements deliverables
3. Agent runs validation scene
4. Braden evaluates visually
5. Fail → Agent adjusts one param at a time → goto 3
6. Pass → Mark gate complete → Advance
```

### Gate Handoff Packet

```
Gate:           [ID]
Status:         [IN PROGRESS / COMPLETE]
Prerequisites:  [completed gates]
Deliverables:   [numbered list]
Validation:     [scene name]
Pass Condition: [one sentence from §XI.2]
Key Files:      [list]
```

---

> *This document is the single source of truth for the ProFlow HyperReal Ocean system.*
>
> *All implementation decisions defer to this spec.*
> *All visual decisions defer to Braden.*
> *WebGPU is the engine.*
> *The crest becomes a sheet.*
> ***One water.***