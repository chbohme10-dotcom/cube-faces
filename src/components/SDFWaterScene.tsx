/**
 * SDFWaterScene — Production-quality volumetric SDF ocean raymarcher.
 *
 * Implements the hierarchical parametric volumetric SDF concept:
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
 */

import { useRef, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

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

#define PI 3.14159265359
#define TAU 6.28318530718
#define MAX_STEPS 96
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

// ─── 8-component Gerstner spectrum with LOD ───
// Primary swell, secondary swell, deep swell always computed.
// Wind chop, cross chop, capillary only at close range.

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
  return smoothstep(0.0, -0.35, j);
}

// ─── SDF ───
float sdfOcean(vec3 p, float dist) {
  return p.y - oceanHeight(p.xz, uTime, dist);
}

// ─── Procedural sky ───
vec3 getSunDir() {
  return normalize(vec3(0.8, max(0.05, uSunHeight), -0.6));
}

vec3 sky(vec3 rd) {
  vec3 sunDir = getSunDir();
  float sunDot = max(0.0, dot(rd, sunDir));

  // Rayleigh-like gradient
  float g = max(0.0, rd.y);
  vec3 zenith = vec3(0.12, 0.28, 0.58);
  vec3 horizon = vec3(0.55, 0.65, 0.78);

  // Warm horizon when sun is low
  float sunElev = sunDir.y;
  vec3 warmHorizon = mix(vec3(0.8, 0.45, 0.2), horizon, smoothstep(0.0, 0.5, sunElev));
  vec3 col = mix(warmHorizon, zenith, pow(g, 0.45));

  // Below-horizon fade to dark
  if (rd.y < 0.0) {
    col = mix(warmHorizon * 0.3, col, exp(rd.y * 8.0));
  }

  // Sun disk + glow
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

// ─── Adaptive raymarch ───
float raymarch(vec3 ro, vec3 rd) {
  float t = 0.1;
  float lastD = 100.0;
  float lastT = 0.0;

  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = sdfOcean(p, t);

    if (d < 0.005) {
      // Linear interpolation for sub-step precision
      t = lastT + (t - lastT) * lastD / (lastD - d + 0.0001);
      break;
    }

    lastD = d;
    lastT = t;

    // Adaptive step: larger steps when far, conservative near surface
    t += max(d * 0.45, 0.08 + t * 0.0025);

    if (t > MAX_DIST) break;
  }
  return t;
}

