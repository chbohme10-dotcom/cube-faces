/**
 * SDFWaterScene — Hybrid Multi-Regime Volumetric Ocean
 *
 * Architecture:
 * 1. Gerstner heightfield (attached surface regime)
 * 2. Polarized energy heatmap (surface intent fields: R, U, C, M)
 * 3. MLS-MPM particle solver (detached volumetric regime)
 * 4. SDF metaball rendering of particles with velocity-stretch (sheet/ribbon/droplet)
 * 5. Smooth-minimum blending of particle SDF with ocean heightfield
 * 6. Regime-aware shading (dense→sheet, stretched→filament, isolated→droplet)
 * 7. Reabsorption (particles re-enter ocean surface)
 *
 * The particle representation naturally emerges from physics:
 * - Dense clusters → sheets (smin blending merges them)
 * - Fast elongated motion → ribbons/filaments
 * - Isolated particles → droplets
 * No explicit regime assignment needed — geometry emerges from MLS-MPM dynamics.
 */

import { useRef, useMemo, useCallback, useEffect } from "react";
import { Canvas, useFrame, useThree, ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { MLSMPMSolver, MAX_PARTICLES } from "@/lib/mlsMpmCPU";

const MAX_SPLASHES = 8;
const MAX_MPM_SHADER = 256; // Max particles queried per ray step

// ─── Shader sources ───

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uCamPos;
uniform mat4 uInvProjView;

// Artist controls
uniform float uWaveScale;
uniform float uTimeScale;
uniform float uChoppiness;
uniform float uClarity;
uniform float uSunHeight;
uniform float uTurbulence;

// Splash ripple system
uniform vec4 uSplashes[${MAX_SPLASHES}];
uniform int uSplashCount;

// MLS-MPM particle data (DataTexture: width=512, height=3)
uniform sampler2D uMpmTex;
uniform int uMpmCount;
uniform vec3 uMpmBoundsMin;
uniform vec3 uMpmBoundsMax;

// Visualization mode
uniform int uVizMode;

#define PI 3.14159265359
#define TAU 6.28318530718
#define MAX_STEPS 128
#define MAX_DIST 250.0

// ─── Wave helpers ───

float gW(vec2 p, float t, float A, float wl, vec2 d, float spd, float ph) {
  float k = TAU / wl;
  return A * cos(k * dot(d, p) - k * spd * t + ph);
}

vec2 gG(vec2 p, float t, float A, float wl, vec2 d, float spd, float ph) {
  float k = TAU / wl;
  return -A * k * sin(k * dot(d, p) - k * spd * t + ph) * d;
}

float gJ(vec2 p, float t, float A, float wl, vec2 d, float spd, float ph, float st) {
  float k = TAU / wl;
  return st * A * k * cos(k * dot(d, p) - k * spd * t + ph);
}

// ─── Splash ripples (2D heightfield perturbation) ───
float splashHeight(vec2 p, float t) {
  float h = 0.0;
  for (int i = 0; i < ${MAX_SPLASHES}; i++) {
    if (i >= uSplashCount) break;
    vec4 sp = uSplashes[i];
    float age = t - sp.z;
    if (age < 0.0 || age > 12.0) continue;
    float dist = length(p - sp.xy);
    float decay = exp(-age * 0.35) * exp(-dist * 0.015);
    float speed = 8.0;
    float phase = dist - speed * age;
    float ripple = sin(phase * 0.8) + sin(phase * 1.6 + 0.5) * 0.4 + sin(phase * 3.2 + 1.0) * 0.15;
    float envelope = smoothstep(speed * age + 2.0, speed * age - 1.0, dist) * smoothstep(0.0, 0.5, age);
    h += sp.w * ripple * decay * envelope;
    h += -sp.w * 1.5 * exp(-age * 2.5) * exp(-dist * dist / (sp.w * sp.w * 3.0));
  }
  return h;
}

vec2 splashGradient(vec2 p, float t) {
  float eps = 0.3;
  return vec2(
    splashHeight(p + vec2(eps, 0.0), t) - splashHeight(p - vec2(eps, 0.0), t),
    splashHeight(p + vec2(0.0, eps), t) - splashHeight(p - vec2(0.0, eps), t)
  ) / (2.0 * eps);
}

// ─── Smooth minimum ───
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * h * k * (1.0 / 6.0);
}

// ─── MLS-MPM Particle SDF ───
// Reads particle data from DataTexture, computes metaball field
// with velocity-aligned stretching for organic sheet/ribbon/droplet shapes.
float sdfMpmParticles(vec3 p) {
  if (uMpmCount <= 0) return 999.0;

  // Broad-phase bounding box rejection
  vec3 margin = vec3(2.0);
  if (p.x < uMpmBoundsMin.x - margin.x || p.x > uMpmBoundsMax.x + margin.x ||
      p.y < uMpmBoundsMin.y - margin.y || p.y > uMpmBoundsMax.y + margin.y ||
      p.z < uMpmBoundsMin.z - margin.z || p.z > uMpmBoundsMax.z + margin.z) {
    return 999.0;
  }

  float d = 999.0;
  int count = min(uMpmCount, ${MAX_MPM_SHADER});

  for (int i = 0; i < ${MAX_MPM_SHADER}; i++) {
    if (i >= count) break;

    // texelFetch from DataTexture (width=MAX_PARTICLES, height=3)
    vec4 posR = texelFetch(uMpmTex, ivec2(i, 0), 0);
    vec4 velD = texelFetch(uMpmTex, ivec2(i, 1), 0);
    vec4 meta = texelFetch(uMpmTex, ivec2(i, 2), 0);

    vec3 pp = posR.xyz;
    float radius = posR.w;
    vec3 vel = velD.xyz;
    float density = velD.w;
    float age = meta.x;
    float regime = meta.y;

    // Quick distance rejection per particle
    vec3 diff = p - pp;
    float roughDist = length(diff);
    if (roughDist > radius * 8.0) continue;

    float speed = length(vel);
    float pd;

    if (speed > 1.0) {
      // Velocity-aligned ellipsoid → creates ribbons and stretched sheets
      vec3 dir = vel / speed;
      float along = dot(diff, dir);
      float perp = length(diff - along * dir);

      // Stretch increases with speed: fast = long ribbon, slow = round droplet
      float stretch = 1.0 + min(4.0, speed * 0.12);

      // Sheet regime: flatten perpendicular to velocity for thin sheet appearance
      if (regime < 0.5 && density > 2.0) {
        stretch *= 1.5; // More elongated in sheet mode
        radius *= 1.2;  // Slightly larger for sheet connectivity
      }

      pd = length(vec2(perp, along / stretch)) - radius;
    } else {
      pd = roughDist - radius;
    }

    // Blend radius depends on regime: sheets blend widely, droplets blend tightly
    float blendK = regime < 0.5 ? 0.6 : regime < 1.5 ? 0.4 : 0.2;
    d = smin(d, pd, blendK);

    // Early exit if we're clearly inside the surface
    if (d < -0.5) break;
  }

  return d;
}

