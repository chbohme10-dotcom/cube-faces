/**
 * Gerstner Wave System
 * Physically accurate ocean surface waves with proper circular orbital motion.
 * Each wave component has amplitude, frequency, steepness, direction, and phase speed.
 */

export interface GerstnerWaveComponent {
  amplitude: number;    // Wave height (meters)
  wavelength: number;   // Distance between crests
  steepness: number;    // 0-1, controls sharpness (Q factor)
  direction: [number, number]; // Normalized 2D direction
  speed: number;        // Phase speed
  phase: number;        // Initial phase offset
}

/**
 * Default ocean wave spectrum — multiple overlapping wave trains
 * for realistic interference patterns.
 */
export function createOceanSpectrum(N: number): GerstnerWaveComponent[] {
  const scale = N / 48; // Normalize to grid size
  return [
    // Primary swell — long wavelength, moderate amplitude
    {
      amplitude: 3.5 * scale,
      wavelength: N * 0.7,
      steepness: 0.4,
      direction: [0.8, 0.6],
      speed: 1.2,
      phase: 0,
    },
    // Secondary swell — different direction for cross-sea
    {
      amplitude: 2.8 * scale,
      wavelength: N * 0.5,
      steepness: 0.35,
      direction: [-0.5, 0.866],
      speed: 1.0,
      phase: 1.5,
    },
    // Wind chop — shorter, steeper
    {
      amplitude: 1.8 * scale,
      wavelength: N * 0.25,
      steepness: 0.55,
      direction: [0.3, -0.95],
      speed: 1.8,
      phase: 0.7,
    },
    // Cross chop
    {
      amplitude: 1.2 * scale,
      wavelength: N * 0.18,
      steepness: 0.5,
      direction: [-0.9, -0.44],
      speed: 2.2,
      phase: 2.1,
    },
    // Capillary ripple — very short, fast
    {
      amplitude: 0.6 * scale,
      wavelength: N * 0.1,
      steepness: 0.3,
      direction: [0.6, -0.8],
      speed: 3.0,
      phase: 3.3,
    },
    // Deep swell — very long period
    {
      amplitude: 2.0 * scale,
      wavelength: N * 1.0,
      steepness: 0.2,
      direction: [0.0, 1.0],
      speed: 0.6,
      phase: 4.0,
    },
  ];
}

/**
 * Evaluate the sum of Gerstner waves at a grid point.
 * Returns the vertical displacement (height) at position (x, z) at time t.
 *
 * Full Gerstner includes horizontal displacement, but for our
 * height-field wave equation coupling we only need the vertical component.
 */
export function evaluateGerstnerHeight(
  x: number,
  z: number,
  time: number,
  waves: GerstnerWaveComponent[]
): number {
  let height = 0;

  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w];
    const k = (2 * Math.PI) / wave.wavelength; // wave number
    const omega = k * wave.speed;              // angular frequency

    // Dot product of direction with position
    const dot = wave.direction[0] * x + wave.direction[1] * z;

    // Gerstner vertical displacement: A * cos(k * dot(d, pos) - omega * t + phase)
    height += wave.amplitude * Math.cos(k * dot - omega * time + wave.phase);
  }

  return height;
}

/**
 * Evaluate Gerstner wave with full horizontal displacement.
 * Returns [dx, height, dz] — the full 3D displacement.
 * Useful for visualizing the characteristic sharp crests and broad troughs.
 */
export function evaluateGerstnerFull(
  x: number,
  z: number,
  time: number,
  waves: GerstnerWaveComponent[]
): [number, number, number] {
  let dx = 0, dy = 0, dz = 0;

  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w];
    const k = (2 * Math.PI) / wave.wavelength;
    const omega = k * wave.speed;
    const Q = wave.steepness / (wave.amplitude * k * waves.length); // Normalized Q

    const dot = wave.direction[0] * x + wave.direction[1] * z;
    const phase = k * dot - omega * time + wave.phase;
    const cosP = Math.cos(phase);
    const sinP = Math.sin(phase);

    // Horizontal displacement (creates sharp crests)
    dx -= Q * wave.amplitude * wave.direction[0] * sinP;
    dz -= Q * wave.amplitude * wave.direction[1] * sinP;
    // Vertical displacement
    dy += wave.amplitude * cosP;
  }

  return [dx, dy, dz];
}
