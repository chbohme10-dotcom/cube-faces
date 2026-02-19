import { Link } from "react-router-dom";
import CubeFluidDemo from "@/components/CubeFluidDemo";

const FEATURES = [
  {
    icon: "□",
    title: "6 Face Simulations",
    desc: "Each face runs an independent 2D Navier–Stokes solver. Opposite face pairs carry one Cartesian component of the 3D vorticity vector.",
  },
  {
    icon: "⟂",
    title: "Edge Coupling",
    desc: "At each of 12 shared edges, a perpendicular velocity transfer rule routes vorticity around corners — producing full 3D tilting and stretching.",
  },
  {
    icon: "▽",
    title: "O(N²) Complexity",
    desc: "6×N² storage and compute instead of N³. A 256-per-face sim uses ~3 MB vs >200 MB for a comparable volumetric grid.",
  },
];

const COMPARISONS = [
  { method: "3D Grid 256³", storage: "200+ MB", compute: "O(N³)", q: 95 },
  { method: "3D Grid 128³", storage: "25 MB", compute: "O(N³)", q: 70 },
  { method: "CubeFace 128", storage: "3 MB", compute: "O(N²)", q: 90 },
  { method: "CubeFace 64", storage: "0.75 MB", compute: "O(N²)", q: 75 },
];

export default function Index() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Hero */}
      <section className="relative h-screen flex flex-col items-center justify-center overflow-hidden">
        <div className="absolute inset-0 z-0">
          <CubeFluidDemo />
        </div>
        <div className="relative z-10 text-center pointer-events-none select-none">
          <h1 className="text-7xl md:text-8xl font-bold font-mono tracking-tighter">
            CUBE<span className="text-primary">FACE</span>
          </h1>
          <p className="mt-6 text-lg md:text-xl text-muted-foreground max-w-xl mx-auto leading-relaxed">
            Surface-Only Discretization for
            <br />
            3D Incompressible Rotational Fluid Simulation
          </p>
          <div className="mt-8 flex gap-3 justify-center flex-wrap">
            {["O(N²) Complexity", "6 Linked Faces", "Real-time GPU"].map((tag) => (
              <span key={tag} className="px-3 py-1 text-xs font-mono rounded-full border border-border text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="absolute bottom-8 text-muted-foreground text-sm font-mono animate-pulse-glow pointer-events-none">
          ↕ scroll · drag to rotate
        </div>
      </section>

      {/* Key Insight */}
      <section className="py-32 px-6 max-w-5xl mx-auto">
        <p className="text-sm font-mono text-primary tracking-widest uppercase mb-4">The Key Insight</p>
        <h2 className="text-4xl md:text-5xl font-bold font-mono tracking-tight leading-tight">
          Three vorticity components.
          <br />
          Six faces. <span className="text-primary">Zero volume.</span>
        </h2>
        <p className="mt-8 text-muted-foreground text-lg max-w-2xl leading-relaxed">
          The three Cartesian components of vorticity are naturally "owned" by three pairs of opposite faces. A single
          perpendicular-velocity transfer rule at the 12 edges handles vorticity tilting, stretching, and reconnection
          across all three principal directions.
        </p>
      </section>

      {/* Features */}
      <section className="py-20 px-6 max-w-5xl mx-auto">
        <div className="grid md:grid-cols-3 gap-8">
          {FEATURES.map((f) => (
            <div key={f.title} className="p-8 rounded-xl bg-card border border-border">
              <span className="text-3xl font-mono text-primary">{f.icon}</span>
              <h3 className="mt-4 text-xl font-bold font-mono">{f.title}</h3>
              <p className="mt-3 text-muted-foreground text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Performance */}
      <section className="py-20 px-6 max-w-5xl mx-auto">
        <p className="text-sm font-mono text-primary tracking-widest uppercase mb-4">Performance</p>
        <h2 className="text-3xl font-bold font-mono mb-12">Memory &amp; Compute Comparison</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="text-left py-4 pr-8">Method</th>
                <th className="text-left py-4 pr-8">Storage</th>
                <th className="text-left py-4 pr-8">Compute</th>
                <th className="text-left py-4">Visual Quality</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISONS.map((row) => (
                <tr key={row.method} className="border-b border-border/50">
                  <td className="py-4 pr-8 font-bold">{row.method}</td>
                  <td className="py-4 pr-8 text-muted-foreground">{row.storage}</td>
                  <td className="py-4 pr-8 text-muted-foreground">{row.compute}</td>
                  <td className="py-4">
                    <div className="flex items-center gap-3">
                      <div className="h-2 rounded-full bg-secondary w-32 overflow-hidden">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${row.q}%` }} />
                      </div>
                      <span className="text-muted-foreground text-xs">{row.q}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Edge Rule */}
      <section className="py-20 px-6 max-w-5xl mx-auto">
        <p className="text-sm font-mono text-primary tracking-widest uppercase mb-4">The Core Rule</p>
        <h2 className="text-3xl font-bold font-mono mb-8">Perpendicular Velocity Transfer</h2>
        <div className="p-8 rounded-xl bg-card border border-border font-mono text-sm leading-loose">
          <p className="text-muted-foreground">{"// At each shared edge between face A and face B:"}</p>
          <p>
            <span className="text-primary">v_tangential</span> = average(v_tang_A, v_tang_B)
          </p>
          <p>
            <span className="text-accent">v_perp_A</span> = −v_perp_B{" "}
            <span className="text-muted-foreground">{"// sign flip routes flow into volume"}</span>
          </p>
          <p className="mt-4 text-muted-foreground">{"// This single rule produces full 3D vorticity transport."}</p>
        </div>
      </section>

      {/* SDF Water Link */}
      <section className="py-20 px-6 max-w-5xl mx-auto text-center">
        <p className="text-sm font-mono text-primary tracking-widest uppercase mb-4">Next Evolution</p>
        <h2 className="text-3xl font-bold font-mono mb-4">Volumetric SDF Ocean</h2>
        <p className="text-muted-foreground max-w-xl mx-auto mb-8">
          Hierarchical parametric volumetric Signed Distance Field water — fullscreen raymarched with
          Beer-Lambert absorption, Fresnel reflections, caustics, foam, and adaptive LOD.
        </p>
        <Link
          to="/sdf-water"
          className="inline-block px-6 py-3 rounded-lg bg-primary text-primary-foreground font-mono font-bold hover:opacity-90 transition-opacity"
        >
          Launch SDF Ocean Demo →
        </Link>
      </section>

      {/* Footer */}
      <footer className="py-16 px-6 border-t border-border text-center text-muted-foreground text-sm font-mono">
        <p>CubeFace — Surface-Only 3D Fluid Simulation</p>
        <p className="mt-2">Interactive demo: 6 × 48² Stam stable-fluids solvers with edge coupling</p>
      </footer>
    </div>
  );
}