// ─── Surface Intent Fields (Polarized Energy Heatmap) ───
// Computes rupture potential R from wave Jacobian, slope, and vertical velocity.
// This drives automatic particle spawning on the CPU side.
float rupturePotential(vec2 p, float t) {
  float s = uWaveScale;
  float ts = t * uTimeScale;

  // Jacobian-based folding (same as foam detection)
  float j = 1.0;
  float c = uChoppiness;
  j -= gJ(p, ts, 1.2*s, 60.0, vec2(0.8,0.6), 8.0, 0.0, 0.4*c);
  j -= gJ(p, ts, 0.9*s, 42.0, vec2(-0.447,0.894), 6.5, 1.5, 0.35*c);
  j -= gJ(p, ts, 0.6*s, 26.0, vec2(0.3,-0.95), 5.2, 0.7, 0.5*c);
  j -= gJ(p, ts, 0.4*s, 16.0, vec2(-0.9,-0.44), 4.0, 2.1, 0.45*c);
  float folding = smoothstep(0.0, -0.4, j);

  // Slope severity
  vec2 grad = vec2(0.0);
  grad += gG(p, ts, 1.2*s, 60.0, vec2(0.8,0.6), 8.0, 0.0);
  grad += gG(p, ts, 0.9*s, 42.0, vec2(-0.447,0.894), 6.5, 1.5);
  grad += gG(p, ts, 0.6*s, 26.0, vec2(0.3,-0.95), 5.2, 0.7);
  float slope = length(grad);

  // Vertical velocity (finite difference)
  float h0 = gW(p, ts, 1.2*s, 60.0, vec2(0.8,0.6), 8.0, 0.0)
            + gW(p, ts, 0.9*s, 42.0, vec2(-0.447,0.894), 6.5, 1.5)
            + gW(p, ts, 0.8*s, 80.0, vec2(0.0,1.0), 10.0, 4.0);
  float h1 = gW(p, ts - 0.05*uTimeScale, 1.2*s, 60.0, vec2(0.8,0.6), 8.0, 0.0)
            + gW(p, ts - 0.05*uTimeScale, 0.9*s, 42.0, vec2(-0.447,0.894), 6.5, 1.5)
            + gW(p, ts - 0.05*uTimeScale, 0.8*s, 80.0, vec2(0.0,1.0), 10.0, 4.0);
  float vUp = max(0.0, (h0 - h1) / 0.05);

  // Composite rupture potential
  return folding * 0.4 + slope * 0.25 + vUp * 0.35;
}

// Surface momentum direction (horizontal transport from wave gradients)
vec2 surfaceMomentum(vec2 p, float t) {
  float s = uWaveScale;
  float ts = t * uTimeScale;
  vec2 u = vec2(0.0);
  // Weight by amplitude * frequency for momentum contribution
  u += gG(p, ts, 1.2*s, 60.0, vec2(0.8,0.6), 8.0, 0.0) * 8.0;
  u += gG(p, ts, 0.9*s, 42.0, vec2(-0.447,0.894), 6.5, 1.5) * 6.5;
  u += gG(p, ts, 0.6*s, 26.0, vec2(0.3,-0.95), 5.2, 0.7) * 5.2;
  return u;
}

// ─── 8-component Gerstner spectrum with LOD ───

float oceanHeight(vec2 p, float t, float dist) {
  float s = uWaveScale;
  float ts = t * uTimeScale;
  float h = 0.0;
  h += gW(p, ts, 1.2*s, 60.0, vec2(0.8,0.6), 8.0, 0.0);
  h += gW(p, ts, 0.9*s, 42.0, vec2(-0.447,0.894), 6.5, 1.5);
  h += gW(p, ts, 0.8*s, 80.0, vec2(0.0,1.0), 10.0, 4.0);
  if (dist < 120.0) {
    h += gW(p, ts, 0.6*s, 26.0, vec2(0.3,-0.95), 5.2, 0.7);
    h += gW(p, ts, 0.4*s, 16.0, vec2(-0.9,-0.44), 4.0, 2.1);
    h += gW(p, ts, 0.3*s, 13.0, vec2(0.95,-0.3), 3.5, 1.8);
  }
  if (dist < 50.0) {
    h += gW(p, ts, 0.25*s, 8.5, vec2(0.6,-0.8), 3.2, 3.3);
    h += gW(p, ts, 0.15*s, 5.5, vec2(-0.7,0.7), 2.5, 5.2);
  }
  h += splashHeight(p, t);
  return h;
}