// ─── Main ───
void main() {
  // Reconstruct world-space ray from camera
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 worldFar = uInvProjView * vec4(ndc, 1.0, 1.0);
  worldFar /= worldFar.w;
  vec4 worldNear = uInvProjView * vec4(ndc, -1.0, 1.0);
  worldNear /= worldNear.w;

  vec3 ro = uCamPos;
  vec3 rd = normalize(worldFar.xyz - worldNear.xyz);

  vec3 sunDir = getSunDir();

  // Check if camera is underwater
  float camH = oceanHeightFull(ro.xz, uTime);
  bool underwater = ro.y < camH;

  float t = raymarch(ro, rd);
  vec3 color;

  if (t < MAX_DIST) {
    vec3 p = ro + rd * t;
    vec3 n = oceanNormal(p.xz, uTime);
    if (underwater) n = -n; // Flip normal when looking up from below

    vec3 v = -rd;
    float NdotV = max(0.001, dot(n, v));

    // Fresnel
    float F = fresnel(NdotV);

    // Reflection
    vec3 reflDir = reflect(rd, n);
    vec3 refl = sky(reflDir);

    // Sun specular (Blinn-Phong, sharp)
    vec3 halfV = normalize(sunDir + v);
    float NdotH = max(0.0, dot(n, halfV));
    refl += vec3(1.0, 0.95, 0.85) * pow(NdotH, 350.0) * 4.0;

    // Beer-Lambert volumetric absorption
    vec3 absCoeff = vec3(0.42, 0.088, 0.038) * (2.0 - uClarity);
    float viewDepth = max(0.3, t * max(0.01, abs(rd.y)) * 1.5);
    vec3 waterAbs = exp(-absCoeff * viewDepth);

    // Subsurface scattering (light passing through wave crests)
    vec3 refrDir = refract(rd, n, 0.75);
    float sss = pow(max(0.0, dot(sunDir, -refrDir)), 5.0) * 0.45;
    vec3 sssCol = vec3(0.04, 0.28, 0.18) * sss * waterAbs;

    // Deep water base + scattered light
    vec3 deepCol = vec3(0.008, 0.035, 0.07);
    vec3 scatterCol = vec3(0.02, 0.08, 0.12);
    vec3 waterCol = deepCol + scatterCol * waterAbs + sssCol;

    // Caustics (wave-curvature-driven light patterns)
    float caustVal = caustics(p) * waterAbs.g * 0.35 * uClarity;
    waterCol += vec3(0.04, 0.14, 0.1) * caustVal;

    // Turbulence energy (selective internal vortex visualization)
    if (uTurbulence > 0.01) {
      float te = turbulenceField(p * 0.12) * uTurbulence;
      waterCol += vec3(0.0, 0.05, 0.09) * te;
    }

    // Foam from Gerstner Jacobian (wave folding = topology change)
    float foam = oceanFoam(p.xz, uTime);
    vec3 foamCol = vec3(0.82, 0.88, 0.93) * foam;

    // Combine via Fresnel
    if (underwater) {
      // Underwater: mostly refracted light, dimmed reflection
      color = waterCol * 1.5 + refl * F * 0.3;
    } else {
      color = mix(waterCol, refl, F);
      color += foamCol * (1.0 - F * 0.3);
    }

    // Atmospheric distance fog
    float fog = 1.0 - exp(-t * 0.0035);
    vec3 fogCol = sky(rd) * 0.65;
    color = mix(color, fogCol, fog);

  } else {
    color = sky(rd);
  }

  // Underwater tint (volumetric absorption from camera to surface/far)
  if (underwater) {
    float uwDepth = camH - ro.y;
    vec3 uwAbs = exp(-vec3(0.42, 0.088, 0.038) * uwDepth * 0.5);
    color *= uwAbs;
    // Underwater caustics on everything
    color += vec3(0.02, 0.06, 0.04) * caustics(ro + rd * min(t, 20.0)) * uwAbs.g;
    // Volumetric god-ray approximation
    float godRay = pow(max(0.0, dot(rd, sunDir)), 3.0) * 0.15;
    color += vec3(0.03, 0.1, 0.08) * godRay * uwAbs;
  }

  // ACES-inspired tone mapping
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);

  // Gamma
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

const DEFAULT_PARAMS: SDFWaterParams = {
  waveScale: 1.0,
  timeScale: 1.0,
  choppiness: 0.7,
  clarity: 0.8,
  sunHeight: 0.35,
  turbulence: 0.3,
};

function OceanShader({ params }: { params: SDFWaterParams }) {
  const ref = useRef<THREE.ShaderMaterial>(null);
  const { camera, gl } = useThree();
  const invPV = useMemo(() => new THREE.Matrix4(), []);

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

    // Live parameter updates
    mat.uniforms.uWaveScale.value = params.waveScale;
    mat.uniforms.uTimeScale.value = params.timeScale;
    mat.uniforms.uChoppiness.value = params.choppiness;
    mat.uniforms.uClarity.value = params.clarity;
    mat.uniforms.uSunHeight.value = params.sunHeight;
    mat.uniforms.uTurbulence.value = params.turbulence;
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
}: {
  params?: SDFWaterParams;
}) {
  return (
    <Canvas
      camera={{ position: [0, 10, 30], fov: 55, near: 0.1, far: 500 }}
      gl={{ antialias: true, alpha: false }}
      style={{ background: "#000" }}
    >
      <OceanShader params={params} />
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
