/*
 * Copyright © 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import * as UPNG from "upng-js";

import {
    DecoderOptions,
    DecodedTile,
    Geometry,
    GeometryType,
    IndexedTechnique,
    ITileDecoder,
    OptionsMap,
    TileInfo
} from "@xyzmaps/harp-datasource-protocol";
import { RequestController } from "@xyzmaps/harp-datasource-protocol/lib/WorkerDecoderProtocol";
import { TileDecoderService, WorkerServiceManager } from "@xyzmaps/harp-mapview-decoder/index-worker";
import {
    GeoCoordinates,
    Projection,
    TileKey,
    webMercatorTilingScheme
} from "@xyzmaps/harp-geoutils";

import { PNG_DECODER_SERVICE_TYPE } from "./custom_decoder_defs";

export interface DEMEncodings {
    float32: string;
    terrarium: string;
    terrainRgb: string;
}

export const DEM_ENCODINGS: DEMEncodings = {
    float32: "float32",
    terrarium: "terrarium",
    terrainRgb: "terrainRgb" // Mapbox Terrain-RGB
};

const DEFAULT_WIDTH_SEGMENTS = 63;
const DEFAULT_HEIGHT_SEGMENTS = 63;
const DEFAULT_DEM_ENCODING = DEM_ENCODINGS.terrarium;

/** @deprecated Use PNG_DECODER_SERVICE_TYPE from custom_decoder_defs */
export const PNG_TILE_DECODER_ID = "png-tile-decoder";

export interface PNGTileDecoderOptions {
    /** Shared-edge globe meshes use their continuity pass for skirts. */
    continuousGrid?: boolean;
    widthSegments?: number;
    heightSegments?: number;
    demEncoding?: string;
    /** Hex/CSS color for the generated fill technique (MapView ignores `getTileMaterial` on terrain). */
    fillColor?: string;
    /** Multiplier for elevation delta (min/max); use >1 so relief is visible from orbit. Default 1. */
    elevationExaggeration?: number;
}

export interface PNGImage {
    width: number;
    height: number;
    data: Uint8Array;
}

const SKIRT_SAFETY_DROP_METERS = 100;
const SKIRT_EXTEND_PIXELS = 3;

export class PNGTileDecoder implements ITileDecoder {
    private options: Required<PNGTileDecoderOptions> = {
        widthSegments: DEFAULT_WIDTH_SEGMENTS,
        heightSegments: DEFAULT_HEIGHT_SEGMENTS,
        demEncoding: DEFAULT_DEM_ENCODING,
        fillColor: "#6b9b6b",
        continuousGrid: false,
        elevationExaggeration: 1
    };
    private indexArray: Uint16Array | Uint32Array = new Uint16Array(0);
    private perimeterVertices: Array<{ mainIdx: number; x: number; y: number }> = [];

    connect(): Promise<void> {
        return Promise.resolve();
    }

    dispose(): void {
        // no-op
    }

    /**
     * Accepts normal {@link DecoderOptions} broadcasts (styleSet, languages, …) and ignores
     * fields that are not PNG terrain options. Also merges {@link customOptions} from the worker
     * configuration message.
     */
    configure(options?: DecoderOptions & Partial<PNGTileDecoderOptions>, customOptions?: OptionsMap): void {
        const patch: Partial<PNGTileDecoderOptions> = {};
        const apply = (src?: Partial<PNGTileDecoderOptions>) => {
            if (src?.continuousGrid !== undefined) patch.continuousGrid = src.continuousGrid;
            if (src?.widthSegments !== undefined) {
                patch.widthSegments = src.widthSegments;
            }
            if (src?.heightSegments !== undefined) {
                patch.heightSegments = src.heightSegments;
            }
            if (src?.demEncoding !== undefined) {
                patch.demEncoding = src.demEncoding;
            }
            if (src?.fillColor !== undefined) {
                patch.fillColor = src.fillColor;
            }
            if (src?.elevationExaggeration !== undefined) {
                patch.elevationExaggeration = src.elevationExaggeration;
            }
        };
        apply(options);
        apply(customOptions);

        if (Object.keys(patch).length === 0) {
            return;
        }

        this.options = Object.assign(
            {
                widthSegments: DEFAULT_WIDTH_SEGMENTS,
                heightSegments: DEFAULT_HEIGHT_SEGMENTS,
                demEncoding: DEFAULT_DEM_ENCODING,
                fillColor: "#6b9b6b",
                continuousGrid: false,
        elevationExaggeration: 1
            },
            this.options,
            patch
        );

        this.perimeterVertices = this.options.continuousGrid ? [] : this.computePerimeterVertices();
        const mainIndices = this.constructIndexArray(this.options.widthSegments, this.options.heightSegments);
        const skirtIndices = this.constructSkirtIndexArray();
        const totalVertexCount = this.getVerticesCount().total + this.perimeterVertices.length;
        const IndexType = totalVertexCount > 65536 ? Uint32Array : Uint16Array;
        this.indexArray = new IndexType(mainIndices.length + skirtIndices.length);
        this.indexArray.set(mainIndices);
        this.indexArray.set(skirtIndices, mainIndices.length);
    }