float oceanHeightFull(vec2 p, float t) {
  float s = uWaveScale;
  float ts = t * uTimeScale;
  float h = 0.0;
  h += gW(p, ts, 1.2*s, 60.0, vec2(0.8,0.6), 8.0, 0.0);
  h += gW(p, ts, 0.9*s, 42.0, vec2(-0.447,0.894), 6.5, 1.5);
  h += gW(p, ts, 0.8*s, 80.0, vec2(0.0,1.0), 10.0, 4.0);
  h += gW(p, ts, 0.6*s, 26.0, vec2(0.3,-0.95), 5.2, 0.7);
  h += gW(p, ts, 0.4*s, 16.0, vec2(-0.9,-0.44), 4.0, 2.1);
  h += gW(p, ts, 0.3*s, 13.0, vec2(0.95,-0.3), 3.5, 1.8);
  h += gW(p, ts, 0.25*s, 8.5, vec2(0.6,-0.8), 3.2, 3.3);
  h += gW(p, ts, 0.15*s, 5.5, vec2(-0.7,0.7), 2.5, 5.2);
  h += splashHeight(p, t);
  return h;
}

vec3 oceanNormal(vec2 p, float t) {
  float s = uWaveScale;
  float ts = t * uTimeScale;
  vec2 g = vec2(0.0);
  g += gG(p, ts, 1.2*s, 60.0, vec2(0.8,0.6), 8.0, 0.0);
  g += gG(p, ts, 0.9*s, 42.0, vec2(-0.447,0.894), 6.5, 1.5);
  g += gG(p, ts, 0.8*s, 80.0, vec2(0.0,1.0), 10.0, 4.0);
  g += gG(p, ts, 0.6*s, 26.0, vec2(0.3,-0.95), 5.2, 0.7);
  g += gG(p, ts, 0.4*s, 16.0, vec2(-0.9,-0.44), 4.0, 2.1);
  g += gG(p, ts, 0.3*s, 13.0, vec2(0.95,-0.3), 3.5, 1.8);
  g += gG(p, ts, 0.25*s, 8.5, vec2(0.6,-0.8), 3.2, 3.3);
  g += gG(p, ts, 0.15*s, 5.5, vec2(-0.7,0.7), 2.5, 5.2);
  g += splashGradient(p, t);
  return normalize(vec3(-g.x, 1.0, -g.y));
}

float oceanFoam(vec2 p, float t) {
  float s = uWaveScale;
  float ts = t * uTimeScale;
  float c = uChoppiness;
  float j = 1.0;
  j -= gJ(p, ts, 1.2*s, 60.0, vec2(0.8,0.6), 8.0, 0.0, 0.4*c);
  j -= gJ(p, ts, 0.9*s, 42.0, vec2(-0.447,0.894), 6.5, 1.5, 0.35*c);
  j -= gJ(p, ts, 0.6*s, 26.0, vec2(0.3,-0.95), 5.2, 0.7, 0.5*c);
  j -= gJ(p, ts, 0.4*s, 16.0, vec2(-0.9,-0.44), 4.0, 2.1, 0.45*c);
  j -= gJ(p, ts, 0.25*s, 8.5, vec2(0.6,-0.8), 3.2, 3.3, 0.35*c);
  j -= gJ(p, ts, 0.8*s, 80.0, vec2(0.0,1.0), 10.0, 4.0, 0.2*c);
  j -= gJ(p, ts, 0.15*s, 5.5, vec2(-0.7,0.7), 2.5, 5.2, 0.3*c);
  j -= gJ(p, ts, 0.3*s, 13.0, vec2(0.95,-0.3), 3.5, 1.8, 0.4*c);

  float sf = 0.0;
  for (int i = 0; i < ${MAX_SPLASHES}; i++) {
    if (i >= uSplashCount) break;
    vec4 sp = uSplashes[i];
    float age = uTime - sp.z;
    if (age < 0.0 || age > 8.0) continue;
    float dist = length(p - sp.xy);
    float ring = abs(dist - 8.0 * age);
    sf += sp.w * 0.3 * exp(-age * 0.5) * exp(-ring * 0.5) * smoothstep(0.0, 0.3, age);
  }

  return smoothstep(0.0, -0.35, j) + sf;
}

// ─── Scene SDF: ocean heightfield + MLS-MPM particles ───
float sdfOcean(vec3 p, float dist) {
  return p.y - oceanHeight(p.xz, uTime, dist);
}

float sdfScene(vec3 p, float dist) {
  float ocean = sdfOcean(p, dist);
  float particles = sdfMpmParticles(p);
  // Smooth blend: particles merge organically into ocean surface
  return smin(ocean, particles, 0.5);
}

// ─── Normals ───
vec3 calcNormal3D(vec3 p, float dist) {
  float e = 0.1;
  return normalize(vec3(
    sdfScene(p + vec3(e,0,0), dist) - sdfScene(p - vec3(e,0,0), dist),
    sdfScene(p + vec3(0,e,0), dist) - sdfScene(p - vec3(0,e,0), dist),
    sdfScene(p + vec3(0,0,e), dist) - sdfScene(p - vec3(0,0,e), dist)
  ));
}

vec3 getHitNormal(vec3 p, float dist) {
  float particleDist = sdfMpmParticles(p);
  if (particleDist < 1.5) {
    return calcNormal3D(p, dist);
  }
  return oceanNormal(p.xz, uTime);
}

// ─── Sky ───
vec3 getSunDir() {
  return normalize(vec3(0.8, max(0.05, uSunHeight), -0.6));
}

vec3 sky(vec3 rd) {
  vec3 sunDir = getSunDir();
  float sunDot = max(0.0, dot(rd, sunDir));
  float g = max(0.0, rd.y);
  vec3 zenith = vec3(0.12, 0.28, 0.58);
  vec3 horizon = vec3(0.55, 0.65, 0.78);
  float sunElev = sunDir.y;
  vec3 warmHorizon = mix(vec3(0.8, 0.45, 0.2), horizon, smoothstep(0.0, 0.5, sunElev));
  vec3 col = mix(warmHorizon, zenith, pow(g, 0.45));
  if (rd.y < 0.0) col = mix(warmHorizon * 0.3, col, exp(rd.y * 8.0));
  col += vec3(1.0, 0.95, 0.85) * pow(sunDot, 700.0) * 6.0;
  col += vec3(1.0, 0.85, 0.6) * pow(sunDot, 40.0) * 0.5;
  col += vec3(1.0, 0.7, 0.4) * pow(sunDot, 8.0) * 0.15;
  return col;
}

