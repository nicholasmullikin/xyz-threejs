/*
 * Copyright © 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { TileDataSource } from '@xyzmaps/harp-mapview-decoder'

import { TerrainTileFactory } from './terrain-tile'
import { TerrainDataProvider } from './terrain-data-provider'

export class TerrainDataSource extends TileDataSource {
  constructor (options) {
    if (options.tilingScheme === undefined) {
      throw new Error('No "tilingScheme" option provided.')
    }

    if (options.concurrentDecoderServiceName === undefined) {
      throw new Error(
        'No "concurrentDecoderServiceName" option provided. ' +
        'It should be an ID of one of the supported decoders.'
      )
    }

    if (options.concurrentDecoderScriptUrl === undefined) {
      throw new Error(
        'No "concurrentDecoderScriptUrl" option provided. ' +
        'It should be URL of a decoder worker used to decode tiles.'
      )
    }

    const tileFactory = new TerrainTileFactory(
      options
    )

    super(tileFactory, {
      name: options.name || 'terrain',
      tilingScheme: options.tilingScheme,
      dataProvider: new TerrainDataProvider(options.fetchTile),
      useWorker: true,
      concurrentDecoderServiceName: options.concurrentDecoderServiceName,
      concurrentDecoderScriptUrl: options.concurrentDecoderScriptUrl,
      minGeometryHeight: options.minGeometryHeight,
      maxGeometryHeight: options.maxGeometryHeight,
      dataSourceOrder: options.dataSourceOrder
    })

    this.options = options
  }

  connect () {
    return this.decoder.connect().then(() => {
      if (this.options.decoderOptions !== undefined) {
        this.decoder.configure(this.options.decoderOptions)
      }
    })
  }

  ready () {
    return true
  }

  shouldPreloadTiles () {
    return true
  }

  getDisplayZoomLevel (level) {
    if (this.options.getDisplayZoomLevel !== undefined) {
      return this.options.getDisplayZoomLevel(level)
    }

    return level
  }
}