    getVerticesCount(): { width: number; height: number; total: number } {
        const width = this.options.widthSegments + 1;
        const height = this.options.heightSegments + 1;
        return {
            width,
            height,
            total: width * height
        };
    }

    validateImg(img: PNGImage): void {
        const { width, height } = this.getVerticesCount();

        if (img.width < width || img.height < height) {
            throw new Error(
                "DEM tile must have at least as many pixels as geometry vertices.\n" +
                    `DEM tile: ${img.width}x${img.height} pixels\n` +
                    `Plane geometry: ${width}x${height} vertices`
            );
        }
    }

    decodeFloat32Pixel(img: PNGImage, pixelIndex: number): number {
        const startByte = pixelIndex * 4;
        const view = new DataView(img.data.buffer, img.data.byteOffset + startByte, 4);
        return view.getFloat32(0, true);
    }

    decodeTerrariumPixel(img: PNGImage, pixelIndex: number): number {
        const startByte = pixelIndex * 4;
        const r = img.data[startByte];
        const g = img.data[startByte + 1];
        const b = img.data[startByte + 2];
        return r * 256 + g + b / 256 - 32768;
    }

    decodeTerrainRgbPixel(img: PNGImage, pixelIndex: number): number {
        const startByte = pixelIndex * 4;
        const r = img.data[startByte];
        const g = img.data[startByte + 1];
        const b = img.data[startByte + 2];
        return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
    }

    readHeightsFromImg(img: PNGImage): { heights: Float32Array; minHeight: number; maxHeight: number } {
        const pixelsCount = img.width * img.height;
        const heights = new Float32Array(pixelsCount);
        let maxHeight = -Infinity;
        let minHeight = Infinity;

        let pixelDecodingFn: (img: PNGImage, i: number) => number;

        switch (this.options.demEncoding) {
            case DEM_ENCODINGS.float32: {
                pixelDecodingFn = (im, i) => this.decodeFloat32Pixel(im, i);
                break;
            }
            case DEM_ENCODINGS.terrarium: {
                pixelDecodingFn = (im, i) => this.decodeTerrariumPixel(im, i);
                break;
            }
            case DEM_ENCODINGS.terrainRgb: {
                pixelDecodingFn = (im, i) => this.decodeTerrainRgbPixel(im, i);
                break;
            }
            default: {
                throw new Error(`"${this.options.demEncoding}" is unsupported DEM encoding`);
            }
        }

        for (let i = 0; i < pixelsCount; i++) {
            const height = pixelDecodingFn(img, i);

            heights[i] = height;

            if (height > maxHeight) {
                maxHeight = height;
            }

            if (height < minHeight) {
                minHeight = height;
            }
        }

        return { heights, minHeight, maxHeight };
    }

    calculateSegmentVertexIndices(
        segmentIndex: number,
        widthSegments: number
    ): { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number } {
        const calculateTopLeft = (i: number, ws: number) => Math.floor(i / ws) + i;

        const topLeft = calculateTopLeft(segmentIndex, widthSegments);
        const topRight = topLeft + 1;
        const bottomLeft = calculateTopLeft(segmentIndex + widthSegments, widthSegments);
        const bottomRight = bottomLeft + 1;

        return { topLeft, topRight, bottomLeft, bottomRight };
    }

