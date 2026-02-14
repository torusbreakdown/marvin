# Text-First Procgen Level Editor Architecture

This document maps an architecture for a **text-based scene description** that is **compiled/cooked** into runtime data, with a **side-by-side live preview** driven by a **command-line build/watch loop** and an **MCP tool surface**.

## Goals / non-goals

**Goals**
- Authoring is primarily **procedural + parameterized**, but we still support **manual (hand-authored) scene editing** for anchors, set dressing, and targeted overrides.
- Source of truth is a **text scene description** (diffable, mergeable, reviewable).
- A **compiler** expands procgen deterministically into a frozen scene **IR** and then into a runtime **cooked** format.
- A **side-by-side preview** shows *text + diagnostics/logs* next to an in-engine viewport.
- A **CLI** is the primary driver; UI is a thin client.
- First-class support for **MCP tools** for automation (validate/build/expand/diff/sample/metrics).

**Non-goals**
- Full DCC replacement (no need to replicate Blender).
- Heavy in-viewport editing tools (keep gizmos minimal).

---

## High-level picture

```
     (author)                  (build system)                         (runtime)
┌──────────────┐         ┌─────────────────────┐              ┌─────────────────┐
│ scene files  │  watch  │ scene compiler      │  hot-reload  │ engine preview  │
│  *.scene     ├────────▶│  parse/validate     ├─────────────▶│  loads cooked   │
│  *.proc      │         │  expand procgen     │              │  draws viewport │
│  assets refs │         │  emit IR + cooked   │              │  selection sync │
└──────┬───────┘         └─────────┬───────────┘              └────────┬────────┘
       │                             │                                   │
       │ diagnostics (JSON)          │ artifacts                           │
       ▼                             ▼                                   ▼
┌──────────────┐         ┌─────────────────────┐              ┌─────────────────┐
│ side-by-side │         │ build cache         │              │ UI thin client   │
│ text + logs  │         │ (incremental)       │              │ (optional)       │
└──────────────┘         └─────────────────────┘              └─────────────────┘

MCP surface (AI/tools):
┌──────────────────────────────────────────────────────────────────────────┐
│ mcp server -> wraps CLI/compiler as tools: validate/build/expand/diff/... │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Source formats

### 1) Scene DSL (authoring)
A human-authored DSL that supports:
- *Declarations*: worlds, layers, entities, components.
- *Procgen blocks*: generators with parameters.
- *Hand-authored edits*: explicit entities/components/transforms, plus small targeted tweaks/overrides.
- *Deterministic seeding*: explicit seeds + hierarchical seed derivation.
- *Includes/modules*: reusable templates.
- *Constraints*: validation rules, ranges, references.

Keep the DSL intentionally small; push complexity into generators.

Example (illustrative):

```txt
scene "dungeon_01" {
  seed: 12345
  units: meters

  import "modules/lighting.scene"

  generator "dungeon" {
    algo: "rooms_and_corridors"
    seed: seed("dungeon")
    params {
      room_count: 24
      min_room: [6,6]
      max_room: [14,14]
      corridor_width: 2
    }
    output {
      mesh: true
      navmesh: true
      spawn_points: true
    }
  }

  entity "player_start" {
    transform { pos: [0,1.8,0], rot: [0,0,0] }
    component SpawnPoint { tag: "player" }
  }
}
```

### 2) IR (expanded, explicit)
An intermediate representation that is:
- Fully expanded (procgen results are explicit geometry/instances/entities)
- Stable-ID addressed
- Versioned and schema-validated
- Optimized for *diffing* and *debugging*

Suggested encodings:
- JSON (debug) + binary (fast)
- Or a custom binary with optional JSON dump for inspection

### 3) Cooked runtime format
A compact load format for the engine (e.g. chunked binary):
- Streamable (chunk headers)
- Referencing cooked assets by content hash
- Optional strip of editor-only metadata

---

## Compiler pipeline

### Stages
1. **Parse**: DSL → AST
2. **Resolve**: imports, symbol tables, asset refs
3. **Validate**: schema + semantic checks
4. **Expand procgen**: run generators → produce explicit entities/instances
5. **Assign stable IDs**: generate persistent IDs for entities/components
6. **Emit IR**: write expanded IR + provenance map
7. **Cook**: IR → runtime chunks (meshes, instances, navmesh, spawn tables)

### Determinism rules
- Procgen must be **pure given inputs**: (source text, assets, seed, tool version).
- Seeds are explicit and derived via a stable function:
  - `seed("dungeon") = hash64(scene_seed, "dungeon")`
- All randomness uses the project RNG (e.g. PCG32/64) seeded from derived seeds.

### Incremental rebuild
Cache keys include:
- file content hash of scene/proc modules
- generator version hash
- referenced asset hashes
- compiler version

The watch mode should avoid re-running unchanged generators.

---

## Procgen runtime (generator framework)

### Generator contract
Each generator should expose:
- **Inputs**: parameters, seed(s), referenced assets
- **Outputs**: explicit scene contributions (entities/instances/geometry/nav)
- **Diagnostics**: warnings/errors + optional debug overlays
- **Provenance**: mapping from output items → source location + generator node

Pseudo-interface:

```cpp
struct GenContext {
  RNG rng;
  AssetDB* assets;
  Diagnostics* diag;
  // optional: job system, scratch allocators, etc.
};