// ─── Caustics ───
float caustics(vec3 p) {
  vec2 uv = p.xz * 0.12;
  float t = uTime * uTimeScale * 0.35;
  float c = 0.0;
  c += max(0.0, sin(uv.x * 3.1 + t * 1.1) * sin(uv.y * 3.7 - t * 0.8));
  c += max(0.0, sin(uv.x * 5.3 - t * 1.3 + 1.0) * sin(uv.y * 4.1 + t * 0.9 + 2.0)) * 0.5;
  c += max(0.0, sin(uv.x * 7.7 + t * 0.5 + 3.0) * sin(uv.y * 6.3 - t * 1.2 + 1.5)) * 0.25;
  return c * c;
}

// ─── Noise ───
float hash31(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i+vec3(1,0,0)), f.x),
        mix(hash31(i+vec3(0,1,0)), hash31(i+vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i+vec3(0,0,1)), hash31(i+vec3(1,0,1)), f.x),
        mix(hash31(i+vec3(0,1,1)), hash31(i+vec3(1,1,1)), f.x), f.y),
    f.z
  );
}

float turbulenceField(vec3 p) {
  float t = 0.0, a = 1.0, f = 0.3;
  for (int i = 0; i < 4; i++) { t += a * noise3(p * f + uTime * 0.25); a *= 0.5; f *= 2.0; }
  return t;
}

float fresnel(float cosT) {
  return 0.02 + 0.98 * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
}

// ─── Adaptive raymarch ───
float raymarch(vec3 ro, vec3 rd) {
  float t = 0.1;
  float lastD = 100.0, lastT = 0.0;

  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = sdfScene(p, t);
    if (d < 0.005) {
      t = lastT + (t - lastT) * lastD / (lastD - d + 0.0001);
      break;
    }
    lastD = d; lastT = t;
    t += max(d * 0.45, 0.08 + t * 0.0025);
    if (t > MAX_DIST) break;
  }
  return t;
}

