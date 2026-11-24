/*
 * Copyright © 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { baselineHeights } from "./baseline-heights";
import * as UPNG from "upng-js";
import { perimeterIndices, skirtIndexBuffer } from "../src/earth/terrain-grid";
import { blendParentHeights } from "../src/earth/terrain-blend";
import { surfaceNormals } from "../src/earth/terrain-normals";
import { makeAdaptiveTerrain } from "../src/earth/terrain-adaptive";
import { cropParentSurface, parentPatchLayout } from "../src/earth/terrain-parent";
import { WorldHeights, WorldHeightPage } from "./world-heights";
import { rasterError } from "../src/earth/terrain-raster-error";

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
import {
    TileDecoderService,
    WorkerServiceManager
} from "@xyzmaps/harp-mapview-decoder/index-worker";
import {
    GeoCoordinates,
    Projection,
    sphereProjection,
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
    adaptiveDetail?: boolean;
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
    /** Bytes per pixel; omitted for the usual expanded RGBA representation. */
    channels?: 3 | 4;
}

const SKIRT_SAFETY_DROP_METERS = 100;
const SKIRT_EXTEND_PIXELS = 3;
const oceanImage: PNGImage = { width: 256, height: 256, data: new Uint8Array(0) };
let oceanHeights: Float32Array | undefined;

function needsMoreTerrainDetail(heights: Float32Array, width: number, height: number): boolean {
    // Probe both diagonals at approximately the spacing of the 63-cell mesh.
    // Require multiple misses so one noisy height cannot refine a whole tile.
    const dx = Math.max(1, Math.round(width / 126));
    const dy = Math.max(1, Math.round(height / 126));
    let misses = 0;
    for (let y = dy; y < height - dy; y += 2 * dy) {
        for (let x = dx; x < width - dx; x += 2 * dx) {
            const i = y * width + x;
            const a = dy * width + dx;
            const b = dy * width - dx;
            const error = Math.max(
                Math.abs(heights[i] - (heights[i - a] + heights[i + a]) / 2),
                Math.abs(heights[i] - (heights[i - b] + heights[i + b]) / 2)
            );
            if (error > 1 && ++misses >= 8) return true;
        }
    }
    return false;
}

export class PNGTileDecoder implements ITileDecoder {
    private options: Required<PNGTileDecoderOptions> = {
        widthSegments: DEFAULT_WIDTH_SEGMENTS,
        heightSegments: DEFAULT_HEIGHT_SEGMENTS,
        demEncoding: DEFAULT_DEM_ENCODING,
        fillColor: "#6b9b6b",
        adaptiveDetail: false,
        continuousGrid: false,
        elevationExaggeration: 1
    };
    // Per-worker topology is invariant for a given decoder configuration.
    private uvArray?: Float32Array;
    private continuousUv?: Uint16Array;
    private skirtEdge: number[] = [];
    private readonly grids = new Map<number, PNGTileDecoder>();
    private indexArray: Uint16Array | Uint32Array = new Uint16Array(0);
    private perimeterVertices: Array<{ mainIdx: number; x: number; y: number }> = [];

    connect(): Promise<void> {
        return Promise.resolve();
    }

    dispose(): void {
        this.worldHeights?.dispose();
    }

    /**
     * Accepts normal {@link DecoderOptions} broadcasts (styleSet, languages, …) and ignores
     * fields that are not PNG terrain options. Also merges {@link customOptions} from the worker
     * configuration message.
     */
    configure(
        options?: DecoderOptions & Partial<PNGTileDecoderOptions>,
        customOptions?: OptionsMap
    ): void {
        const patch: Partial<PNGTileDecoderOptions> = {};
        const apply = (src?: Partial<PNGTileDecoderOptions>) => {
            if (src?.adaptiveDetail !== undefined) patch.adaptiveDetail = src.adaptiveDetail;
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
                adaptiveDetail: false,
                continuousGrid: false,
                elevationExaggeration: 1
            },
            this.options,
            patch
        );

