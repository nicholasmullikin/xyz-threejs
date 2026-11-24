import { DataSource } from "@xyzmaps/harp-mapview";
import { DataSourceTileList } from "@xyzmaps/harp-mapview/lib/VisibleTileSet";
import { createTerrainTransitions } from "./terrain-transition";

export function create(
    three: typeof import("three"),
    source: DataSource,
    transition?: ReturnType<typeof createTerrainTransitions>
): (entries: ReadonlyArray<DataSourceTileList>) => void;