    constructIndexArray(widthSegments: number, heightSegments: number): Uint16Array | Uint32Array {
        const segmentsCount = widthSegments * heightSegments;
        const vertexCount = this.getVerticesCount().total;
        const trianglesCount = segmentsCount * 2;
        const indexArray =
            vertexCount > Math.pow(2, 16)
                ? new Uint32Array(trianglesCount * 3)
                : new Uint16Array(trianglesCount * 3);
        const indicesPerSegment = 6;

        for (let i = 0, ii = 0; i < segmentsCount; i++, ii += indicesPerSegment) {
            const segmentVertexIndices = this.calculateSegmentVertexIndices(i, widthSegments);

            // Left triangle
            indexArray[ii] = segmentVertexIndices.topLeft;
            indexArray[ii + 1] = segmentVertexIndices.bottomLeft;
            indexArray[ii + 2] = segmentVertexIndices.topRight;
            // Right triangle
            indexArray[ii + 3] = segmentVertexIndices.bottomLeft;
            indexArray[ii + 4] = segmentVertexIndices.bottomRight;
            indexArray[ii + 5] = segmentVertexIndices.topRight;
        }

        return indexArray;
    }

    /**
     * Returns edge vertex info traversing the tile perimeter clockwise
     * (top→right→bottom→left), forming a closed loop for skirt generation.
     */
    computePerimeterVertices(): Array<{ mainIdx: number; x: number; y: number }> {
        const { width: W, height: H } = this.getVerticesCount();
        const verts: Array<{ mainIdx: number; x: number; y: number }> = [];
        for (let x = 0; x < W; x++)
            verts.push({ mainIdx: x, x, y: 0 });
        for (let y = 1; y < H; y++)
            verts.push({ mainIdx: y * W + (W - 1), x: W - 1, y });
        for (let x = W - 2; x >= 0; x--)
            verts.push({ mainIdx: (H - 1) * W + x, x, y: H - 1 });
        for (let y = H - 2; y >= 1; y--)
            verts.push({ mainIdx: y * W, x: 0, y });
        return verts;
    }

    /**
     * Builds index array for skirt triangles that connect each perimeter
     * edge vertex to its dropped duplicate, forming a vertical curtain.
     */
    constructSkirtIndexArray(): Uint16Array | Uint32Array {
        const mainTotal = this.getVerticesCount().total;
        const perim = this.perimeterVertices;
        const numTris = perim.length * 2;
        const totalVerts = mainTotal + perim.length;
        const arr = totalVerts > 65536
            ? new Uint32Array(numTris * 3)
            : new Uint16Array(numTris * 3);
        let idx = 0;
        for (let i = 0; i < perim.length; i++) {
            const ni = (i + 1) % perim.length;
            const v0 = perim[i].mainIdx;
            const v1 = perim[ni].mainIdx;
            const s0 = mainTotal + i;
            const s1 = mainTotal + ni;
            arr[idx++] = v0;  arr[idx++] = v1;  arr[idx++] = s0;
            arr[idx++] = v1;  arr[idx++] = s1;  arr[idx++] = s0;
        }
        return arr;
    }

