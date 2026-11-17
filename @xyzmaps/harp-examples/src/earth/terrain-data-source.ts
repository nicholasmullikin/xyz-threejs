import { DataProvider, TileDataSource, TileFactory } from "@xyzmaps/harp-mapview-decoder";
import { Tile, DataSource } from "@xyzmaps/harp-mapview";
import { TileKey, webMercatorTilingScheme } from "@xyzmaps/harp-geoutils";
import { fetchTerrain } from "./math";
class TerrainProvider extends DataProvider {
    constructor(private token: string) {
        super();
    }
    ready() {
        return true;
    }
    protected connect() {
        return Promise.resolve();
    }
    protected dispose() {}
    getTile(key: TileKey, signal?: AbortSignal) {
        return fetchTerrain(key, this.token, signal);
    }
}
class TangentTile extends Tile {
    constructor(source: DataSource, key: TileKey) {
        super(source, key, 0, true);
    }
}
export class EarthTerrainDataSource extends TileDataSource<TangentTile> {
    constructor(token: string) {
        super(new TileFactory(TangentTile), {
            name: "terrain",
            tilingScheme: webMercatorTilingScheme,
            dataProvider: new TerrainProvider(token),
            concurrentDecoderServiceName: "png_decoder_service",
            concurrentDecoderScriptUrl: "decoder.bundle.js",
            minDataLevel: 0,
            maxDataLevel: 14,
            minGeometryHeight: 0,
            maxGeometryHeight: 9000,
            dataSourceOrder: -1
        });
    }
    async connect() {
        await super.connect();
        this.decoder.configure(
            {},
            {
                demEncoding: "terrainRgb",
                fillColor: "#182a36",
                elevationExaggeration: 1,
                continuousGrid: true
            }
        );
    }
    shouldPreloadTiles() {
        return true;
    }
}