        this.uvArray = undefined;
        this.continuousUv = undefined;
        this.grids.clear();
        this.perimeterVertices = this.options.continuousGrid ? [] : this.computePerimeterVertices();
        const mainIndices = this.constructIndexArray(
            this.options.widthSegments,
            this.options.heightSegments
        );
        if (
            this.options.continuousGrid &&
            this.options.widthSegments === this.options.heightSegments
        ) {
            const { width, height, total } = this.getVerticesCount();
            this.skirtEdge = perimeterIndices(width, height);
            this.indexArray = skirtIndexBuffer(mainIndices, total, this.skirtEdge.length);
            return;
        }
        this.skirtEdge = [];
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
        const startByte = pixelIndex * (img.channels ?? 4);
        const r = img.data[startByte];
        const g = img.data[startByte + 1];
        const b = img.data[startByte + 2];
        return r * 256 + g + b / 256 - 32768;
    }

    decodeTerrainRgbPixel(img: PNGImage, pixelIndex: number): number {
        const startByte = pixelIndex * (img.channels ?? 4);
        const r = img.data[startByte];
        const g = img.data[startByte + 1];
        const b = img.data[startByte + 2];
        return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
    }

    readHeightsFromImg(img: PNGImage, encoding = this.options.demEncoding): {
        heights: Float32Array;
        minHeight: number;
        maxHeight: number;
    } {
        const pixelsCount = img.width * img.height;
        const heights = new Float32Array(pixelsCount);
        let maxHeight = -Infinity;
        let minHeight = Infinity;

        let pixelDecodingFn: (img: PNGImage, i: number) => number;

        switch (encoding) {
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
        for (let x = 0; x < W; x++) verts.push({ mainIdx: x, x, y: 0 });
        for (let y = 1; y < H; y++) verts.push({ mainIdx: y * W + (W - 1), x: W - 1, y });
        for (let x = W - 2; x >= 0; x--) verts.push({ mainIdx: (H - 1) * W + x, x, y: H - 1 });
        for (let y = H - 2; y >= 1; y--) verts.push({ mainIdx: y * W, x: 0, y });
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
        const arr =
            totalVerts > 65536 ? new Uint32Array(numTris * 3) : new Uint16Array(numTris * 3);
        let idx = 0;
        for (let i = 0; i < perim.length; i++) {
            const ni = (i + 1) % perim.length;
            const v0 = perim[i].mainIdx;
            const v1 = perim[ni].mainIdx;
            const s0 = mainTotal + i;
            const s1 = mainTotal + ni;
            arr[idx++] = v0;
            arr[idx++] = v1;
            arr[idx++] = s0;
            arr[idx++] = v1;
            arr[idx++] = s1;
            arr[idx++] = s0;
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
        const totalVerts = vertexCount.total + skirtCount + 2 * this.skirtEdge.length;
        const elementsPerVertex = 3;
        const positionArray = new Float32Array(totalVerts * elementsPerVertex);
        const widthScale = (img.width - 1) / (vertexCount.width - 1);
        const heightScale = (img.height - 1) / (vertexCount.height - 1);
        const worldPt = { x: 0, y: 0, z: 0 };

        const latRange = geoBox.north - geoBox.south;
        const lngRange = geoBox.east - geoBox.west;
        const W = vertexCount.width;
        const H = vertexCount.height;
        const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
        const south = mercator(geoBox.south);
        const span = mercator(geoBox.north) - south;
        // Longitude, its basis vectors and the horizontal sampling footprint
        // are identical in every row. Latitude and its footprint repeat per column.
        const left = new Int32Array(W),
            right = new Int32Array(W),
            weight = new Float64Array(W);
        const longitudes = new Float64Array(W);
        const spherical = projection === sphereProjection;
        const longitudeCos = new Float64Array(W),
            longitudeSin = new Float64Array(W);
        const radians = Math.PI / 180;
        for (let col = 0; col < W; col++) {
            const u = col / (W - 1);
            const px = Math.max(0, Math.min(img.width - 1, u * img.width - 0.5));
            left[col] = Math.floor(px);
            right[col] = Math.min(left[col] + 1, img.width - 1);
            weight[col] = px - left[col];
            longitudes[col] = geoBox.west + u * lngRange;
            if (spherical) {
                longitudeCos[col] = Math.cos(longitudes[col] * radians);
                longitudeSin[col] = Math.sin(longitudes[col] * radians);
            }
        }
        const geo = new GeoCoordinates(0, 0, 0);
        let base = 0;
        for (let row = 0; row < H; row++) {
            const v = 1 - row / (H - 1);
            geo.latitude = (Math.atan(Math.sinh(south + v * span)) * 180) / Math.PI;
            const cosLatitude = Math.cos(geo.latitude * radians);
            const sinLatitude = Math.sin(geo.latitude * radians);
            const py = Math.max(0, Math.min(img.height - 1, (1 - v) * img.height - 0.5));
            const iy = Math.floor(py),
                fy = py - iy;
            const northRow = iy * img.width,
                southRow = Math.min(iy + 1, img.height - 1) * img.width;
            for (let col = 0; col < W; col++) {
                const ix = left[col],
                    jx = right[col],
                    fx = weight[col];
                const top = heights[northRow + ix] * (1 - fx) + heights[northRow + jx] * fx;
                const bottom = heights[southRow + ix] * (1 - fx) + heights[southRow + jx] * fx;
                const altitude = (top * (1 - fy) + bottom * fy) * elevationExaggeration;
                if (spherical) {
                    const radius = projection.unitScale + altitude;
                    const parallelRadius = radius * cosLatitude;
                    worldPt.x = parallelRadius * longitudeCos[col];
                    worldPt.y = parallelRadius * longitudeSin[col];
                    worldPt.z = radius * sinLatitude;
                } else {
                    geo.longitude = longitudes[col];
                    geo.altitude = altitude;
                    projection.projectPoint(geo, worldPt);
                }
                const dx = worldPt.x - obbCenter.x,
                    dy = worldPt.y - obbCenter.y,
                    dz = worldPt.z - obbCenter.z;
                positionArray[base++] =
                    dx * obbAxes.xAxis.x + dy * obbAxes.xAxis.y + dz * obbAxes.xAxis.z;
                positionArray[base++] =
                    dx * obbAxes.yAxis.x + dy * obbAxes.yAxis.y + dz * obbAxes.yAxis.z;
                positionArray[base++] =
                    dx * obbAxes.zAxis.x + dy * obbAxes.zAxis.y + dz * obbAxes.zAxis.z;
            }
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
        const totalVerts = vertexCount.total + skirtCount + 2 * this.skirtEdge.length;
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
        // Skirt UVs exactly match the adjacent surface vertex in both rows.
        this.skirtEdge.forEach((index, j) => {
            const i = 2 * (vertexCount.total + 2 * j);
            uvArray[i] = uvArray[i + 2] = uvArray[2 * index];
            uvArray[i + 1] = uvArray[i + 3] = uvArray[2 * index + 1];
        });
        return uvArray;
    }

    private worldHeights?: WorldHeights;

    async decodeTile(
        data: ArrayBufferLike | {},
        tileKey: TileKey,
        projection: Projection,
        _requestController?: RequestController
    ): Promise<DecodedTile | undefined> {
        const geoBox = webMercatorTilingScheme.getGeoBox(tileKey);
        const obb = {
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: { x: 0, y: 0, z: 1 },
            position: { x: 0, y: 0, z: 0 },
            extents: { x: 0, y: 0, z: 0 }
        };
        projection.projectBox(geoBox, obb);

        if ("kind" in data && data.kind === "parent-terrain-surface") {
            const layout = parentPatchLayout(data, tileKey);
            const { positions, minHeight, maxHeight } = cropParentSurface(
                data, tileKey, obb, layout.width, projection.unitScale, layout.skirtVertices
            );
            return this.finishTile(positions, minHeight, maxHeight, undefined, layout,
                (data as { sourceLevel?: number }).sourceLevel,
                (data as { terrainProvider?: number }).terrainProvider);
        }
        let img: PNGImage, heights: Float32Array, minHeight: number, maxHeight: number;
        const kind = "kind" in data ? data.kind : undefined;
        const provider = kind === "terrarium-webp" ? 2 :
            kind === "terrain-detail" || kind === "terrain-pack-raster" ? 3 :
            kind === "bundled-relief" ? 4 : kind === "sea-level-fallback" ? 5 : 1;
        let sourceLevel: number | undefined;
        if ("kind" in data && data.kind === "bundled-relief") {
            const sample = await baselineHeights(data as unknown as Parameters<typeof baselineHeights>[0]);
            ({ heights, minHeight, maxHeight } = sample);
            img = { width: sample.width, height: sample.width, data: oceanImage.data };
            // Children still benefit from resampling the regional source image.
            sourceLevel = -2;
        } else if (
            "kind" in data &&
            (data.kind === "empty-ocean-dem" || data.kind === "sea-level-fallback")
        ) {
            img = oceanImage;
            if (data.kind === "sea-level-fallback") sourceLevel = -1;
            heights = oceanHeights ?? (oceanHeights = new Float32Array(img.width * img.height));
            minHeight = maxHeight = 0;
        } else if ("kind" in data && data.kind === "terrarium-webp") {
            sourceLevel = (data as { sourceLevel?: number }).sourceLevel;
            const sample = await (this.worldHeights ??= new WorldHeights()).read(data as WorldHeightPage);
            ({ heights, minHeight, maxHeight } = sample);
            img = { width: sample.width, height: sample.width, data: oceanImage.data };
        } else {
            const detail =
                "kind" in data && data.kind === "terrain-detail"
                    ? (data as {
                          kind: string;
                          raster: ArrayBuffer;
                          parent: object;
                          edgeDistancePixels: number;
                      })
                    : undefined;
            try {
                const decoded = UPNG.decode("raster" in data ? (data.raster as ArrayBuffer) : (data as ArrayBuffer));
                // UPNG already unfilters 8-bit RGB/RGBA pixels into packed rows.
                // Terrain encodings use only RGB, so expanding them to RGBA first
                // would copy every pixel without changing the resulting heights.
                const packed =
                    this.options.demEncoding !== DEM_ENCODINGS.float32 &&
                    decoded.depth === 8 &&
                    (decoded.ctype === 2 || decoded.ctype === 6) &&
                    !decoded.tabs.acTL;
                img = {
                    width: decoded.width,
                    height: decoded.height,
                    data: packed
                        ? (decoded.data as unknown as Uint8Array)
                        : new Uint8Array(UPNG.toRGBA8(decoded)[0]),
                    channels: packed && decoded.ctype === 2 ? 3 : 4
                };
                this.validateImg(img);
            } catch (error) {
                throw rasterError(error);
            }
            ({ heights, minHeight, maxHeight } = this.readHeightsFromImg(img));
            if (detail && img.channels === 4) {
                ({ minHeight, maxHeight } = blendParentHeights(
                    heights,
                    img,
                    tileKey,
                    detail.parent,
                    projection.unitScale,
                    detail.edgeDistancePixels
                ));
            }
        }

        if (
            this.options.adaptiveDetail &&
            this.options.continuousGrid &&
            this.options.widthSegments === 64 &&
            this.options.heightSegments === 64 &&
            tileKey.level >= 5 &&
            minHeight !== maxHeight &&
            projection === sphereProjection
        ) {
            const rugged =
                tileKey.level >= 8 &&
                maxHeight - minHeight > 1 &&
                needsMoreTerrainDetail(heights, img.width, img.height);
            const segments = rugged && tileKey.level >= 14 ? 256 : rugged || tileKey.level >= 13 ? 128 : 64;
            const packed = makeAdaptiveTerrain(
                heights,
                img.width,
                img.height,
                tileKey,
                segments,
                obb,
                projection.unitScale,
                this.options.elevationExaggeration
            );
            return this.finishTile(packed.positions, minHeight, maxHeight, packed, undefined, sourceLevel, provider);
        }
        let grid: PNGTileDecoder = this;
        if (
            this.options.adaptiveDetail &&
            this.options.continuousGrid &&
            this.options.widthSegments === this.options.heightSegments &&
            (this.options.widthSegments === 63 || this.options.widthSegments === 64)
        ) {
            const binaryGrid = this.options.widthSegments === 64;
            let segments = this.options.widthSegments;
            if (tileKey.level >= 10 && minHeight === maxHeight) {
                // At z10 the equatorial tile diagonal is <=56 km. Dividing
                // that into 21 cells keeps spherical chord error below 15 cm.
                // At z12 seven cells suffice. Both grids nest exactly in 63.
                segments = tileKey.level >= 12 ? (binaryGrid ? 8 : 7) : binaryGrid ? 32 : 21;
            } else if (
                tileKey.level >= 14 &&
                img.width >= 127 &&
                img.height >= 127 &&
                maxHeight - minHeight > 1 &&
                needsMoreTerrainDetail(heights, img.width, img.height)
            ) {
                segments = 126;
            }
            if (segments !== this.options.widthSegments) {
                let shared = this.grids.get(segments);
                if (!shared) {
                    shared = new PNGTileDecoder();
                    shared.configure({
                        ...this.options,
                        adaptiveDetail: false,
                        widthSegments: segments,
                        heightSegments: segments
                    });
                    this.grids.set(segments, shared);
                }
                grid = shared;
            }
        }
        const positionArray = grid.constructWorldPositionArray(
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
        return grid.finishTile(positionArray, minHeight, maxHeight, undefined, undefined, sourceLevel, provider);
    }

    private finishTile(
        positionArray: Float32Array,
        minHeight: number,
        maxHeight: number,
        adaptive?: ReturnType<typeof makeAdaptiveTerrain>,
        regular?: ReturnType<typeof parentPatchLayout>,
        sourceLevel?: number,
        terrainProvider = 0
    ): Promise<DecodedTile> {
        const uv = regular?.uv ?? adaptive?.uv ?? (this.uvArray ??= this.constructUvArrayFromNormalizedPlane());
        let uvArray: Float32Array | Uint16Array = uv;
        if (this.options.continuousGrid && !regular) {
            if (!adaptive && this.continuousUv) uvArray = this.continuousUv;
            else {
                const packed = new Uint16Array(uv.length);
                for (let i = 0; i < packed.length; i++) packed[i] = Math.round(uv[i] * 65535);
                uvArray = packed;
                if (!adaptive) this.continuousUv = packed;
            }
        }
        const index = regular?.index ?? adaptive?.index ?? this.indexArray;
        const indexType = index instanceof Uint32Array ? "uint32" : "uint16";
        const indexCount = index.length;
        const surfaceCount = regular ? regular.width ** 2 : adaptive?.surfaceCount ?? this.getVerticesCount().total;
        const edgeCount = regular ? regular.skirtVertices / 2 : adaptive ? 4 * (adaptive.edgeWidth - 1) : this.skirtEdge.length;
        const normals = adaptive?.normals ?? (edgeCount
            ? surfaceNormals(
                  positionArray,
                  index,
                  surfaceCount,
                  indexCount - 12 * edgeCount,
                  this.options.continuousGrid ? new Int16Array(positionArray.length) : undefined
              )
            : undefined);
        // Must copy — TileDecoderService transfers ArrayBuffers via postMessage, detaching them.
        const indexBufferCopy = (adaptive ? index.buffer : index.buffer.slice(0)) as ArrayBuffer;

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
                    metadata: {
                        terrainProvider,
                        ...(sourceLevel !== undefined ? {terrainSourceLevel: sourceLevel} : {}),
                        minHeight,
                        maxHeight,
                        ...(edgeCount
                            ? {
                                  terrainSurfaceNormals: 1,
                                  terrainGridWidth: regular?.width ?? adaptive?.width ?? this.getVerticesCount().width,
                                  ...(regular?.diagonal ? { terrainDiagonal: regular.diagonal } : {})
                              }
                            : {}),
                        ...(adaptive
                            ? {
                                  terrainSurfaceCount: adaptive.surfaceCount,
                                  terrainEdgeWidth: adaptive.edgeWidth
                              }
                            : {})
                    }
                },
                {
                    name: "uv",
                    type: uvArray instanceof Uint16Array ? "uint16" : "float",
                    normalized: uvArray instanceof Uint16Array,
                    buffer: (adaptive ? uvArray.buffer : uvArray.buffer.slice(0)) as ArrayBuffer,
                    itemCount: 2
                }
            ]
        };
        if (normals)
            geometry.vertexAttributes!.push({
                name: "normal",
                type: normals instanceof Int16Array ? "int16" : "float",
                normalized: normals instanceof Int16Array,
                itemCount: 3,
                buffer: normals.buffer as ArrayBuffer
            });
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
