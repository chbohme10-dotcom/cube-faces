/**
 * SDFWaterScene — Production-quality volumetric SDF ocean raymarcher.
 *
 * Features:
 * - 8-component Gerstner wave spectrum (analytical parametric layer)
 * - Adaptive-LOD raymarching (coarse far, detailed near)
 * - Beer-Lambert volumetric absorption (wavelength-dependent)
 * - Subsurface scattering approximation
 * - Fresnel reflection/refraction split
 * - Caustic light patterns from wave curvature
 * - Foam/whitecaps from Gerstner Jacobian (wave folding detection)
 * - Turbulence energy visualization (curl-noise)
 * - Procedural atmospheric sky with sun
 * - Underwater viewing support
 * - Click-to-splash radial impulse waves
 * - SDF field visualization mode
 */

import { useRef, useMemo, useCallback } from "react";
import { Canvas, useFrame, useThree, ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

// Max simultaneous splashes
const MAX_SPLASHES = 8;

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

// Splash system: vec4(x, z, startTime, amplitude) per splash
uniform vec4 uSplashes[${MAX_SPLASHES}];
uniform int uSplashCount;

// Visualization mode: 0 = realistic, 1 = SDF field
uniform int uVizMode;

#define PI 3.14159265359
#define TAU 6.28318530718
#define MAX_STEPS 128
#define MAX_DIST 250.0

// ─── Wave helper functions ───

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

// ─── Splash ripple waves ───
float splashHeight(vec2 p, float t) {
  float h = 0.0;
  for (int i = 0; i < ${MAX_SPLASHES}; i++) {
    if (i >= uSplashCount) break;
    vec4 sp = uSplashes[i];
    vec2 center = sp.xy;
    float startTime = sp.z;
    float amp = sp.w;
    
    float age = t - startTime;
    if (age < 0.0 || age > 12.0) continue;
    
    float dist = length(p - center);
    float decay = exp(-age * 0.35) * exp(-dist * 0.015);
    
    // Multi-frequency radial ripples
    float speed = 8.0;
    float phase = dist - speed * age;
    float ripple = 0.0;
    ripple += sin(phase * 0.8) * 1.0;
    ripple += sin(phase * 1.6 + 0.5) * 0.4;
    ripple += sin(phase * 3.2 + 1.0) * 0.15;
    
    // Leading edge envelope
    float envelope = smoothstep(speed * age + 2.0, speed * age - 1.0, dist);
    envelope *= smoothstep(0.0, 0.5, age); // ramp in
    
    h += amp * ripple * decay * envelope;
    
    // Impact crater depression (cavity before crown rises)
    h += -amp * 1.5 * exp(-age * 2.5) * exp(-dist * dist / (amp * amp * 3.0));
  }
  return h;
}

vec2 splashGradient(vec2 p, float t) {
  float eps = 0.3;
  float hL = splashHeight(p - vec2(eps, 0.0), t);
  float hR = splashHeight(p + vec2(eps, 0.0), t);
  float hD = splashHeight(p - vec2(0.0, eps), t);
  float hU = splashHeight(p + vec2(0.0, eps), t);
  return vec2(hR - hL, hU - hD) / (2.0 * eps);
}

// ─── Smooth minimum for SDF blending ───
float smin(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * h * k * (1.0 / 6.0);
}

// ─── Volumetric Splash SDF ───
// Full 3D splash evolution via SDF primitives:
//   1. Crown sheet — expanding torus with mass-conserving thinning
//   2. Rayleigh-Plateau angular breakup → finger ligaments
//   3. Worthington central jet with capillary necking instability
//   4. Droplet detachment — velocity-elongated ellipsoid SDFs on ballistic arcs
//   5. Crown-finger ejecta droplets
float sdfSplashVolume(vec3 p, float time) {
    float d = 999.0;
    float grav = 9.81;

    for (int i = 0; i < ${MAX_SPLASHES}; i++) {
        if (i >= uSplashCount) break;
        vec4 sp = uSplashes[i];
        vec2 center = sp.xy;
        float t0 = sp.z;
        float amp = sp.w;
        float age = time - t0;

        if (age < 0.0 || age > 5.0) continue;

        vec3 lp = vec3(p.x - center.x, p.y, p.z - center.y);
        float r = length(lp.xz);

        // Bounding rejection
        float maxR = amp * 6.0 + age * 5.0;
        float maxH = amp * 14.0;
        if (r > maxR || lp.y > maxH || lp.y < -2.0) continue;

        float theta = atan(lp.z, lp.x);
        float sd = 999.0;

        // ── Crown sheet ──
        float v0c = amp * 4.5;
        float crownH = v0c * age - 0.5 * grav * age * age;
        float crownLife = v0c * 2.0 / grav;

        if (crownH > 0.1 && age < crownLife) {
            float crownR = amp * (0.6 + age * 1.8);
            float wallThick = amp * 0.4 * max(0.03, exp(-age * 0.7));
            wallThick = clamp(wallThick, 0.02, amp * 0.4);

            // Torus rim at crown top
            vec2 torusQ = vec2(r - crownR, lp.y - crownH);
            float rimD = length(torusQ) - wallThick * 1.5;

            // Conical sheet: ocean surface → crown rim
            if (lp.y > 0.0 && lp.y < crownH) {
                float tf = lp.y / crownH;
                float sheetR = mix(amp * 0.5, crownR, sqrt(tf));
                float sheetW = wallThick * mix(1.2, 0.5, tf);
                float sheetD = abs(r - sheetR) - sheetW;
                rimD = min(rimD, sheetD);
            }

            // Rayleigh-Plateau angular breakup → fingers
            float breakup = smoothstep(0.4, 1.2, age);
            if (breakup > 0.01) {
                float nFing = floor(6.0 + amp * 2.5);
                float angWave = pow(max(0.0, sin(nFing * theta)), 2.0);
                float upperMask = smoothstep(crownH * 0.3, crownH * 0.7, lp.y);
                rimD += breakup * (1.0 - angWave) * wallThick * 5.0 * upperMask;
            }

            sd = min(sd, rimD);
        }

        // ── Worthington central jet ──
        float jetDelay = 0.15;
        float jetAge = age - jetDelay;
        if (jetAge > 0.0) {
            float v0j = amp * 7.5;
            float jetH = v0j * jetAge - 0.5 * grav * jetAge * jetAge;
            float jetLife = v0j * 2.0 / grav;

            if (jetH > -1.0 && jetAge < jetLife + 0.5) {
                float jetPeak = max(0.3, jetH);
                float jetR = amp * 0.22 * max(0.03, exp(-jetAge * 0.35));

                // Tapered cylinder body
                if (lp.y >= -0.1 && lp.y <= jetPeak) {
                    float frac = clamp(lp.y / max(0.1, jetPeak), 0.0, 1.0);
                    float taper = jetR * mix(2.0, 0.5, frac);
                    float cylD = r - taper;

                    // Capillary necking instability along jet length
                    float neckOnset = smoothstep(0.5, 1.5, jetAge);
                    if (neckOnset > 0.01) {
                        float waveNum = 2.8 / max(0.08, jetR);
                        float neckAmp = neckOnset * taper * 0.55;
                        cylD += max(0.0, sin(lp.y * waveNum - jetAge * 5.0) * neckAmp);
                    }

                    sd = min(sd, cylD);
                }

                // Capillary bulbous tip
                if (jetPeak > 0.3) {
                    float tipR = jetR * 2.2;
                    sd = min(sd, length(vec3(lp.x, lp.y - jetPeak, lp.z)) - tipR);
                }
            }
        }

        // ── Detached droplets ──
        float dropOnset = smoothstep(1.0, 1.8, age);
        if (dropOnset > 0.01) {
            // Jet-tip pinch-off droplets
            float v0j2 = amp * 7.5;
            for (int di = 0; di < 5; di++) {
                float dLaunch = 1.0 + float(di) * 0.18;
                float dAge = age - dLaunch;
                if (dAge < 0.0 || dAge > 3.5) continue;

                float dAng = float(di) * 1.885 + amp * 1.3;
                float vUp = v0j2 * (0.55 - float(di) * 0.07);
                float vOut = amp * (0.2 + float(di) * 0.25);

                vec3 dP = vec3(
                    cos(dAng) * vOut * dAge,
                    vUp * dAge - 0.5 * grav * dAge * dAge,
                    sin(dAng) * vOut * dAge
                );
                if (dP.y < -1.0) continue;

                float dR = amp * 0.12 * (1.2 - float(di) * 0.1);
                vec3 dV = vec3(cos(dAng)*vOut, vUp - grav*dAge, sin(dAng)*vOut);
                float spd = length(dV);
                if (spd > 0.1) {
                    vec3 dir = dV / spd;
                    float along = dot(lp - dP, dir);
                    float perp = length(lp - dP - along * dir);
                    float stretch = 1.0 + min(3.5, spd * 0.12);
                    sd = min(sd, length(vec2(perp, along / stretch)) - dR);
                } else {
                    sd = min(sd, length(lp - dP) - dR);
                }
            }

            // Crown-finger ejecta
            float nFing2 = floor(6.0 + amp * 2.5);
            float v0c2 = amp * 4.5;
            for (int fi = 0; fi < 8; fi++) {
                if (float(fi) >= nFing2) break;
                float fLaunch = 0.8 + float(fi) * 0.1;
                float fAge = age - fLaunch;
                if (fAge < 0.0 || fAge > 3.0) continue;

                float fAng = (float(fi) + 0.5) * TAU / nFing2;
                float baseR = amp * (1.2 + fLaunch * 1.5);
                float vUp = v0c2 * (0.5 + float(fi) * 0.04);
                float vOut = amp * 1.8;

                vec3 fP = vec3(
                    cos(fAng) * (baseR + vOut * fAge),
                    vUp * fAge - 0.5 * grav * fAge * fAge + 1.0,
                    sin(fAng) * (baseR + vOut * fAge)
                );
                if (fP.y < -1.0) continue;

                float fR = amp * 0.1 * (1.0 - float(fi) * 0.04);
                vec3 fV = vec3(cos(fAng)*vOut, vUp - grav*fAge, sin(fAng)*vOut);
                float fSpd = length(fV);
                if (fSpd > 0.1) {
                    vec3 dir = fV / fSpd;
                    float along = dot(lp - fP, dir);
                    float perp = length(lp - fP - along * dir);
                    float stretch = 1.0 + min(2.5, fSpd * 0.1);
                    sd = min(sd, length(vec2(perp, along / stretch)) - fR);
                } else {
                    sd = min(sd, length(lp - fP) - fR);
                }
            }
        }

        if (sd < 999.0) {
            d = smin(d, sd, amp * 0.4);
        }
    }

    return d;
}

// ─── 8-component Gerstner spectrum with LOD ───

float oceanHeight(vec2 p, float t, float dist) {
  float s = uWaveScale;
  float ts = t * uTimeScale;
  float h = 0.0;

  // Large waves (always)
  h += gW(p, ts, 1.2*s, 60.0, vec2(0.8,0.6), 8.0, 0.0);
  h += gW(p, ts, 0.9*s, 42.0, vec2(-0.447,0.894), 6.5, 1.5);
  h += gW(p, ts, 0.8*s, 80.0, vec2(0.0,1.0), 10.0, 4.0);

  // Medium waves (LOD 1)
  if (dist < 120.0) {
    h += gW(p, ts, 0.6*s, 26.0, vec2(0.3,-0.95), 5.2, 0.7);
    h += gW(p, ts, 0.4*s, 16.0, vec2(-0.9,-0.44), 4.0, 2.1);
    h += gW(p, ts, 0.3*s, 13.0, vec2(0.95,-0.3), 3.5, 1.8);
  }

  // Fine waves (LOD 2 — only near camera)
  if (dist < 50.0) {
    h += gW(p, ts, 0.25*s, 8.5, vec2(0.6,-0.8), 3.2, 3.3);
    h += gW(p, ts, 0.15*s, 5.5, vec2(-0.7,0.7), 2.5, 5.2);
  }

  // Add splash ripples
  h += splashHeight(p, t);

  return h;
}

// Full-detail height (for shading at hit point)
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
  // Add splash gradient
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
  
  // Splash foam
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

// ─── SDF ───
float sdfOcean(vec3 p, float dist) {
  return p.y - oceanHeight(p.xz, uTime, dist);
}

// ─── Combined scene SDF ───
float sdfScene(vec3 p, float dist) {
    float ocean = sdfOcean(p, dist);
    float splash = sdfSplashVolume(p, uTime);
    return smin(ocean, splash, 0.5);
}

// ─── Central-difference normal on full 3D SDF ───
vec3 calcNormal3D(vec3 p, float dist) {
    float e = 0.1;
    return normalize(vec3(
        sdfScene(p + vec3(e,0,0), dist) - sdfScene(p - vec3(e,0,0), dist),
        sdfScene(p + vec3(0,e,0), dist) - sdfScene(p - vec3(0,e,0), dist),
        sdfScene(p + vec3(0,0,e), dist) - sdfScene(p - vec3(0,0,e), dist)
    ));
}

// ─── Adaptive normal: central-diff near splashes, analytical far ───
vec3 getHitNormal(vec3 p, float dist) {
    float splashDist = sdfSplashVolume(p, uTime);
    if (splashDist < 1.5) {
        return calcNormal3D(p, dist);
    }
    return oceanNormal(p.xz, uTime);
}

// ─── Procedural sky ───
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

  if (rd.y < 0.0) {
    col = mix(warmHorizon * 0.3, col, exp(rd.y * 8.0));
  }

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

// ─── Noise for turbulence ───
float hash31(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
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
  float t = 0.0;
  float a = 1.0, f = 0.3;
  for (int i = 0; i < 4; i++) {
    t += a * noise3(p * f + uTime * 0.25);
    a *= 0.5; f *= 2.0;
  }
  return t;
}

// ─── Fresnel (Schlick) ───
float fresnel(float cosT) {
  return 0.02 + 0.98 * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
}

// ─── SDF Visualization color map ───
vec3 sdfColorMap(float d) {
  // Negative (inside water) = blues/cyans, positive (above) = warm
  if (d < 0.0) {
    float t = clamp(-d * 0.3, 0.0, 1.0);
    return mix(vec3(0.1, 0.6, 0.8), vec3(0.0, 0.05, 0.3), t);
  } else {
    float t = clamp(d * 0.3, 0.0, 1.0);
    return mix(vec3(0.1, 0.8, 0.3), vec3(1.0, 0.3, 0.05), t);
  }
}

// ─── Adaptive raymarch ───
float raymarch(vec3 ro, vec3 rd) {
  float t = 0.1;
  float lastD = 100.0;
  float lastT = 0.0;

  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = sdfScene(p, t);

    if (d < 0.005) {
      t = lastT + (t - lastT) * lastD / (lastD - d + 0.0001);
      break;
    }

    lastD = d;
    lastT = t;

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

  // ─── SDF Visualization Mode ───
  if (uVizMode == 1) {
    // Raymarch to find the surface like normal mode
    float tHit = raymarch(ro, rd);
    vec3 color;
    
    if (tHit < MAX_DIST) {
      vec3 p = ro + rd * tHit;
      vec3 n = getHitNormal(p, tHit);
      float d = sdfScene(p, tHit);
      
      // Base: color by surface height
      float h = oceanHeightFull(p.xz, uTime);
      float hNorm = clamp(h * 0.15 + 0.5, 0.0, 1.0);
      vec3 lowCol = vec3(0.05, 0.15, 0.6);  // deep blue for troughs
      vec3 midCol = vec3(0.1, 0.5, 0.4);    // teal for mid
      vec3 highCol = vec3(0.9, 0.95, 1.0);  // white for crests
      color = hNorm < 0.5 
        ? mix(lowCol, midCol, hNorm * 2.0)
        : mix(midCol, highCol, (hNorm - 0.5) * 2.0);
      
      // Iso-lines at height intervals  
      float isoLine = 1.0 - smoothstep(0.0, 0.06, abs(fract(h * 0.5) - 0.5) * 2.0);
      color = mix(color, vec3(1.0), isoLine * 0.5);
      
      // Foam / Jacobian overlay
      float foam = oceanFoam(p.xz, uTime);
      color = mix(color, vec3(1.0, 0.3, 0.1), foam * 0.6);
      
      // LOD boundary rings (distance from camera)
      float distToCam = length(p.xz - ro.xz);
      float lod1 = 1.0 - smoothstep(0.0, 2.0, abs(distToCam - 50.0));
      float lod2 = 1.0 - smoothstep(0.0, 3.0, abs(distToCam - 120.0));
      color = mix(color, vec3(1.0, 0.2, 0.2), lod1 * 0.5);
      color = mix(color, vec3(0.2, 0.4, 1.0), lod2 * 0.5);
      
      // Wireframe-style normal shading
      float NdotL = max(0.0, dot(n, getSunDir()));
      color *= 0.4 + 0.6 * NdotL;
      
      // Distance fog
      float fog = 1.0 - exp(-tHit * 0.006);
      color = mix(color, vec3(0.15, 0.18, 0.25), fog);
    } else {
      // Sky with dark tint for diagnostic look
      color = sky(rd) * 0.5;
    }
    
    // Grid overlay
    vec2 screenUV = vUv;
    float grid = 0.0;
    grid += smoothstep(0.002, 0.0, abs(fract(screenUV.x * 20.0) - 0.5) - 0.49);
    grid += smoothstep(0.002, 0.0, abs(fract(screenUV.y * 20.0) - 0.5) - 0.49);
    color = mix(color, vec3(0.3, 0.4, 0.5), grid * 0.1);
    
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

// ─── R3F Scene Component ───

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

function ClickPlane({ onClickOcean }: { onClickOcean: (x: number, z: number) => void }) {
  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (e.point) {
        onClickOcean(e.point.x, e.point.z);
      }
    },
    [onClickOcean]
  );

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, 0]}
      onClick={handleClick}
      visible={false}
    >
      <planeGeometry args={[500, 500]} />
      <meshBasicMaterial />
    </mesh>
  );
}

