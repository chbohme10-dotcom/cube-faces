import { useState, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import SDFWaterScene, { DEFAULT_PARAMS, type SDFWaterParams, type SplashData } from "@/components/SDFWaterScene";
import { Slider } from "@/components/ui/slider";

const CONTROLS: {
  key: keyof SDFWaterParams;
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "waveScale", label: "Wave Height", min: 0.1, max: 3.0, step: 0.05 },
  { key: "timeScale", label: "Wind Speed", min: 0.2, max: 3.0, step: 0.05 },
  { key: "choppiness", label: "Choppiness", min: 0.0, max: 1.5, step: 0.05 },
  { key: "clarity", label: "Water Clarity", min: 0.1, max: 1.0, step: 0.05 },
  { key: "sunHeight", label: "Sun Height", min: 0.02, max: 1.0, step: 0.02 },
  { key: "turbulence", label: "Turbulence Energy", min: 0.0, max: 1.0, step: 0.05 },
];

const TAGS = [
  "Volumetric SDF",
  "8-Wave Gerstner Spectrum",
  "Beer-Lambert Absorption",
  "Adaptive LOD Raymarching",
  "Fresnel + SSS",
  "Jacobian Foam Detection",
  "Click-to-Splash",
  "SDF Visualization",
];

export default function SDFWater() {
  const [params, setParams] = useState<SDFWaterParams>({ ...DEFAULT_PARAMS });
  const [showPanel, setShowPanel] = useState(false);
  const [splashes, setSplashes] = useState<SplashData[]>([]);
  const [vizMode, setVizMode] = useState(0);
  const clockRef = useRef(0);

  // We need to track the R3F clock time for splash timestamps
  // Use a simple incrementing ref synced via requestAnimationFrame
  const startTime = useRef(performance.now() / 1000);

  const updateParam = useCallback(
    (key: keyof SDFWaterParams, value: number) => {
      setParams((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const handleWaveInput = useCallback((x: number, z: number, intensity = 1) => {
    const elapsed = performance.now() / 1000 - startTime.current;
    const amplitude = Math.min(1.8, Math.max(0.35, 0.45 + intensity * 0.45));

    const newSplash: SplashData = {
      x,
      z,
      time: elapsed,
      amplitude,
    };

    setSplashes((prev) => {
      const updated = [...prev, newSplash];
      return updated.slice(-8);
    });
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-background">
      {/* Canvas */}
      <div className="absolute inset-0 z-0">
        <SDFWaterScene
          params={params}
          splashes={splashes}
          vizMode={vizMode}
          onWaveInput={handleWaveInput}
        />
      </div>

      {/* Header overlay */}
      <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none">
        <div className="flex items-start justify-between p-5 md:p-8">
          {/* Left: title */}
          <div className="pointer-events-auto">
            <Link
              to="/"
              className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
            >
              ← CubeFace
            </Link>
            <h1 className="mt-2 text-3xl md:text-5xl font-bold font-mono tracking-tighter text-foreground drop-shadow-lg">
              <span className="text-primary">SDF</span> OCEAN
            </h1>
            <p className="mt-1 text-xs md:text-sm text-muted-foreground font-mono max-w-md leading-relaxed drop-shadow-md">
              {vizMode === 0
                ? "Hierarchical Parametric Volumetric Signed Distance Field"
                : "SDF Field Visualization — Distance Cross-Sections"}
            </p>
          </div>

          {/* Right: controls */}
          <div className="pointer-events-auto flex gap-2">
            <button
              onClick={() => setVizMode(vizMode === 0 ? 1 : 0)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-mono transition-all backdrop-blur-md ${
                vizMode === 1
                  ? "border-primary bg-primary/20 text-primary"
                  : "border-border bg-card/80 text-muted-foreground hover:text-foreground hover:border-primary"
              }`}
            >
              {vizMode === 0 ? "◈ SDF View" : "◈ Realistic"}
            </button>
            <button
              onClick={() => setShowPanel(!showPanel)}
              className="px-3 py-1.5 rounded-lg border border-border bg-card/80 backdrop-blur-md text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary transition-all"
            >
              {showPanel ? "✕ Close" : "⚙ Controls"}
            </button>
          </div>
        </div>
      </div>

      {/* Bottom tags */}
      <div className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
        <div className="flex flex-wrap gap-2 p-5 md:p-8">
          {TAGS.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 text-[10px] font-mono rounded-full border border-border/50 text-muted-foreground/70 bg-card/30 backdrop-blur-sm"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* Click hint */}
      <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <p className="text-[10px] font-mono text-muted-foreground/50 bg-card/20 backdrop-blur-sm px-3 py-1 rounded-full">
          Click the water to create splashes
        </p>
      </div>

      {/* Controls panel */}
      {showPanel && (
        <div className="absolute top-20 right-5 md:right-8 z-20 w-64 p-4 rounded-xl border border-border bg-card/90 backdrop-blur-xl shadow-2xl">
          <p className="text-xs font-mono text-primary tracking-widest uppercase mb-4">
            Parametric Controls
          </p>
          <div className="space-y-4">
            {CONTROLS.map(({ key, label, min, max, step }) => (
              <div key={key}>
                <div className="flex justify-between text-xs font-mono text-muted-foreground mb-1.5">
                  <span>{label}</span>
                  <span className="text-foreground">{params[key].toFixed(2)}</span>
                </div>
                <Slider
                  value={[params[key]]}
                  onValueChange={([v]) => updateParam(key, v)}
                  min={min}
                  max={max}
                  step={step}
                  className="w-full"
                />
              </div>
            ))}
          </div>
          <button
            onClick={() => setParams({ ...DEFAULT_PARAMS })}
            className="mt-4 w-full py-1.5 rounded-lg border border-border text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary transition-all"
          >
            Reset Defaults
          </button>
          <button
            onClick={() => setSplashes([])}
            className="mt-2 w-full py-1.5 rounded-lg border border-border text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary transition-all"
          >
            Clear Splashes
          </button>
          <p className="mt-3 text-[9px] font-mono text-muted-foreground/50 leading-relaxed">
            Drag to orbit · Scroll to zoom · Click water to splash · Dive below for underwater view
          </p>
        </div>
      )}
    </div>
  );
}
