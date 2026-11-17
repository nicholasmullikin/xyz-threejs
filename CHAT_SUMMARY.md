# Chat Summary: xyz-threejs Globe Terrain Rendering

This document summarizes the full conversation history across multiple chat sessions, covering work on the `rendering_globe-atmosphere.ts` example in the Harp.gl-based 3D globe renderer.

**Chat sessions referenced**:
- [Original session](3c19126e-ac31-4c20-bdbc-6b5f9cb6a64d) — Phases 1-8
- [Terrain gap fix](37c0330c-4726-43b1-b1de-f4f34e7070ca) — Boundary stitching
- [Mode 2 flash fix](546a1552-1922-45a4-a72a-132403e35caf) — Tile flash suppression
- [UI controls & time](8cd5bcc0-9fdb-4621-82b6-1721e68c48c4) — Sliders, toggles, day/night
- [Modernization](abeab050-9a5c-4afc-a510-317e55084689) — Repo modernization discussion

## Overview

The work spans several major feature areas, progressing from basic terrain decoder fixes through atmosphere compositing, z-fighting elimination, terrain gap stitching, and interactive UI controls. The primary file is `@xyzmaps/harp-examples/src/rendering_globe-atmosphere.ts` (~1750 lines), with supporting changes in the decoder pipeline and Harp library internals.

---

## Phase 1: Fix the Custom PNG Terrain Decoder

**Problem**: The PNG terrain decoder (`png_decoder.ts`) wasn't producing visible terrain geometry. Tiles loaded but showed as flat green patches.

**Root causes discovered**:
1. `PNGTileDecoder` extended `ThemedTileDecoder` which requires `m_styleSetEvaluator` to be initialized — but the PNG decoder never established it, so `decodeTile()` returned `undefined` before any PNG work ran.
2. The decoder emitted a `fill` technique, which maps to `MapMeshBasicMaterial` (ignores normals/lighting), making 3D terrain look flat.
3. Tile dimensions were computed from an axis-aligned bounding box instead of the oriented bounding box used by sphere projection.
4. The elevation Z-offset formula produced unreasonable values.

**Fixes applied**:
- Rewrote the decoder to bypass `ThemedTileDecoder`'s style evaluator dependency
- Switched from `fill` to `standard` technique for `MapMeshStandardMaterial` with proper lighting
- Fixed tile dimension calculations for sphere projection
- Corrected the elevation offset formula

**Plans referenced**: `fix_custom_decoder_flow_799b07e5.plan.md`, `fix_terrain_elevation_rendering_b8c33c8a.plan.md`

---

## Phase 2: Tile Visibility and Flickering

**Problem**: Terrain tiles would load, render correctly for a moment, then disappear. The issue was worst at oblique camera angles (high tilt).

**Investigation approach**:
- Added extensive logging for tile visibility changes (added/removed events)
- Added per-tile on-screen debug overlays showing tile key, data source name, and state (OK, LOADING, skip-render, fallback-parent, etc.)
- Added right-click tile inspector printing all data sources for a clicked tile to console
- Added raycasting debug to detect tiles that were on-screen but culled by the frustum
- Named anonymous data sources for clarity (the default Harp vector source was showing as `anonymous-datasource#1`)

**Root cause**: Harp's `VisibleTileSet` was culling terrain tiles using bounding boxes that didn't account for the 15x elevation exaggeration. Tiles whose exaggerated peaks extended above the frustum's bounding volume were being dropped. Additionally, the `maxGeometryHeight` on the terrain data source needed to be set to `MAX_TERRAIN_ELEVATION_M * ELEVATION_EXAGGERATION` (135 km) to expand the tile bounding boxes.

**Fix**: Set `terrainDataSource.maxGeometryHeight` correctly after adding the data source, and adjusted the `maxTiltAngle` to 90 degrees.

---

## Phase 3: Debug HUD and Visualization Tools

Built a comprehensive debug overlay that persists across the session:

- **HUD panel** (toggle `H`): FPS, frame count, camera altitude/near/far/tilt/zoom/heading/FOV, tile counts by zoom level, loading count, gap count, max geometry height, overlay mode, texture cache stats
- **Per-tile labels**: Rendered as HTML overlays at each tile's screen position, showing tile key (z/x/y), data source states (background/terrain/osm-vector), and loading status with color coding (green = OK, orange = loading, red = error)
- **Wireframe toggle** (`W`): Toggles wireframe rendering on terrain meshes
- **Far ring** (`F`): Red circle at the camera's far clip plane distance
- **Gap dots** (`G`): Visual markers for screen positions where terrain tiles are missing
- **Right-click inspector**: Logs detailed tile info for all data sources at the clicked geo-coordinate

