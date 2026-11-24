# Source-owned Earth example

`main.ts` is the typed integration boundary. `runtime.js` coordinates independent subsystem modules; it does not own tile scheduling or replace materials after creation. `runtime.d.ts` documents the application-facing facade.

Terrain: `EarthTerrainDataSource` and the PNG worker decoder. `continuousGrid` disables the decoder's legacy skirts and texel inset; `continuity.js` supplies shared edge constraints and small radial skirts.

### Optional USGS 1 m terrain

The interactive map can refine its worldwide surface with public-domain U.S. Geological Survey 3DEP bare-earth elevation where a pack contains survey coverage. To build one, run this from the fork root with [uv](https://docs.astral.sh/uv/). Bounds are west, south, east and north in degrees. Repeat `--bbox` to build disjoint areas together.

```sh
uv run --python 3.12 scripts/build-usgs-terrain.py \
  --bbox -119.851 34.398 -119.838 34.411 \
  --output /tmp/coastal-terrain-v1
```

To reproduce a published release from its recorded survey URLs and bounds, run `uv run --python 3.12 scripts/build-usgs-terrain.py --sources-json /path/to/sources.json --output /tmp/rebuilt-pack`.

Serve the entire output directory as ordinary static files and pass a relative or CORS-enabled absolute manifest URL in the demo's `terrain_pack` query parameter. A public Earth page can forward the same parameter with an optional numeric camera pose in `view=latitude,longitude,targetHeightMeters,distanceMeters,tiltDegrees,headingDegrees`. The Gatsby map iframe also accepts `GATSBY_EARTH_TERRAIN_PACK` at build time. Use a new versioned output directory when updating a pack. Animated article backgrounds do not request detailed terrain.

The builder discovers 1 m GeoTIFFs through the National Map catalog, reads remote COG ranges, reprojects each source through its declared CRS and prioritizes the newest published product where surveys overlap. It writes zoom 16 and 17 Terrain-RGB PNGs in meters. Alpha encodes distance to the survey boundary. The worker blends with the displayed zoom 15 parent over a wider band where source heights disagree. Native 1 m surveys have partial U.S. coverage and local vertical datums can differ from the underlying global source. `sources.json` records the contributing surveys and their dates. The default 256-tile cap bounds a build before catalog or raster requests. Increase `--max-tiles` for larger areas. The browser loads availability by zoom 8 region and requests only listed pages as its terrain budget permits. [USGS 3DEP products](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services)

The full demo can also load the documented Mapterhorn dataset via `?terrain=mapterhorn`. A lazy PMTiles reader checks the regional index before requesting high-resolution data. Source WebPs are shared among sibling patches, then cropped and decoded in the terrain worker. When no Mapbox token is configured, Mapterhorn also provides the global base elevations. [Public endpoint and archive layout](https://mapterhorn.com/data-access/) · [Data-source licenses and credits](https://mapterhorn.com/attribution/)

Buildings: `BuildingsDataSource` uses harp's worker service and `DecodedTile` geometry. `building-geometry.mjs` is pure footprint triangulation/extrusion; `building-material.js` supplies terrain anchoring, atmospheric shading, and illustrative windows. The provider limits concurrent HTTP requests, respects cancellation, and retries transient failures.

Imagery: `imagery.js` owns textures and fade snapshots. Harp owns tile-created materials. Source material creation occurs through `DataSource.createTileMaterial`, so no green placeholder is drawn before imagery assignment. `textures.js` aborts in-flight image fetches at disposal. Snapshot canvases are transient and disposed when transitions complete or geometry is released.

Effects: `atmosphere.js` owns optical-depth lookup and sky; `environment.js` owns cloud/night textures and wind timing. `cloud-model.js` supplies WMO family profiles, procedural weather, and performance budgets. `clouds.js` owns the spherical volume pass; `cloud-reconstruction.js` owns bounded render targets, temporal reprojection/rejection, and depth compositing. The packed 64³ cloud-noise atlas is generated offline by `scripts/build-cloud-noise.cjs` and uploaded without flipping or 2D mipmaps. Default balanced quality caps the cloud pass at 260,000 pixels and 40 samples per ray; WebGL 1 remains supported. `terrain-shaders.js` and `building-material.js` share their atmosphere/environment functions. Effect resources have explicit teardown; pagehide with `persisted: true` retains the scene for browser-history restoration.

Elevation: `elevation.js` supplies height, picking, and camera clearance for already displaced terrain. `MapView.setElevationProvider` registers sampling independently from `setElevationSource`, which would also apply displacement overlay. Do not enable both for the same terrain.

Units: CPU geometry is meters, atmosphere shaders are kilometers; Earth-centered world axes follow harp's spherical projection. Building offsets stay in world axes, terrain offsets are in each tile's tangent frame. Globe fallback objects use `MapAnchors`; screen-space effects remain scene objects with explicit draw order/depth.

Build from the repository root with `yarn build:earth`. Output is `dist/earth` by default; `node scripts/build-earth.cjs /other/staging/directory` builds elsewhere. `yarn typecheck:earth` checks the application, decoder, and imported engine APIs. This build explicitly aliases workspace packages to source, and aliases one Three.js instance across all modules.

The site consumes a verified manifest rather than patching the emitted JavaScript. See `site/docs/earth-renderer.md` for import and browser-regression workflows. All generated assets, including source maps and third-party licenses, are described by `earth-build.json`.

The interactive demo accepts `?imagery=worldcover` to opt in to the ESA WorldCover 2021 Sentinel-2 annual true-colour composite, served by Terrascope. It covers land from 60°S to 83°N at approximately 10 m, and the published Web Mercator service provides zoom levels 8–14. Transparent water and missing data show the local globe overview. This optional source is independent of the Mapbox token and is never requested by the default map or article background. © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021), processed by the ESA WorldCover consortium. [Dataset and access](https://esa-worldcover.org/en/data-access).

`?imagery=swissimage` instead opts in to the official swisstopo SWISSIMAGE product, including its PNG coverage transparency. Its available regional tiles are requested only where the published product extent intersects the view; other areas use the globe overview. The current aerial imagery can differ in date between locations. © swisstopo. [Service documentation](https://docs.geo.admin.ch/visualize-data/wmts.html) · [Free geodata terms](https://www.swisstopo.admin.ch/en/faq-free-geodata).
