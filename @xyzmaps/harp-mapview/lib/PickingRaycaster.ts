/*
 * Copyright (C) 2023-     XYZ maps contributors
 * Copyright (C) 2018-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from "three";
import type { Intersection as RaycasterIntersection } from "three/src/core/Raycaster";

import { MapObjectAdapter } from "./MapObjectAdapter";

function intersectObject(
    object: THREE.Object3D,
    raycaster: PickingRaycaster,
    intersects: RaycasterIntersection[],
    recursive?: boolean
) {
    if (object.layers.test(raycaster.layers) && object.visible) {
        const mapObjectAdapter = MapObjectAdapter.get(object);
        if (!mapObjectAdapter || mapObjectAdapter.isPickable()) {
            object.raycast(raycaster, intersects);
        }
    }

    if (recursive === true) {
        for (const child of object.children) {
            intersectObject(child, raycaster, intersects, true);
        }
    }
}

/**
 * Raycasting points is not supported as necessary in Three.js. This class extends a
 * [[THREE.Raycaster]] and adds the width / height of the canvas to allow picking of screen space
 * geometry.
 *
 * @internal
 */
export class PickingRaycaster extends THREE.Raycaster {
    /**
     * Constructor.
     *
     * @param canvasSize - the canvas width and height.
     */
    constructor(readonly canvasSize: THREE.Vector2) {
        super();
    }

    // HARP-9585: Override of base class method, however tslint doesn't recognize overrides of
    // three.js classes.
    override intersectObject<TIntersected extends THREE.Object3D>(
        object: THREE.Object3D,
        recursive?: boolean,
        optionalTarget?: Array<RaycasterIntersection<TIntersected>>
    ): Array<RaycasterIntersection<TIntersected>> {
        const intersects: Array<RaycasterIntersection<TIntersected>> = optionalTarget ?? [];
        // The local helper expects THREE.Intersection[], so cast as needed
        intersectObject(object, this, intersects as unknown as RaycasterIntersection[], recursive);
        return intersects;
    }

    // HARP-9585: Override of base class method, however tslint doesn't recognize overrides of
    // three.js classes.
    override intersectObjects<TIntersected extends THREE.Object3D>(
        objects: THREE.Object3D[],
        recursive?: boolean,
        optionalTarget?: Array<RaycasterIntersection<TIntersected>>
    ): Array<RaycasterIntersection<TIntersected>> {
        const intersects: Array<RaycasterIntersection<TIntersected>> = optionalTarget ?? [];
        for (const object of objects) {
            intersectObject(object, this, intersects as unknown as RaycasterIntersection[], recursive);
        }
        return intersects;
    }
}