---

## Phase 4: Satellite Texture Draping (Mode A)

**Problem**: The vector tile rendering from Harp competed with the terrain mesh — vector tiles would render on top and hide the terrain.

**Solution**: Implemented Option A — raster satellite texture draping:
- Fetch Mapbox satellite tiles (`mapbox.satellite/{z}/{x}/{y}@2x.png`) via `THREE.TextureLoader`
- Apply as `map` texture on the terrain mesh's `MapMeshStandardMaterial`
- Texture cache (`Map<string, THREE.Texture>`) and pending-request deduplication
- Applied via 500ms `setInterval` polling loop (Harp's `AfterRender` event was unreliable)

---

## Phase 5: Custom Shader Mode (Mode C) — Vector Map + Hillshade + Contours

**Plan**: `terrain_shader_blend_acfb9b8a.plan.md`

Replaced the floating-geometry vector overlay with a custom `THREE.ShaderMaterial` that paints OSM raster tiles directly on the terrain surface with hillshading and contour lines.

**Vertex shader**: Passes `vUv`, `vNormal` (via `normalMatrix`), `vWorldPos` (via `modelMatrix`), and `vFogDepth` (view-space Z) to the fragment shader.

**Fragment shader pipeline**:
1. Sample `colorMap` (OSM raster tile) at `vUv`
2. Compute hillshade: `dot(N, L) * 0.5 + 0.5`, mixed by `hillshadeStrength`
3. Day/night shading: `smoothstep(-0.1, 0.3, dot(radialDir, sunDirection))`
4. Optional contour lines from `heightMap` (DEM re-fetch): `mod(elevation, contourInterval)` with `smoothstep` anti-aliasing
5. Distance fog: `smoothstep(fogNear, fogFar, vFogDepth)`, blending toward `fogColor`

**Uniforms**: `colorMap`, `heightMap`, `lightDir` (hillshade), `sunDirection` (day/night), `hillshadeStrength`, `contourInterval`, `contourColor`, `contourWidth`, `elevationExaggeration`, `contoursEnabled`, `fogColor`, `fogNear`, `fogFar`

**Keyboard controls**:
- `1` = satellite mode, `2` = vector+shade mode
- `+`/`-` = adjust hillshade strength
- `C` = toggle contour lines

---

## Phase 6: Horizon Fog

**Problem**: At oblique angles looking toward the horizon, exaggerated terrain peaks created jagged edges against the atmosphere.

**Solution**: Dynamic distance fog that fades terrain toward a dark sky color near the horizon:
- Created `THREE.Fog` with color `0x000210` (dark blue-black)
- `updateFog()` runs every 500ms, calculates `near` and `far` based on camera altitude and geometric horizon distance: `near = camAlt + 0.4 * (horizonDist - camAlt)`, `far = horizonDist * 0.92`
- Updates both `scene.fog` (for satellite mode's `MeshStandardMaterial`) and custom shader uniforms (for mode C)
- Re-assigns `map.scene.fog` every tick because Harp's `MapViewFog` can clear it

---

## Phase 7: Fix Terrain-Atmosphere Compositing

**Plan**: `fix_terrain-atmosphere_compositing_e045b56e.plan.md`

**Problem**: Two issues caused a visible discontinuity at the horizon:
1. The ground atmosphere mesh was at `EarthRadius * 1.0001` (only 638m above sea level), while terrain peaks reached 135km (9000m * 15x exaggeration). Terrain poked above the atmosphere's darkening arc.
2. Terrain materials had no concept of global illumination direction — the night side of the globe stayed bright.

**Fixes**:

### Fix 1: Enlarge ground atmosphere mesh
Changed `GROUND_ATMOSPHERE_ALTITUDE_FACTOR` in `MapViewAtmosphere.ts` from `0.0001` to `0.022`, yielding a radius of `EarthRadius + 140km` — just above max terrain height but below the sky atmosphere at `EarthRadius * 1.025`.

### Fix 2: Night-side shading on custom shader (mode C)
Added `sunDirection` uniform `(0, 1, 0)` matching the atmosphere's `m_lightDirection`. Fragment shader computes:
```glsl
vec3 radialDir = normalize(vWorldPos);
float dayFactor = dot(radialDir, sunDirection);
float nightShade = smoothstep(-0.1, 0.3, dayFactor);
color *= nightShade;
```

### Fix 3: Scene lighting for satellite mode (mode A)
Override the theme's directional light to match atmosphere sun direction `(0, 1, 0)` with intensity 1.5, and reduce ambient to 0.15 for meaningful day/night contrast. Uses `syncLights()` running every 500ms, caching references to the theme's `DirectionalLight` and `AmbientLight` to avoid repeated scene traversal.

---

## Phase 8: Z-Fighting / Shimmering Triangles

**Problem**: Moving the camera causes shimmering triangles, worst on ocean areas. The terrain mesh and Harp's background vector tile geometry occupy the same depth at sea level.

**Approaches tried**:
1. **Polygon offset on terrain shader material** (`polygonOffsetFactor: -1, polygonOffsetUnits: -1`): Did not fully resolve — only affected mode C, not satellite mode.
2. **Hide background data source objects** (`setBackgroundVisible(false)` unconditionally): Fixed z-fighting but caused empty black tiles while terrain was loading.
3. **Polygon offset on satellite material** (in `applyTextureToTile`): Caused tiles to appear then disappear — likely interference with Harp's material lifecycle.
4. **Polygon offset on background materials** (`pushBackgroundBack()`): Final approach — pushes Harp's vector tile geometry backward in the depth buffer (`polygonOffsetFactor: +1, polygonOffsetUnits: +1`). In satellite mode, background objects are hidden entirely (`obj.visible = false`).

---

## Phase 9: Terrain Gap Stitching

**Chat**: [Terrain gap fix](37c0330c-4726-43b1-b1de-f4f34e7070ca)

**Problem**: Visible gaps/seams between adjacent terrain tiles in satellite mode, worst at oblique viewing angles. Adjacent tile meshes had slightly different vertex positions along shared edges due to independent DEM decoding.

**Solution**: Boundary stitching system with two strategies:

### Same-level stitching (`stitchSameLevelEdge`)
For adjacent tiles at the same zoom level, averages world-space vertex positions along the shared edge. Uses an `OVERLAP_KEEP` factor (0.15) to pull vertices slightly past the midpoint, eliminating hairline gaps.

### Cross-level stitching (`stitchCrossLevelEdge`)
For a parent tile adjacent to two child tiles (different zoom levels), interpolates the parent's edge positions and conforms child vertices to match. Uses fractional offset (`childFrac` 0 or 0.5) to handle top/bottom or left/right child tiles.

**Implementation details**:
- Grid size: 64x64 vertices per tile (`GRID_W = GRID_H = 64`)
- `getTilePos()` extracts position buffer and world/local matrices from a tile's mesh
- `stitchTerrainBoundaries()` runs every frame in the render callback, iterating all visible terrain tiles and stitching right and bottom boundaries (each pair only needs to be stitched from one side)
- Handles both same-level neighbors and parent-to-child (one zoom level difference) neighbors

---

## Phase 10: Tile Flash Suppression (Mode C)

**Chat**: [Mode 2 flash fix](546a1552-1922-45a4-a72a-132403e35caf)

**Problem**: In overlay mode 2 (vector+shade), new tiles would flash through three visible states: background tile, then green fill terrain tile, then final textured tile. The progression was `background → decoder fill material → ShaderMaterial with textures`.

**Mitigation**: The 500ms polling interval in the `setInterval` loop applies `applyTerrainShader()` which swaps the decoder's fill material for the custom ShaderMaterial as soon as the tile has geometry. Textures are loaded asynchronously via `ensureShaderTextures()` and applied as they arrive without re-creating the material.

---

## Phase 11: UI Controls and Day/Night Cycle

**Chat**: [UI controls & time](8cd5bcc0-9fdb-4621-82b6-1721e68c48c4)

### Tile overlay toggle
- Added `showTileOverlay: false` to `debugState` (default off)
- Toggle with `[T]` key
- Guards `drawTileOverlay()` — per-tile labels and borders only render when enabled
- Gap dots and HUD statistics still compute independently

### Terrain exaggeration slider
- Mutable `ELEVATION_EXAGGERATION` (default: 2, range: 1-40)
- HTML range input in a shared slider tray at bottom of viewport
- `setElevationExaggeration(value)`: updates the decoder options, reconfigures the web worker via `terrainDataSource.decoder.configure()`, clears tile cache with `map.clearTileCache("terrain")`, and updates `maxGeometryHeight`

### Time-of-day slider
- `sunTimeHours` (default: 8.0, range: 0-24, step: 0.25 = 15min)
- Label shows `Time: HH:MM`
- `setSunTime(hours)` computes sun direction as rotation in XY plane:
  ```
  angle = (hours / 24) * 2π
  SUN_DIR = (sin(angle), cos(angle), 0)
  ```
- Updates three systems:
  1. `SUN_DIR` — picked up by `syncLights()` for directional light position
  2. `atmosphere.m_lightDirection` — drives sky/ground scattering shaders (accessed via `(atmosphere as any).m_lightDirection.copy()` since the field is private)
  3. Terrain shader `sunDirection` uniform — drives per-fragment day/night shading on all visible terrain tiles

### Default camera position
```typescript
const DEFAULT_TARGET = new GeoCoordinates(35.129331, -112.536408);
const DEFAULT_LOOK_DISTANCE_M = 28429;
const DEFAULT_TILT_DEG = 82.5;
const DEFAULT_HEADING_DEG = 91.9;
```
Grand Canyon, low oblique view, morning light (8 AM).

### HUD additions
- `exag: N×` — current elevation exaggeration
- `time: HH:MM` — current simulated time
- `[T] tile overlay: ON/OFF` in the keyboard legend

---

## Planned: Realistic Sunset Lighting

**Plans**: `realistic_sunset_lighting_b659dab4.plan.md`, `satellite_sunset_shader_92d29028.plan.md`

**Status**: Planned but not yet fully implemented. The sunset improvements require:

1. **Sun-elevation color ramp** (`getSunLighting()`) — Maps sun elevation to light color (white→orange→red→dim blue), intensity, ambient, and fog color across midday/golden-hour/twilight/night
2. **Dynamic light color in `syncLights()`** — Currently hardcoded white at 1.5 intensity; needs to use the ramp
3. **Terrain shader sunset tint** — Add `sunColor`/`sunIntensity` uniforms; replace the sharp `smoothstep(-0.1, 0.3)` day/night with a softer transition plus warm orange terminator band
4. **Dynamic fog color** — Shift from dark blue-black at night to warm orange/red at sunset
5. **Satellite mode shader** — Replace `MeshBasicMaterial` with a `ShaderMaterial` that receives `sunDirection`/`sunColor`/`sunIntensity` so satellite terrain also shows day/night and sunset tinting (currently unlit)

The atmosphere scattering shaders (O'Neil model in `SkyAtmosphereMaterial`/`GroundAtmosphereMaterial`) already produce natural Rayleigh reddening at low sun angles, so those don't need changes.

---

## Files Modified

| File | Changes |
|------|---------|
| `@xyzmaps/harp-examples/src/rendering_globe-atmosphere.ts` | Main example (~1750 lines): terrain decoder setup, satellite draping, custom shader, fog, debug HUD, tile overlays, mode switching, lighting, boundary stitching, exaggeration slider, time-of-day slider |
| `@xyzmaps/harp-examples/decoder/png_decoder.ts` | New PNG terrain decoder (replaces `terrain_rgb_decoder.ts`) |
| `@xyzmaps/harp-examples/decoder/decoder.ts` | Worker entry point registering the PNG decoder service |
| `@xyzmaps/harp-examples/decoder/custom_decoder_defs.ts` | Service type constants for the PNG decoder |
| `@xyzmaps/harp-examples/package.json` | Dependencies for the terrain data source |
| `@xyzmaps/harp-mapview/lib/MapViewAtmosphere.ts` | Changed `GROUND_ATMOSPHERE_ALTITUDE_FACTOR` from `0.0001` to `0.022` |
| `@xyzmaps/harp-mapview-decoder/lib/TileDataSource.ts` | Minor fixes for decoder integration |
| `@xyzmaps/harp-mapview-decoder/lib/TileDecoderService.ts` | Minor fixes for decoder integration |
| `@xyzmaps/harp-terrain-datasource/src/index.js` | Terrain data source module exports |

---

## Architecture

```
rendering_globe-atmosphere.ts
├── TerrainDataSource (DEM from Mapbox terrain-rgb)
│   ├── png_decoder.ts (Web Worker)
│   │   └── Decodes PNG → vertex positions on sphere with elevation
│   └── Produces mesh with MapMeshStandardMaterial + standard technique
├── Mode A: Satellite
│   ├── applyRasterTexture() → Mapbox satellite tiles as MeshBasicMaterial.map
│   ├── forceEmissiveMaterials() → ensures correct material per frame
│   ├── Texture padding (TEX_PAD=4) + neighbor edge padding for seam-free tiling
│   ├── Parent-derived textures for tiles awaiting their own fetch
│   └── syncLights() → DirectionalLight(SUN_DIR) + AmbientLight(0.15)
├── Mode C: Vector + Shade
│   ├── applyTerrainShader() → Custom ShaderMaterial
│   │   ├── colorMap: OSM raster tiles
│   │   ├── heightMap: DEM re-fetch for contour lines
│   │   ├── Hillshading from vertex normals + lightDir
│   │   ├── Day/night from sunDirection (smoothstep terminator)
│   │   └── Distance fog from vFogDepth
│   └── Keyboard: +/- hillshade, C contours
├── Boundary Stitching
│   ├── stitchSameLevelEdge() — average shared vertices between same-zoom neighbors
│   ├── stitchCrossLevelEdge() — conform child edges to interpolated parent positions
│   └── stitchTerrainBoundaries() — runs per-frame, iterates right + bottom edges
├── Atmosphere
│   ├── MapViewAtmosphere (sky + ground spheres, O'Neil scattering)
│   ├── Ground sphere enlarged to R+140km (covers terrain peaks)
│   └── Dynamic light mode: m_lightDirection tracks SUN_DIR
├── Day/Night Cycle
│   ├── setSunTime(hours) → SUN_DIR rotation in XY plane
│   ├── Updates: atmosphere, terrain shader sunDirection uniform, directional light
│   └── Time-of-day slider (0-24h, default 8:00)
├── Fog
│   ├── THREE.Fog on scene (for MeshStandardMaterial / satellite mode)
│   ├── Custom shader uniforms fogNear/fogFar/fogColor (for mode C)
│   └── updateFog(): dynamic near/far from camera altitude + horizon distance
├── UI Controls (bottom slider tray)
│   ├── Terrain exaggeration slider (1-40×, default 2×)
│   └── Time-of-day slider (0-24h, default 08:00)
├── Background globe sphere (R-100m, MeshBasicMaterial, renderOrder -1)
├── pushBackgroundBack(): polygon offset / hide background vector tiles
└── Debug tools
    ├── HUD overlay [H]: FPS, camera, tile stats, exag, time, overlay mode
    ├── Tile overlay [T] (default off): per-tile labels with state badges
    ├── Tile borders [D], Wireframes [W], Far ring [F], Gap dots [G]
    ├── Solid green [S]
    └── Right-click tile inspector (console)
```

---

## Keyboard Controls

| Key | Action |
|-----|--------|
| `1` | Switch to satellite overlay mode |
| `2` | Switch to vector+shade overlay mode |
| `+`/`-` | Adjust hillshade strength (mode C) |
| `C` | Toggle contour lines (mode C) |
| `H` | Toggle HUD overlay |
| `T` | Toggle tile overlay labels (default off) |
| `D` | Toggle tile border outlines |
| `W` | Toggle wireframe rendering |
| `F` | Toggle far-plane ring |
| `G` | Toggle gap dots |
| `S` | Toggle solid green debug material |

---

## Open Issues

1. **Sunset realism** — Directional light color, terrain shader tinting, and fog color are all static with respect to time of day. Plans exist (`realistic_sunset_lighting`, `satellite_sunset_shader`) but are not yet implemented. The atmosphere scattering provides some natural reddening but the terrain and scene lighting don't respond.
2. **Satellite mode is unlit** — Mode A uses `MeshBasicMaterial` which ignores directional light entirely. Day/night on satellite tiles only works through the scene's ambient+directional lighting effect on `MeshStandardMaterial` (which was the original decoder material), but after `forceEmissiveMaterials()` swaps to `MeshBasicMaterial`, the satellite tiles are effectively fullbright. A custom shader is needed for proper day/night on satellite imagery.
3. **Atmosphere glitch** — User reports a pre-existing visual artifact at the atmosphere boundary, possibly z-fighting between sky and ground atmosphere spheres.
4. **Tile loading performance** — At high zoom levels with many tiles, the page can drop to very low FPS during initial load.