function OceanShader({
  params,
  splashes,
  vizMode,
}: {
  params: SDFWaterParams;
  splashes: SplashData[];
  vizMode: number;
}) {
  const ref = useRef<THREE.ShaderMaterial>(null);
  const { camera, gl } = useThree();
  const invPV = useMemo(() => new THREE.Matrix4(), []);

  // Build splash uniform array
  const splashArray = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i < MAX_SPLASHES; i++) {
      if (i < splashes.length) {
        arr.push(splashes[i].x, splashes[i].z, splashes[i].time, splashes[i].amplitude);
      } else {
        arr.push(0, 0, -100, 0);
      }
    }
    return arr;
  }, [splashes]);

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
      uVizMode: { value: 0 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useFrame(({ clock }) => {
    const mat = ref.current;
    if (!mat) return;

    mat.uniforms.uTime.value = clock.elapsedTime;

    const pr = gl.getPixelRatio();
    const canvas = gl.domElement;
    mat.uniforms.uResolution.value.set(canvas.width * pr, canvas.height * pr);
    mat.uniforms.uCamPos.value.copy(camera.position);

    invPV
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .invert();
    mat.uniforms.uInvProjView.value.copy(invPV);

    mat.uniforms.uWaveScale.value = params.waveScale;
    mat.uniforms.uTimeScale.value = params.timeScale;
    mat.uniforms.uChoppiness.value = params.choppiness;
    mat.uniforms.uClarity.value = params.clarity;
    mat.uniforms.uSunHeight.value = params.sunHeight;
    mat.uniforms.uTurbulence.value = params.turbulence;
    mat.uniforms.uVizMode.value = vizMode;

    // Update splash uniforms
    const splashVecs: THREE.Vector4[] = [];
    for (let i = 0; i < MAX_SPLASHES; i++) {
      if (i < splashes.length) {
        splashVecs.push(
          new THREE.Vector4(splashes[i].x, splashes[i].z, splashes[i].time, splashes[i].amplitude)
        );
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
  const handleClick = useCallback(
    (x: number, z: number) => {
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