    /**
     * Project each grid vertex onto the sphere surface and express in the
     * tile's OBB local frame so that adjacent tiles share edge positions.
     */
    constructWorldPositionArray(
        img: PNGImage,
        heights: Float32Array,
        projection: Projection,
        geoBox: { south: number; north: number; west: number; east: number },
        obbCenter: { x: number; y: number; z: number },
        obbAxes: {
            xAxis: { x: number; y: number; z: number };
            yAxis: { x: number; y: number; z: number };
            zAxis: { x: number; y: number; z: number };
        },
        elevationExaggeration: number
    ): Float32Array {
        const vertexCount = this.getVerticesCount();
        const skirtCount = this.perimeterVertices.length;
        const totalVerts = vertexCount.total + skirtCount;
        const elementsPerVertex = 3;
        const positionArray = new Float32Array(totalVerts * elementsPerVertex);
        const widthScale = (img.width - 1) / (vertexCount.width - 1);
        const heightScale = (img.height - 1) / (vertexCount.height - 1);
        const worldPt = { x: 0, y: 0, z: 0 };

        const latRange = geoBox.north - geoBox.south;
        const lngRange = geoBox.east - geoBox.west;
        const W = vertexCount.width;
        const H = vertexCount.height;
        const EDGE_EXTEND_PIXELS = 1;
        const edgeExtendLat = (latRange / img.height) * EDGE_EXTEND_PIXELS;
        const edgeExtendLng = (lngRange / img.width) * EDGE_EXTEND_PIXELS;

        for (let vertexIndex = 0; vertexIndex < vertexCount.total; vertexIndex++) {
            const vertexX = vertexIndex % vertexCount.width;
            const vertexY = Math.floor(vertexIndex / vertexCount.width);
            const heightX = Math.round(vertexX * widthScale);
            const heightY = Math.round(vertexY * heightScale);
            const heightIndex = heightY * img.width + heightX;

            const xNorm = vertexX / (vertexCount.width - 1);
            const yNorm = 1 - vertexY / (vertexCount.height - 1);

            const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
            const m = mercator(geoBox.south) + yNorm * (mercator(geoBox.north) - mercator(geoBox.south));
            const lat = Math.atan(Math.sinh(m)) * 180 / Math.PI;
            const lng = geoBox.west + xNorm * lngRange;
            const px = Math.max(0, Math.min(img.width - 1, xNorm * img.width - 0.5));
            const py = Math.max(0, Math.min(img.height - 1, (1 - yNorm) * img.height - 0.5));
            const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
            const jx = Math.min(ix + 1, img.width - 1), jy = Math.min(iy + 1, img.height - 1);
            const top = heights[iy * img.width + ix] * (1-fx) + heights[iy * img.width + jx] * fx;
            const bottom = heights[jy * img.width + ix] * (1-fx) + heights[jy * img.width + jx] * fx;
            const alt = (top * (1-fy) + bottom * fy) * elevationExaggeration;
            projection.projectPoint(new GeoCoordinates(lat, lng, alt), worldPt);

            const dx = worldPt.x - obbCenter.x;
            const dy = worldPt.y - obbCenter.y;
            const dz = worldPt.z - obbCenter.z;

            const base = elementsPerVertex * vertexIndex;
            positionArray[base] =
                dx * obbAxes.xAxis.x + dy * obbAxes.xAxis.y + dz * obbAxes.xAxis.z;
            positionArray[base + 1] =
                dx * obbAxes.yAxis.x + dy * obbAxes.yAxis.y + dz * obbAxes.yAxis.z;
            positionArray[base + 2] =
                dx * obbAxes.zAxis.x + dy * obbAxes.zAxis.y + dz * obbAxes.zAxis.z;
        }

        const pixelLat = latRange / img.height;
        const pixelLng = lngRange / img.width;

        for (let i = 0; i < skirtCount; i++) {
            const { x: vx, y: vy } = this.perimeterVertices[i];
            const heightX = Math.round(vx * widthScale);
            const heightY = Math.round(vy * heightScale);
            const heightIndex = heightY * img.width + heightX;

            const xNorm = vx / (W - 1);
            const yNorm = 1 - vy / (H - 1);

            let outLat = 0;
            let outLng = 0;
            if (vy === 0) outLat = 1;
            if (vy === H - 1) outLat = -1;
            if (vx === 0) outLng = -1;
            if (vx === W - 1) outLng = 1;

            const lat = geoBox.south + yNorm * latRange + outLat * pixelLat * SKIRT_EXTEND_PIXELS;
            const lng = geoBox.west + xNorm * lngRange + outLng * pixelLng * SKIRT_EXTEND_PIXELS;
            const alt = (heights[heightIndex] - SKIRT_SAFETY_DROP_METERS) * elevationExaggeration;

            projection.projectPoint(new GeoCoordinates(lat, lng, alt), worldPt);

            const dx = worldPt.x - obbCenter.x;
            const dy = worldPt.y - obbCenter.y;
            const dz = worldPt.z - obbCenter.z;

            const base = elementsPerVertex * (vertexCount.total + i);
            positionArray[base] =
                dx * obbAxes.xAxis.x + dy * obbAxes.xAxis.y + dz * obbAxes.xAxis.z;
            positionArray[base + 1] =
                dx * obbAxes.yAxis.x + dy * obbAxes.yAxis.y + dz * obbAxes.yAxis.z;
            positionArray[base + 2] =
                dx * obbAxes.zAxis.x + dy * obbAxes.zAxis.y + dz * obbAxes.zAxis.z;
        }

        return positionArray;
    }