struct GenResult {
  SceneIRDelta delta;
  ProvenanceMap prov;
};

GenResult run_generator(const GenContext&, const GenParams&);
```

### Provenance is critical
It enables:
- Clicking an object in the viewport → jump to text generator/parameter
- Diagnostics that pinpoint which generator emitted problematic content

---

## Diagnostics & logging

Prefer structured JSON diagnostics so the UI, CLI, and MCP tools can all consume the same data.

Example diagnostic object:

```json
{
  "severity": "error",
  "code": "E2003",
  "message": "Unknown asset: meshes/doorway.glb",
  "file": "scenes/dungeon_01.scene",
  "range": {"start": {"line": 18, "col": 12}, "end": {"line": 18, "col": 33}},
  "notes": ["Did you mean meshes/doorway_01.glb?"],
  "provenance": {"generator": "dungeon", "node": "doors"}
}
```

---

## Side-by-side preview app

### What it is
A single process (or two tightly-coupled processes) that shows:
- Left: text editor + build output/diagnostics + optional IR diff
- Right: engine viewport (in-engine render) with selection/highlight

### Process topology
Pick one:

**A) Single process** (editor embeds engine)
- Pros: easiest selection sync, no IPC
- Cons: more complex build/watch isolation

**B) Two processes** (recommended)
- `scene build --watch` runs as a CLI/daemon
- Engine preview is a separate process that subscribes to reload events
- Pros: crashes isolated, cleaner “compiler as product” boundary

### Sync model
- Build daemon emits: `build_id`, artifact paths, and a reload message.
- Preview loads cooked scene; it also loads a small **Editor Metadata Sidecar**:
  - entity stable IDs
  - provenance map

Selection persistence:
- UI stores selected stable ID(s)
- After reload, it re-resolves ID → runtime handle

---

## CLI commands (primary workflow)

Minimum set:

- `scene validate <file.scene>`
  - parse + resolve + validate only

- `scene expand <file.scene> --out build/scene.ir.json`
  - run procgen, emit expanded IR for debugging

- `scene build <file.scene> --out build/scene.bin`
  - full compile + cook

- `scene build --watch scenes/`
  - incremental builds + emits reload notifications

- `scene diff build/a.ir.json build/b.ir.json`
  - IR-aware diff (stable ID keyed)

- `scene sample <file.scene> --seed 123 --shots 10`
  - batch-generate variants; output metrics (coverage, counts)

- `scene metrics <file.scene>`
  - counts, memory estimates, navmesh stats, etc.

---

## MCP tool surface

Wrap the CLI as MCP tools so an LLM (or other automation) can:
- validate and fix errors
- tune procgen parameters
- generate variants and compare metrics
- produce diffs and summaries

Suggested MCP tools:
- `scene.validate({path}) -> {ok, diagnostics[]}`
- `scene.build({path, mode:"debug"|"release"}) -> {artifacts, diagnostics[]}`
- `scene.expand({path}) -> {ir_path, diagnostics[]}`
- `scene.diff({a_ir_path, b_ir_path}) -> {summary, changes[]}`
- `scene.sample({path, seeds[], metrics[]}) -> {runs[]}`
- `scene.metrics({path}) -> {counts, estimates}`

Keep MCP outputs structured; avoid free-form logs as the primary channel.

---

## Minimal gizmo philosophy (still useful)

Keep only what accelerates debugging and manual text authoring:
- Click select + outline
- Frame selected
- Toggle debug overlays (navmesh, generator partitions, spawn volumes)
- Numeric transform/component fields for hand-authored anchors

Everything else should be parameters in text + generator outputs.

---

## Implementation sequencing (practical)

1. Implement DSL + diagnostics + `scene validate`.
2. Add generator framework + deterministic RNG + `scene expand`.
3. Define IR + stable IDs + provenance sidecar.
4. Add cooker + runtime loader + hot-reload.
5. Add watch daemon + reload notifications.
6. Add MCP wrapper over CLI.
7. Add thin UI (text + diagnostics + viewport) on top.

---

## Notes / sharp edges

- **Stable IDs**: treat as part of the IR schema; don’t base on array indices.
- **Versioning**: embed compiler + generator version hashes into artifacts.
- **Sandboxing**: procgen should have controlled I/O; no hidden file reads.
- **Debuggability**: always allow dumping expanded IR and provenance.
- **Performance**: support partial rebuild (generator-level cache) early.
