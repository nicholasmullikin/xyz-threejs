// Terrain normals are area-weighted face normals in the tile's tangent space.
// Skirts use copies of the surface normals and do not contribute to its lighting.
function accumulate(positions, index, offset, normal, mask) {
    const a = 3 * index[offset],
        b = 3 * index[offset + 1],
        c = 3 * index[offset + 2];
    const x = positions[c] - positions[b],
        y = positions[c + 1] - positions[b + 1],
        z = positions[c + 2] - positions[b + 2];
    const u = positions[a] - positions[b],
        v = positions[a + 1] - positions[b + 1],
        w = positions[a + 2] - positions[b + 2];
    const nx = y * w - z * v,
        ny = z * u - x * w,
        nz = x * v - y * u;
    if (mask & 1) {
        normal[a] += nx;
        normal[a + 1] += ny;
        normal[a + 2] += nz;
    }
    if (mask & 2) {
        normal[b] += nx;
        normal[b + 1] += ny;
        normal[b + 2] += nz;
    }
    if (mask & 4) {
        normal[c] += nx;
        normal[c + 1] += ny;
        normal[c + 2] += nz;
    }
}

// Each worker and the main thread reuse one bounded accumulator for packed
// normals. A seam refresh clears and writes only the vertices in its plan.
let scratch = new Float32Array(0);
function accumulator(length) {
    if (scratch.length < length) scratch = new Float32Array(length);
    return scratch;
}

function normalize(normal, i, output = normal, scale = 1) {
    const x = normal[i],
        y = normal[i + 1],
        z = normal[i + 2];
    const inverse = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    if (scale === 1) {
        output[i] = x * inverse;
        output[i + 1] = y * inverse;
        output[i + 2] = z * inverse;
    } else {
        output[i] = Math.round(x * inverse * scale);
        output[i + 1] = Math.round(y * inverse * scale);
        output[i + 2] = Math.round(z * inverse * scale);
    }
}

function surfaceNormals(positions, index, surfaceCount, end, existing) {
    const output = existing ?? new Float32Array(positions.length);
    const packed = output instanceof Int16Array;
    const sums = packed ? accumulator(3 * surfaceCount) : output;
    if (existing) sums.fill(0, 0, 3 * surfaceCount);
    for (let i = 0; i < end; i += 3) accumulate(positions, index, i, sums, 7);
    for (let i = 0; i < 3 * surfaceCount; i += 3) normalize(sums, i, output, packed ? 32767 : 1);
    return output;
}

// When a seam moves, only the corners of triangles touching that seam change
// normal. Include every incident triangle at those corners to preserve the exact
// area weighting, including triangles one ring farther into the tile.
function boundaryFaces(index, surfaceCount, end, perimeter) {
    const edge = new Uint8Array(surfaceCount);
    for (const i of perimeter) edge[i] = 1;
    const affected = new Uint8Array(surfaceCount);
    for (let i = 0; i < end; i += 3) {
        const a = index[i],
            b = index[i + 1],
            c = index[i + 2];
        if (edge[a] || edge[b] || edge[c]) affected[a] = affected[b] = affected[c] = 1;
    }
    const vertices = [],
        faces = [];
    for (let i = 0; i < affected.length; i++) if (affected[i]) vertices.push(i);
    for (let i = 0; i < end; i += 3) {
        const mask =
            affected[index[i]] | (affected[index[i + 1]] << 1) | (affected[index[i + 2]] << 2);
        if (mask) faces.push((i / 3) * 8 + mask);
    }
    return {
        vertices: surfaceCount <= 65536 ? Uint16Array.from(vertices) : Uint32Array.from(vertices),
        faces: Uint32Array.from(faces)
    };
}

function refreshBoundaryNormals(positions, index, normals, plan) {
    const packed = normals instanceof Int16Array;
    const sums = packed ? accumulator(3 * (1 + plan.vertices[plan.vertices.length - 1])) : normals;
    for (const vertex of plan.vertices) {
        const i = 3 * vertex;
        sums[i] = sums[i + 1] = sums[i + 2] = 0;
    }
    for (const face of plan.faces)
        accumulate(positions, index, 3 * (face >>> 3), sums, face & 7);
    for (const vertex of plan.vertices) normalize(sums, 3 * vertex, normals, packed ? 32767 : 1);
}
module.exports = { surfaceNormals, boundaryFaces, refreshBoundaryNormals };