// ─── Main ───
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 worldFar = uInvProjView * vec4(ndc, 1.0, 1.0);
  worldFar /= worldFar.w;
  vec4 worldNear = uInvProjView * vec4(ndc, -1.0, 1.0);
  worldNear /= worldNear.w;

  vec3 ro = uCamPos;
  vec3 rd = normalize(worldFar.xyz - worldNear.xyz);
  vec3 sunDir = getSunDir();
  float camH = oceanHeightFull(ro.xz, uTime);
  bool underwater = ro.y < camH;

  // ─── SDF Visualization Mode: Polarized Energy Heatmap ───
  if (uVizMode == 1) {
    float tHit = raymarch(ro, rd);
    vec3 color;

    if (tHit < MAX_DIST) {
      vec3 p = ro + rd * tHit;
      vec3 n = getHitNormal(p, tHit);

      // Base height coloring
      float h = oceanHeightFull(p.xz, uTime);
      float hNorm = clamp(h * 0.15 + 0.5, 0.0, 1.0);
      vec3 lowCol = vec3(0.05, 0.12, 0.5);
      vec3 midCol = vec3(0.08, 0.4, 0.35);
      vec3 highCol = vec3(0.85, 0.9, 1.0);
      color = hNorm < 0.5 ? mix(lowCol, midCol, hNorm * 2.0) : mix(midCol, highCol, (hNorm - 0.5) * 2.0);

      // ─── Polarized Energy Heatmap Overlay ───
      float R = rupturePotential(p.xz, uTime);
      vec2 U = surfaceMomentum(p.xz, uTime);
      float Umag = length(U);

      // Rupture potential: blue → cyan → yellow → red → white
      vec3 heatCol;
      if (R < 0.25) heatCol = mix(vec3(0.0, 0.0, 0.3), vec3(0.0, 0.5, 0.7), R * 4.0);
      else if (R < 0.5) heatCol = mix(vec3(0.0, 0.5, 0.7), vec3(0.8, 0.8, 0.0), (R - 0.25) * 4.0);
      else if (R < 0.75) heatCol = mix(vec3(0.8, 0.8, 0.0), vec3(1.0, 0.2, 0.0), (R - 0.5) * 4.0);
      else heatCol = mix(vec3(1.0, 0.2, 0.0), vec3(1.0, 1.0, 1.0), (R - 0.75) * 4.0);

      color = mix(color, heatCol, smoothstep(0.05, 0.3, R) * 0.7);

      // Surface momentum direction arrows (via pattern)
      if (Umag > 0.5) {
        vec2 Udir = U / Umag;
        float arrow = dot(normalize(p.xz), Udir);
        float arrowPattern = smoothstep(0.8, 1.0, abs(fract(dot(p.xz, Udir) * 0.3) - 0.5) * 2.0);
        color += vec3(0.0, 0.6, 1.0) * arrowPattern * smoothstep(0.5, 3.0, Umag) * 0.3;
      }

      // MLS-MPM particle proximity glow
      float pDist = sdfMpmParticles(p);
      if (pDist < 2.0) {
        float glow = 1.0 - smoothstep(0.0, 2.0, pDist);
        color = mix(color, vec3(1.0, 0.5, 0.0), glow * 0.6);
      }

      // Iso-lines
      float isoLine = 1.0 - smoothstep(0.0, 0.06, abs(fract(h * 0.5) - 0.5) * 2.0);
      color = mix(color, vec3(1.0), isoLine * 0.3);

      // Lighting
      float NdotL = max(0.0, dot(n, sunDir));
      color *= 0.4 + 0.6 * NdotL;

      // Fog
      float fog = 1.0 - exp(-tHit * 0.006);
      color = mix(color, vec3(0.12, 0.15, 0.22), fog);
    } else {
      color = sky(rd) * 0.5;
    }

    color = pow(clamp(color, 0.0, 1.0), vec3(0.4545));
    gl_FragColor = vec4(color, 1.0);
    return;
  }

  // ─── Realistic Mode ───
  float t = raymarch(ro, rd);
  vec3 color;

  if (t < MAX_DIST) {
    vec3 p = ro + rd * t;
    vec3 n = getHitNormal(p, t);
    if (underwater) n = -n;

    vec3 v = -rd;
    float NdotV = max(0.001, dot(n, v));
    float F = fresnel(NdotV);

    vec3 reflDir = reflect(rd, n);
    vec3 refl = sky(reflDir);
    vec3 halfV = normalize(sunDir + v);
    float NdotH = max(0.0, dot(n, halfV));
    refl += vec3(1.0, 0.95, 0.85) * pow(NdotH, 350.0) * 4.0;

    vec3 absCoeff = vec3(0.42, 0.088, 0.038) * (2.0 - uClarity);
    float viewDepth = max(0.3, t * max(0.01, abs(rd.y)) * 1.5);
    vec3 waterAbs = exp(-absCoeff * viewDepth);

    vec3 refrDir = refract(rd, n, 0.75);
    float sss = pow(max(0.0, dot(sunDir, -refrDir)), 5.0) * 0.45;
    vec3 sssCol = vec3(0.04, 0.28, 0.18) * sss * waterAbs;

    vec3 deepCol = vec3(0.008, 0.035, 0.07);
    vec3 scatterCol = vec3(0.02, 0.08, 0.12);
    vec3 waterCol = deepCol + scatterCol * waterAbs + sssCol;

    float caustVal = caustics(p) * waterAbs.g * 0.35 * uClarity;
    waterCol += vec3(0.04, 0.14, 0.1) * caustVal;

    if (uTurbulence > 0.01) {
      float te = turbulenceField(p * 0.12) * uTurbulence;
      waterCol += vec3(0.0, 0.05, 0.09) * te;
    }

    float foam = oceanFoam(p.xz, uTime);

    // ─── MLS-MPM particle regime shading ───
    float pDist = sdfMpmParticles(p);
    float particleInfluence = 1.0 - smoothstep(0.0, 1.0, pDist);

    if (particleInfluence > 0.01) {
      // Particle-dominated shading: whiter, more reflective (spray/sheet appearance)
      vec3 sprayCol = mix(waterCol, vec3(0.75, 0.82, 0.88), particleInfluence * 0.6);
      // Thin sheet/film scattering
      float thinFilm = exp(-max(0.0, pDist) * 3.0) * 0.3;
      sprayCol += vec3(0.15, 0.2, 0.22) * thinFilm;
      // Enhanced foam where particles meet ocean surface
      foam = max(foam, particleInfluence * 0.6 * exp(-pDist * 2.0));
      waterCol = sprayCol;
    }

    vec3 foamCol = vec3(0.82, 0.88, 0.93) * foam;

    if (underwater) {
      color = waterCol * 1.5 + refl * F * 0.3;
    } else {
      color = mix(waterCol, refl, F);
      color += foamCol * (1.0 - F * 0.3);
    }

    float fog = 1.0 - exp(-t * 0.0035);
    vec3 fogCol = sky(rd) * 0.65;
    color = mix(color, fogCol, fog);
  } else {
    color = sky(rd);
  }

  if (underwater) {
    float uwDepth = camH - ro.y;
    vec3 uwAbs = exp(-vec3(0.42, 0.088, 0.038) * uwDepth * 0.5);
    color *= uwAbs;
    color += vec3(0.02, 0.06, 0.04) * caustics(ro + rd * min(t, 20.0)) * uwAbs.g;
    float godRay = pow(max(0.0, dot(rd, sunDir)), 3.0) * 0.15;
    color += vec3(0.03, 0.1, 0.08) * godRay * uwAbs;
  }

  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  color = pow(clamp(color, 0.0, 1.0), vec3(0.4545));

  gl_FragColor = vec4(color, 1.0);
}
`;

// ─── R3F Scene Components ───

export interface SDFWaterParams {
  waveScale: number;
  timeScale: number;
  choppiness: number;
  clarity: number;
  sunHeight: number;
  turbulence: number;
}

export interface SplashData {
  x: number;
  z: number;
  time: number;
  amplitude: number;
}

const DEFAULT_PARAMS: SDFWaterParams = {
  waveScale: 1.0,
  timeScale: 1.0,
  choppiness: 0.7,
  clarity: 0.8,
  sunHeight: 0.35,
  turbulence: 0.3,
};

/**
 * Helpers for intent-field computation.
 */
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function cpuSplashHeight(x: number, z: number, time: number, splashes: SplashData[] = []): number {
  let h = 0;

  for (const sp of splashes) {
    const age = time - sp.time;
    if (age < 0 || age > 12) continue;

    const dx = x - sp.x;
    const dz = z - sp.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const decay = Math.exp(-age * 0.35) * Math.exp(-dist * 0.015);
    const speed = 8.0;
    const phase = dist - speed * age;
    const ripple = Math.sin(phase * 0.8) + Math.sin(phase * 1.6 + 0.5) * 0.4 + Math.sin(phase * 3.2 + 1.0) * 0.15;
    const envelope =
      (1 - clamp01((dist - (speed * age - 1.0)) / 3.0)) *
      clamp01(age / 0.5);

    h += sp.amplitude * ripple * decay * envelope;
    h += -sp.amplitude * 1.5 * Math.exp(-age * 2.5) * Math.exp(-(dist * dist) / (sp.amplitude * sp.amplitude * 3.0));
  }

  return h;
}

function cpuSplashGradient(x: number, z: number, time: number, splashes: SplashData[] = []): [number, number] {
  const eps = 0.3;
  const gx =
    (cpuSplashHeight(x + eps, z, time, splashes) - cpuSplashHeight(x - eps, z, time, splashes)) /
    (2 * eps);
  const gz =
    (cpuSplashHeight(x, z + eps, time, splashes) - cpuSplashHeight(x, z - eps, time, splashes)) /
    (2 * eps);
  return [gx, gz];
}

/**
 * Evaluate Gerstner height on CPU (mirrors shader oceanHeightFull) with splash injection.
 * Used by MLS-MPM solver for reabsorption checks and surface intent fields.
 */
function cpuOceanHeight(
  x: number,
  z: number,
  time: number,
  params: SDFWaterParams,
  splashes: SplashData[] = []
): number {
  const s = params.waveScale;
  const ts = time * params.timeScale;
  const TAU = Math.PI * 2;

  const gW = (px: number, pz: number, t: number, A: number, wl: number, dx: number, dz: number, spd: number, ph: number) => {
    const k = TAU / wl;
    return A * Math.cos(k * (dx * px + dz * pz) - k * spd * t + ph);
  };

  let h = 0;
  h += gW(x, z, ts, 1.2 * s, 60, 0.8, 0.6, 8, 0);
  h += gW(x, z, ts, 0.9 * s, 42, -0.447, 0.894, 6.5, 1.5);
  h += gW(x, z, ts, 0.8 * s, 80, 0, 1, 10, 4);
  h += gW(x, z, ts, 0.6 * s, 26, 0.3, -0.95, 5.2, 0.7);
  h += gW(x, z, ts, 0.4 * s, 16, -0.9, -0.44, 4, 2.1);
  h += gW(x, z, ts, 0.3 * s, 13, 0.95, -0.3, 3.5, 1.8);
  h += gW(x, z, ts, 0.25 * s, 8.5, 0.6, -0.8, 3.2, 3.3);
  h += gW(x, z, ts, 0.15 * s, 5.5, -0.7, 0.7, 2.5, 5.2);
  h += cpuSplashHeight(x, z, time, splashes);
  return h;
}

/**
 * CPU surface momentum direction for particle launch orientation.
 */
function cpuSurfaceMomentum(
  x: number,
  z: number,
  time: number,
  params: SDFWaterParams,
  splashes: SplashData[] = []
): [number, number] {
  const s = params.waveScale;
  const ts = time * params.timeScale;
  const TAU = Math.PI * 2;

  const gG = (px: number, pz: number, t: number, A: number, wl: number, dx: number, dz: number, spd: number, ph: number) => {
    const k = TAU / wl;
    const val = -A * k * Math.sin(k * (dx * px + dz * pz) - k * spd * t + ph);
    return [val * dx * spd, val * dz * spd] as [number, number];
  };

  let ux = 0;
  let uz = 0;

  const components = [
    { A: 1.2 * s, wl: 60, dx: 0.8, dz: 0.6, spd: 8, ph: 0 },
    { A: 0.9 * s, wl: 42, dx: -0.447, dz: 0.894, spd: 6.5, ph: 1.5 },
    { A: 0.6 * s, wl: 26, dx: 0.3, dz: -0.95, spd: 5.2, ph: 0.7 },
  ];

  for (const comp of components) {
    const g = gG(x, z, ts, comp.A, comp.wl, comp.dx, comp.dz, comp.spd, comp.ph);
    ux += g[0];
    uz += g[1];
  }

  const splashGrad = cpuSplashGradient(x, z, time, splashes);
  ux += splashGrad[0] * 6.5;
  uz += splashGrad[1] * 6.5;

  return [ux, uz];
}

function cpuCoherence(
  x: number,
  z: number,
  time: number,
  params: SDFWaterParams,
  splashes: SplashData[] = []
): number {
  const eps = 0.8;
  const h0 = cpuOceanHeight(x, z, time, params, splashes);
  const hxp = cpuOceanHeight(x + eps, z, time, params, splashes);
  const hxn = cpuOceanHeight(x - eps, z, time, params, splashes);
  const hzp = cpuOceanHeight(x, z + eps, time, params, splashes);
  const hzn = cpuOceanHeight(x, z - eps, time, params, splashes);

  const laplacian = Math.abs(hxp + hxn + hzp + hzn - 4 * h0) / (eps * eps);
  const gx = (hxp - hxn) / (2 * eps);
  const gz = (hzp - hzn) / (2 * eps);
  const slope = Math.hypot(gx, gz);

  const [ux, uz] = cpuSurfaceMomentum(x, z, time, params, splashes);
  const umag = Math.hypot(ux, uz);

  const crestness = clamp01(laplacian * 0.22);
  const ridge = clamp01((slope - 0.05) * 2.0);
  const directionality = clamp01(umag * 0.08);

  return clamp01(crestness * 0.5 + ridge * 0.3 + directionality * 0.2);
}

/**
 * Compute rupture potential on CPU (mirrors shader intent philosophy).
 */
function cpuRupturePotential(
  x: number,
  z: number,
  time: number,
  params: SDFWaterParams,
  splashes: SplashData[] = []
): number {
  const s = params.waveScale;
  const ts = time * params.timeScale;
  const c = params.choppiness;
  const TAU = Math.PI * 2;

  const gJ = (px: number, pz: number, t: number, A: number, wl: number, dx: number, dz: number, spd: number, ph: number, st: number) => {
    const k = TAU / wl;
    return st * A * k * Math.cos(k * (dx * px + dz * pz) - k * spd * t + ph);
  };

  let j = 1;
  j -= gJ(x, z, ts, 1.2 * s, 60, 0.8, 0.6, 8, 0, 0.4 * c);
  j -= gJ(x, z, ts, 0.9 * s, 42, -0.447, 0.894, 6.5, 1.5, 0.35 * c);
  j -= gJ(x, z, ts, 0.6 * s, 26, 0.3, -0.95, 5.2, 0.7, 0.5 * c);
  j -= gJ(x, z, ts, 0.4 * s, 16, -0.9, -0.44, 4, 2.1, 0.45 * c);
  const folding = j < 0 ? Math.min(1, -j / 0.4) : 0;

  const eps = 0.6;
  const gx =
    (cpuOceanHeight(x + eps, z, time, params, splashes) -
      cpuOceanHeight(x - eps, z, time, params, splashes)) /
    (2 * eps);
  const gz =
    (cpuOceanHeight(x, z + eps, time, params, splashes) -
      cpuOceanHeight(x, z - eps, time, params, splashes)) /
    (2 * eps);
  const slope = Math.hypot(gx, gz);

  const h0 = cpuOceanHeight(x, z, time, params, splashes);
  const h1 = cpuOceanHeight(x, z, time - 0.04, params, splashes);
  const vUp = Math.max(0, (h0 - h1) / 0.04);

  const [ux, uz] = cpuSurfaceMomentum(x, z, time, params, splashes);
  const umag = Math.hypot(ux, uz);
  const coherence = cpuCoherence(x, z, time, params, splashes);

  let splashMemory = 0;
  for (const sp of splashes) {
    const age = time - sp.time;
    if (age < 0 || age > 3.2) continue;
    const dist = Math.hypot(x - sp.x, z - sp.z);
    const ring = Math.abs(dist - 8 * age);
    splashMemory += sp.amplitude * Math.exp(-age * 0.55) * Math.exp(-ring * 0.65);
  }

  const Rraw =
    folding * 0.32 +
    slope * 0.16 +
    vUp * 0.2 +
    Math.min(1, umag * 0.08) * 0.15 +
    coherence * 0.12 +
    Math.min(1.1, splashMemory * 0.45) * 0.22;

  return clamp01(Rraw);
}

interface RupturePatch {
  key: string;
  x: number;
  z: number;
  surfaceH: number;
  ux: number;
  uz: number;
  vUp: number;
  severity: number;
  coherence: number;
  score: number;
}

function gatherRupturePatches(
  time: number,
  params: SDFWaterParams,
  splashes: SplashData[]
): RupturePatch[] {
  const patches = new Map<string, RupturePatch>();
  const keyFor = (x: number, z: number) => `${Math.round(x / 2)},${Math.round(z / 2)}`;

  const addCandidate = (x: number, z: number, bias = 0) => {
    if (x < -30 || x > 30 || z < -30 || z > 30) return;

    const R = cpuRupturePotential(x, z, time, params, splashes);
    if (R < 0.22) return;

    const coherence = cpuCoherence(x, z, time, params, splashes);
    const [ux, uz] = cpuSurfaceMomentum(x, z, time, params, splashes);
    const umag = Math.hypot(ux, uz);
    const surfaceH = cpuOceanHeight(x, z, time, params, splashes);
    const prevH = cpuOceanHeight(x, z, time - 0.03, params, splashes);
    const vUp = Math.max(0, (surfaceH - prevH) / 0.03);

    const severity = clamp01(R * 0.8 + coherence * 0.15 + Math.min(1, umag * 0.08) * 0.2 + bias * 0.2);
    const score = severity * 0.55 + coherence * 0.25 + Math.min(1, umag * 0.08) * 0.2;

    const key = keyFor(x, z);
    const existing = patches.get(key);
    if (!existing || score > existing.score) {
      patches.set(key, {
        key,
        x,
        z,
        surfaceH,
        ux,
        uz,
        vUp,
        severity,
        coherence,
        score,
      });
    }
  };

  for (const sp of splashes) {
    const age = time - sp.time;
    if (age < 0.06 || age > 3.0) continue;

    const radius = 8.0 * age;
    const segments = 12;
    const bias = clamp01(sp.amplitude / 1.5);

    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      addCandidate(sp.x + Math.cos(a) * radius, sp.z + Math.sin(a) * radius, bias);
    }
  }

  for (let gx = -18; gx <= 18; gx += 9) {
    for (let gz = -18; gz <= 18; gz += 9) {
      const driftX = Math.sin(time * 0.35 + gz * 0.15) * 1.2;
      const driftZ = Math.cos(time * 0.3 + gx * 0.12) * 1.2;
      addCandidate(gx + driftX, gz + driftZ, 0);
    }
  }

  return [...patches.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

// ─── Click Plane ───

function ClickPlane({ onClickOcean }: { onClickOcean: (x: number, z: number) => void }) {
  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (e.point) onClickOcean(e.point.x, e.point.z);
    },
    [onClickOcean]
  );

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} onClick={handleClick} visible={false}>
      <planeGeometry args={[500, 500]} />
      <meshBasicMaterial />
    </mesh>
  );
}

// ─── Ocean Shader with MLS-MPM Integration ───

function OceanShader({
  params,
  splashes,
  vizMode,
  mpmSolver,
}: {
  params: SDFWaterParams;
  splashes: SplashData[];
  vizMode: number;
  mpmSolver: MLSMPMSolver;
}) {
  const ref = useRef<THREE.ShaderMaterial>(null);
  const { camera, gl } = useThree();
  const invPV = useMemo(() => new THREE.Matrix4(), []);

  // MLS-MPM DataTexture: width=MAX_PARTICLES, height=3, RGBA float
  const mpmTexData = useRef(new Float32Array(MAX_PARTICLES * 3 * 4));
  const mpmTex = useMemo(() => {
    const tex = new THREE.DataTexture(
      mpmTexData.current,
      MAX_PARTICLES,
      3,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }, []);

  // Auto-spawn tracking
  const lastAutoSpawn = useRef(0);
  const autoSpawnCooldown = 0.25; // seconds between auto-spawn checks — frequent for organic feel

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCamPos: { value: new THREE.Vector3() },
      uInvProjView: { value: new THREE.Matrix4() },
      uWaveScale: { value: params.waveScale },
      uTimeScale: { value: params.timeScale },
      uChoppiness: { value: params.choppiness },
      uClarity: { value: params.clarity },
      uSunHeight: { value: params.sunHeight },
      uTurbulence: { value: params.turbulence },
      uSplashes: { value: [] as THREE.Vector4[] },
      uSplashCount: { value: 0 },
      uMpmTex: { value: mpmTex },
      uMpmCount: { value: 0 },
      uMpmBoundsMin: { value: new THREE.Vector3() },
      uMpmBoundsMax: { value: new THREE.Vector3() },
      uVizMode: { value: 0 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useFrame(({ clock }) => {
    const mat = ref.current;
    if (!mat) return;

    const elapsed = clock.elapsedTime;
    const dt = clock.getDelta();

    // ═══ MLS-MPM Step ═══
    // Provide ocean height callback for reabsorption
    const heightAt = (x: number, z: number) => cpuOceanHeight(x, z, elapsed, params);
    
    // Sub-step for stability (2 sub-steps)
    const subDt = Math.min(dt, 0.016) / 2;
    for (let s = 0; s < 2; s++) {
      mpmSolver.step(subDt, heightAt);
    }

    // ═══ Auto-spawn from wave energy (the ONLY source of particles) ═══
    // Per the docs: particles emerge organically from wave energy, not from clicks.
    // The polarized heatmap detects high-energy crests and spawns surface-conforming sheets.
    if (elapsed - lastAutoSpawn.current > autoSpawnCooldown && mpmSolver.count < MAX_PARTICLES - 80) {
      lastAutoSpawn.current = elapsed;
      
      // Sample rupture potential across the visible ocean near origin
      // Grid covers [-32,32] so sample within that
      const sampleRange = 25;
      
      for (let si = 0; si < 12; si++) {
        const angle = (si / 12) * Math.PI * 2 + elapsed * 0.15;
        const radius = 3 + Math.random() * sampleRange;
        const sx = Math.cos(angle) * radius;
        const sz = Math.sin(angle) * radius;
        
        const R = cpuRupturePotential(sx, sz, elapsed, params, splashes);
        
        if (R > 0.35) { // Rupture threshold
          const surfH = heightAt(sx, sz);
          const [ux, uz] = cpuSurfaceMomentum(sx, sz, elapsed, params);
          const umag = Math.sqrt(ux * ux + uz * uz);
          
          // Vertical velocity estimate (finite difference)
          const h0 = heightAt(sx, sz);
          const h1 = cpuOceanHeight(sx, sz, elapsed - 0.03, params);
          const vUp = Math.max(0, (h0 - h1) / 0.03);
          
          // Surface velocity: forward throw from wave momentum + upward from vertical motion
          const surfVel: [number, number, number] = [
            umag > 0.1 ? ux / umag * (1.0 + R) : 0,
            vUp * (0.5 + R * 1.5),  // Controlled upward from actual surface velocity
            umag > 0.1 ? uz / umag * (1.0 + R) : 0,
          ];
          
          const spawnCount = Math.floor(4 + R * 15);
          mpmSolver.spawnFromSurface(sx, sz, surfH, spawnCount, surfVel, R, heightAt);
        }
      }
    }

    // ═══ Update DataTexture ═══
    mpmSolver.buildTexData(mpmTexData.current);
    mpmTex.image.data = mpmTexData.current;
    mpmTex.needsUpdate = true;

    // ═══ Update uniforms ═══
    mat.uniforms.uTime.value = elapsed;

    const pr = gl.getPixelRatio();
    const canvas = gl.domElement;
    mat.uniforms.uResolution.value.set(canvas.width * pr, canvas.height * pr);
    mat.uniforms.uCamPos.value.copy(camera.position);

    invPV.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    mat.uniforms.uInvProjView.value.copy(invPV);

    mat.uniforms.uWaveScale.value = params.waveScale;
    mat.uniforms.uTimeScale.value = params.timeScale;
    mat.uniforms.uChoppiness.value = params.choppiness;
    mat.uniforms.uClarity.value = params.clarity;
    mat.uniforms.uSunHeight.value = params.sunHeight;
    mat.uniforms.uTurbulence.value = params.turbulence;
    mat.uniforms.uVizMode.value = vizMode;

    mat.uniforms.uMpmCount.value = Math.min(mpmSolver.count, MAX_MPM_SHADER);
    mat.uniforms.uMpmBoundsMin.value.set(...(mpmSolver.boundsMin as [number, number, number]));
    mat.uniforms.uMpmBoundsMax.value.set(...(mpmSolver.boundsMax as [number, number, number]));

    // Splash uniforms
    const splashVecs: THREE.Vector4[] = [];
    for (let i = 0; i < MAX_SPLASHES; i++) {
      if (i < splashes.length) {
        splashVecs.push(new THREE.Vector4(splashes[i].x, splashes[i].z, splashes[i].time, splashes[i].amplitude));
      } else {
        splashVecs.push(new THREE.Vector4(0, 0, -100, 0));
      }
    }
    mat.uniforms.uSplashes.value = splashVecs;
    mat.uniforms.uSplashCount.value = Math.min(splashes.length, MAX_SPLASHES);
  });

  return (
    <mesh frustumCulled={false} renderOrder={-1}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={ref}
        vertexShader={VERT}
        fragmentShader={FRAG}
        uniforms={uniforms}
        depthWrite={false}
        depthTest={false}
      />
    </mesh>
  );
}

// ─── Main Scene ───

export default function SDFWaterScene({
  params = DEFAULT_PARAMS,
  splashes = [],
  vizMode = 0,
  onClickOcean,
}: {
  params?: SDFWaterParams;
  splashes?: SplashData[];
  vizMode?: number;
  onClickOcean?: (x: number, z: number) => void;
}) {
  // Single MLS-MPM solver instance, persists across renders
  const mpmSolver = useMemo(() => new MLSMPMSolver(), []);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const handleClick = useCallback(
    (x: number, z: number) => {
      // Click only creates wave energy in the heightfield.
      // MLS-MPM particles spawn organically from wave energy detection, not from clicks.
      onClickOcean?.(x, z);
    },
    [onClickOcean]
  );

  return (
    <Canvas
      camera={{ position: [0, 10, 30], fov: 55, near: 0.1, far: 500 }}
      gl={{ antialias: true, alpha: false }}
      style={{ background: "#000" }}
    >
      <OceanShader
        params={params}
        splashes={splashes}
        vizMode={vizMode}
        mpmSolver={mpmSolver}
      />
      <ClickPlane onClickOcean={handleClick} />
      <OrbitControls
        autoRotate
        autoRotateSpeed={0.15}
        enableZoom
        enablePan
        minDistance={3}
        maxDistance={80}
        maxPolarAngle={Math.PI * 0.95}
        target={[0, 0, 0]}
      />
    </Canvas>
  );
}

export { DEFAULT_PARAMS };
