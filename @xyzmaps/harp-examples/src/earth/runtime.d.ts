import { MapView, Tile, ElevationProvider, ClipPlanesEvaluator } from "@xyzmaps/harp-mapview";
import { DataSourceTileList } from "@xyzmaps/harp-mapview/lib/VisibleTileSet";
import { EarthTerrainDataSource } from "./terrain-data-source";
import { Material } from "three";
export interface EarthRuntime {
    update(entries: ReadonlyArray<DataSourceTileList>): void;
    createTileMaterial(tile?: Tile): Material;
    dispose(): void;
    performance: { snapshot(): unknown; gpuFrameMs(): number | undefined };
    stats: {
        requests: number;
        failures: number;
        fading: number;
        fallback: number;
        cache: number;
        cacheBytes: number;
        pending: number;
        untextured: number;
    };
    setSunHour(hour: number): void;
    setMode(mode: "a" | "c" | "reference"): void;
    setContours(value: boolean): void;
    setHillshade(value: number): void;
    readonly sun: import("three").Vector3;
    readonly cacheSize: number;
    readonly pendingCount: number;
    protectCamera(): void;
    elevationProvider: ElevationProvider;
    buildings: { stats: import("./building-data-source").BuildingStats; dispose(): void };
    environment: {
        status: { nightReady: boolean; cloudReady: boolean; noiseReady: boolean; errors: string[] };
        uniforms: Record<string, { value: any }>;
        cloudStats: {
            quality: string;
            steps: number;
            width: number;
            height: number;
            lowResolution: boolean;
            historyFrames?: number;
        };
        setCloudPreset(id: number | "forecast"): void;
        setCloudQuality(name: string): void;
    };
}
export function create(
    three: typeof import("three"),
    map: MapView,
    source: EarthTerrainDataSource,
    token: string
): EarthRuntime;
export function clipPlanes(): ClipPlanesEvaluator;
