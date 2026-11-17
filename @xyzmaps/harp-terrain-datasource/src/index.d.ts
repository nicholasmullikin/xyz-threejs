/*
 * Copyright © 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import {
	TileKey,
	TilingScheme
} from '@xyzmaps/harp-geoutils'
import { DecodedTile } from '@xyzmaps/harp-datasource-protocol'
import { Tile } from '@xyzmaps/harp-mapview'
import { Material } from 'three'
import { TileDataSource } from '@xyzmaps/harp-mapview-decoder'


export type DEMEncodingType = "float32" | "terrarium" | "terrainRgb";

export interface PNGDecoderOptions {
  widthSegments?: number;
  heightSegments?: number;
  demEncoding?: DEMEncodingType;
  fillColor?: string;
  elevationExaggeration?: number;
}

export interface QuantizedMeshDecoderOptions {}

export interface TerrainTile {}

export interface TerrainDataSourceOptions {
	name?: string;
	concurrentDecoderServiceName: string;
	concurrentDecoderScriptUrl: string;
	tilingScheme: TilingScheme;
	fetchTile: (tileKey: TileKey) => Promise<ArrayBuffer>;
	getTileMaterial?: (mapTile: Tile, decodedTile: DecodedTile) => Material;
	decoderOptions?: PNGDecoderOptions | QuantizedMeshDecoderOptions;
	getCustomObjects?: (terrainTile: TerrainTile) => Promise<any> | void;
	minGeometryHeight?: number;
	maxGeometryHeight?: number;
	dataSourceOrder?: number;
	getDisplayZoomLevel?: (level: number) => number;
}

export class TerrainDataSource extends TileDataSource {
	 constructor(options: TerrainDataSourceOptions);
	 connect(): Promise<void>;
	 ready(): boolean;
	 shouldPreloadTiles(): boolean;
}
