# Source-owned Earth example

`main.ts` is the typed integration boundary. `runtime.js` coordinates independent subsystem modules; it does not own tile scheduling or replace materials after creation. `runtime.d.ts` documents the application-facing facade.

Terrain: `EarthTerrainDataSource` and the PNG worker decoder. `continuousGrid` disables the decoder's legacy skirts and texel inset; `continuity.js` supplies shared edge constraints and small radial skirts.

Buildings: `BuildingsDataSource` uses harp's worker service and `DecodedTile` geometry. `building-geometry.mjs` is pure footprint triangulation/extrusion; `building-material.js` supplies terrain anchoring, atmospheric shading, and illustrative windows. The provider limits concurrent HTTP requests, respects cancellation, and retries transient failures.

Imagery: `imagery.js` owns textures and fade snapshots. Harp owns tile-created materials. Source material creation occurs through `DataSource.createTileMaterial`, so no green placeholder is drawn before imagery assignment. `textures.js` aborts in-flight image fetches at disposal. Snapshot canvases are transient and disposed when transitions complete or geometry is released.

Effects: `atmosphere.js` owns optical-depth lookup and sky; `environment.js` owns cloud/night textures and wind timing. `cloud-model.js` supplies WMO family profiles, procedural weather, and performance budgets. `clouds.js` owns the spherical volume pass; `cloud-reconstruction.js` owns bounded render targets, temporal reprojection/rejection, and depth compositing. The packed 64³ cloud-noise atlas is generated offline by `scripts/build-cloud-noise.cjs` and uploaded without flipping or 2D mipmaps. Default balanced quality caps the cloud pass at 260,000 pixels and 40 samples per ray; WebGL 1 remains supported. `terrain-shaders.js` and `building-material.js` share their atmosphere/environment functions. Effect resources have explicit teardown; pagehide with `persisted: true` retains the scene for browser-history restoration.

Elevation: `elevation.js` supplies height, picking, and camera clearance for already displaced terrain. `MapView.setElevationProvider` registers sampling independently from `setElevationSource`, which would also apply displacement overlay. Do not enable both for the same terrain.

Units: CPU geometry is meters, atmosphere shaders are kilometers; Earth-centered world axes follow harp's spherical projection. Building offsets stay in world axes, terrain offsets are in each tile's tangent frame. Globe fallback objects use `MapAnchors`; screen-space effects remain scene objects with explicit draw order/depth.

Build from the repository root with `yarn build:earth`. Output is `dist/earth` by default; `node scripts/build-earth.cjs /other/staging/directory` builds elsewhere. `yarn typecheck:earth` checks the application, decoder, and imported engine APIs. This build explicitly aliases workspace packages to source, and aliases one Three.js instance across all modules.

The site consumes a verified manifest rather than patching the emitted JavaScript. See `site/docs/earth-renderer.md` for import and browser-regression workflows. All generated assets, including source maps and third-party licenses, are described by `earth-build.json`.
