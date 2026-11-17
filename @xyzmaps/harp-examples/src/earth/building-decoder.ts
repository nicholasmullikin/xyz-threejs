import {
    DecodedTile,
    GeometryType,
    ITileDecoder,
    IndexedTechnique
} from "@xyzmaps/harp-datasource-protocol";
import { Projection, TileKey, webMercatorTilingScheme } from "@xyzmaps/harp-geoutils";
import {
    TileDecoderService,
    WorkerServiceManager
} from "@xyzmaps/harp-mapview-decoder/index-worker";
import { OrientedBox3 } from "@xyzmaps/harp-geoutils";
// Geometry generation stays independent of WebGL and runs in harp's worker pool.
import { buildTile } from "./building-geometry.mjs";
export const BUILDING_DECODER = "earth-buildings";
export class BuildingDecoder implements ITileDecoder {
    connect() {
        return Promise.resolve();
    }
    dispose() {}
    configure() {}
    getTileInfo() {
        return Promise.resolve(undefined);
    }
    async decodeTile(
        data: ArrayBuffer,
        key: TileKey,
        projection: Projection
    ): Promise<DecodedTile> {
        const decoded = buildTile(data, key.level, key.column, key.row);
        const box = new OrientedBox3();
        const geoBox = webMercatorTilingScheme.getGeoBox(key);
        geoBox.southWest.altitude = -1000;
        geoBox.northEast.altitude = 10000;
        projection.projectBox(geoBox, box);
        for (let i = 0; i < decoded.position.length; i++)
            decoded.position[i] +=
                decoded.origin[i % 3] - [box.position.x, box.position.y, box.position.z][i % 3];
        const technique: IndexedTechnique = {
            name: "shader",
            primitive: "mesh",
            params: {},
            _index: 0,
            _styleSetIndex: 0
        };
        return {
            techniques: [technique],
            boundingBox: box,
            geometries: decoded.count
                ? [
                      {
                          type: GeometryType.Polygon,
                          groups: [{ start: 0, count: decoded.position.length / 3, technique: 0 }],
                          objInfos: [{ count: decoded.count }],
                          vertexAttributes: (
                              [
                                  ["position", 3],
                                  ["normal", 3],
                                  ["uv", 2],
                                  ["baseUv", 2],
                                  ["color", 3],
                                  ["seed", 1],
                                  ["tileUv", 2]
                              ] as const
                          ).map(([name, itemCount]) => ({
                              name,
                              itemCount,
                              type: "float",
                              buffer: decoded[name].buffer as ArrayBuffer
                          }))
                      }
                  ]
                : []
        };
    }
}
WorkerServiceManager.getInstance().register({
    serviceType: BUILDING_DECODER,
    factory: id => TileDecoderService.start(id, new BuildingDecoder())
});
