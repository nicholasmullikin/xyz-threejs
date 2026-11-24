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
import { splitRoofTags } from "./roof-tags";
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
        const { tile, tags } = splitRoofTags(data);
        const decoded = buildTile(tile, key.level, key.column, key.row, tags, true);
        const box = new OrientedBox3();
        const geoBox = webMercatorTilingScheme.getGeoBox(key);
        geoBox.southWest.altitude = -1000;
        geoBox.northEast.altitude = 10000;
        projection.projectBox(geoBox, box);
        const dx = decoded.origin[0] - box.position.x,
            dy = decoded.origin[1] - box.position.y,
            dz = decoded.origin[2] - box.position.z;
        for (const chunk of decoded.chunks)
            for (let i = 0; i < chunk.position.length; i += 3) {
                chunk.position[i] += dx;
                chunk.position[i + 1] += dy;
                chunk.position[i + 2] += dz;
            }
        const technique: IndexedTechnique = {
            name: "shader",
            primitive: "mesh",
            params: {},
            _index: 0,
            _styleSetIndex: 0
        };
        const tileInfo = decoded.water
            ? {
                  tileKey: key,
                  numBytes: decoded.water.byteLength,
                  setupTime: 0,
                  water: decoded.water
              }
            : undefined;
        return {
            tileInfo,
            techniques: [technique],
            boundingBox: box,
            geometries: decoded.chunks.map((chunk, i) => ({
                type: GeometryType.Polygon,
                groups: [{ start: 0, count: chunk.index.length, technique: 0 }],
                objInfos: [
                    {
                        count: i === 0 ? decoded.count : 0,
                        shapedRoofs: i === 0 ? decoded.shapedRoofs : 0
                    }
                ],
                index: {
                    name: "index",
                    itemCount: 1,
                    type: "uint16",
                    buffer: chunk.index.buffer as ArrayBuffer
                },
                vertexAttributes: (
                    [
                        ["position", 3, "float", false],
                        ["normal", 3, "int16", true],
                        ["uv", 2, "float", false],
                        [
                            "baseUv",
                            2,
                            chunk.baseUv instanceof Int16Array ? "int16" : "float",
                            false
                        ],
                        ["color", 3, "uint8", true],
                        ["seed", 1, "uint16", true],
                        ["tileUv", 2, chunk.tileUv instanceof Int16Array ? "int16" : "float", false]
                    ] as const
                ).map(([name, itemCount, type, normalized]) => ({
                    name,
                    itemCount,
                    type,
                    normalized,
                    buffer: chunk[name].buffer as ArrayBuffer
                }))
            }))
        };
    }
}
WorkerServiceManager.getInstance().register({
    serviceType: BUILDING_DECODER,
    factory: id => TileDecoderService.start(id, new BuildingDecoder())
});