    /** UVs from the [0,1] tile plane, including skirt vertices.
     *  Inset by half a texel to reduce color seams at tile boundaries. */
    constructUvArrayFromNormalizedPlane(): Float32Array {
        const vertexCount = this.getVerticesCount();
        const skirtCount = this.perimeterVertices.length;
        const totalVerts = vertexCount.total + skirtCount;
        const uvArray = new Float32Array(totalVerts * 2);

        const TEX_SIZE = 512;
        const halfTexel = this.options.continuousGrid ? 0 : 0.5 / TEX_SIZE;
        const uvScale = 1 - 2 * halfTexel;

        for (let vertexIndex = 0; vertexIndex < vertexCount.total; vertexIndex++) {
            const vertexX = vertexIndex % vertexCount.width;
            const vertexY = Math.floor(vertexIndex / vertexCount.width);
            const x = vertexX / (vertexCount.width - 1);
            const y = 1 - vertexY / (vertexCount.height - 1);
            const j = vertexIndex * 2;
            uvArray[j] = halfTexel + x * uvScale;
            uvArray[j + 1] = halfTexel + y * uvScale;
        }
        for (let i = 0; i < skirtCount; i++) {
            const { x: vx, y: vy } = this.perimeterVertices[i];
            const j = (vertexCount.total + i) * 2;
            const x = vx / (vertexCount.width - 1);
            const y = 1 - vy / (vertexCount.height - 1);
            uvArray[j] = halfTexel + x * uvScale;
            uvArray[j + 1] = halfTexel + y * uvScale;
        }
        return uvArray;
    }

    decodeTile(
        data: ArrayBufferLike | {},
        tileKey: TileKey,
        projection: Projection,
        _requestController?: RequestController
    ): Promise<DecodedTile | undefined> {
        const decoded = UPNG.decode(data as ArrayBuffer);
        const rgba = new Uint8Array((UPNG as any).toRGBA8(decoded)[0]);
        const img: PNGImage = {
            width: (decoded as any).width,
            height: (decoded as any).height,
            data: rgba
        };

        this.validateImg(img);

        const geoBox = webMercatorTilingScheme.getGeoBox(tileKey);
        const obb = {
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: { x: 0, y: 0, z: 1 },
            position: { x: 0, y: 0, z: 0 },
            extents: { x: 0, y: 0, z: 0 }
        };
        projection.projectBox(geoBox, obb);

        const { heights, minHeight, maxHeight } = this.readHeightsFromImg(img);
        const positionArray = this.constructWorldPositionArray(
            img,
            heights,
            projection,
            {
                south: geoBox.southWest.latitude,
                north: geoBox.northEast.latitude,
                west: geoBox.southWest.longitude,
                east: geoBox.northEast.longitude
            },
            obb.position,
            obb,
            this.options.elevationExaggeration
        );
        const uvArray = this.constructUvArrayFromNormalizedPlane();
        const indexType = this.indexArray instanceof Uint32Array ? "uint32" : "uint16";
        const indexCount = this.indexArray.length;
        // Must copy — TileDecoderService transfers ArrayBuffers via postMessage, detaching them.
        const indexBufferCopy = this.indexArray.buffer.slice(0) as ArrayBuffer;

        const technique: IndexedTechnique = {
            name: "standard",
            renderOrder: 0,
            color: this.options.fillColor,
            roughness: 1.0,
            metalness: 0.0,
            depthTest: true,
            _index: 0,
            _styleSetIndex: 0
        };

        const geometry: Geometry = {
            type: GeometryType.Polygon,
            groups: [{ start: 0, count: indexCount, technique: 0 }],
            index: {
                name: "index",
                type: indexType,
                buffer: indexBufferCopy,
                itemCount: 1
            },
            vertexAttributes: [
                {
                    name: "position",
                    type: "float",
                    buffer: positionArray.buffer as ArrayBuffer,
                    itemCount: 3,
                    metadata: { minHeight, maxHeight }
                },
                {
                    name: "uv",
                    type: "float",
                    buffer: uvArray.buffer as ArrayBuffer,
                    itemCount: 2
                }
            ]
        };
        const decodedTile: DecodedTile = {
            techniques: [technique],
            geometries: [geometry]
        };

        return Promise.resolve(decodedTile);
    }

    getTileInfo(
        _data: ArrayBufferLike | {},
        _tileKey: TileKey,
        _projection: Projection,
        _requestController?: RequestController
    ): Promise<TileInfo | undefined> {
        return Promise.resolve(undefined);
    }
}

export class PNGTileDecoderService {
    static start() {
        WorkerServiceManager.getInstance().register({
            serviceType: PNG_DECODER_SERVICE_TYPE,
            factory: (serviceId: string) => {
                return TileDecoderService.start(serviceId, new PNGTileDecoder());
            }
        });
    }
}
