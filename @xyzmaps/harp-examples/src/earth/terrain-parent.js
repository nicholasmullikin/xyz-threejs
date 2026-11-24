const { samplePosition } = require("./terrain-sample");
const { perimeterIndices, skirtIndexBuffer } = require("./terrain-grid");

const templates = new Map();
function parentPatchLayout(parent, child) {
    const scale = 2 ** (child.level - parent.level),
        cells = (parent.width - 1) / scale;
    let diagonal = parent.topology ? 1 : parent.diagonal || 0;
    // At its finest grid MARTINI alternates diagonals in a checkerboard. Every
    // coarser triangle is a union of these triangles. A dyadic crop preserves
    // the same planes by retaining the parent grid's spacing and origin parity.
    const x = Math.floor((child.column - scale * parent.column) * cells);
    const y = Math.floor((child.row - scale * parent.row) * cells);
    if ((x + y) % 2) diagonal = -diagonal;
    const width = Math.max(1, Math.ceil(cells)) + 1;
    const id = width * 3 + diagonal;
    if (templates.has(id)) return templates.get(id);
    const count = width * width,
        n = width - 1,
        edge = perimeterIndices(width);
    const total = count + 2 * edge.length,
        uv = new Uint16Array(2 * total);
    const Index = total > 65536 ? Uint32Array : Uint16Array;
    const triangles = new Index(6 * n * n);
    let k = 0;
    for (let row = 0; row < width; row++)
        for (let col = 0; col < width; col++) {
            const a = row * width + col;
            uv[2 * a] = Math.round((65535 * col) / n);
            uv[2 * a + 1] = Math.round(65535 * (1 - row / n));
            if (row === n || col === n) continue;
            const b = a + width,
                c = b + 1,
                d = a + 1;
            if (diagonal && ((col + row) % 2 === 0) === diagonal > 0) {
                triangles[k++] = a;
                triangles[k++] = b;
                triangles[k++] = c;
                triangles[k++] = a;
                triangles[k++] = c;
                triangles[k++] = d;
            } else {
                triangles[k++] = a;
                triangles[k++] = b;
                triangles[k++] = d;
                triangles[k++] = b;
                triangles[k++] = c;
                triangles[k++] = d;
            }
        }
    edge.forEach((source, j) => {
        const out = 2 * (count + 2 * j);
        uv[out] = uv[out + 2] = uv[2 * source];
        uv[out + 1] = uv[out + 3] = uv[2 * source + 1];
    });
    const layout = {
        width,
        diagonal,
        uv,
        index: skirtIndexBuffer(triangles, count, edge.length),
        skirtVertices: 2 * edge.length
    };
    templates.set(id, layout);
    return layout;
}

// Crop a resident ancestor's actual triangulated surface into a missing child's
// tangent frame. Shared vertices stay on the same triangles at any zoom gap.
function cropParentSurface(parent, child, frame, width, radius, skirtVertices = 0) {
    const scale = 2 ** (child.level - parent.level);
    const offsetX = child.column - parent.column * scale,
        offsetY = child.row - parent.row * scale;
    const sampled = { x: 0, y: 0, z: 0 },
        m = parent.matrix;
    const positions = new Float32Array((width * width + skirtVertices) * 3);
    // Preserve the ancestor's interpolated vertex normals, including their lengths.
    // A dyadic subdivision of the same plane must preserve its lighting as well.
    const direction = parent.normals ? new Float64Array(3) : undefined;
    const normals = direction ? new Int16Array(positions.length) : undefined;
    const rotation = [];
    if (direction) {
        for (const axis of [frame.xAxis, frame.yAxis, frame.zAxis])
            for (let col = 0; col < 3; col++) {
                const offset = 4 * col;
                rotation.push(
                    32767 * (axis.x * m[offset] + axis.y * m[offset + 1] + axis.z * m[offset + 2])
                );
            }
    }
    let i = 0,
        minRadiusSquared = Infinity,
        maxRadiusSquared = 0;
    for (let row = 0; row < width; row++) {
        const v = (offsetY + row / (width - 1)) / scale;
        for (let col = 0; col < width; col++) {
            const u = (offsetX + col / (width - 1)) / scale;
            const { x: px, y: py, z: pz } = samplePosition(parent, u, v, sampled, direction);
            if (normals) {
                for (let axis = 0; axis < 3; axis++) {
                    const k = 3 * axis;
                    const value = rotation[k] * direction[0] +
                        rotation[k + 1] * direction[1] + rotation[k + 2] * direction[2];
                    // An active, quantized parent transition can slightly exceed unit length.
                    normals[i + axis] = Math.max(-32767, Math.min(32767, Math.round(value)));
                }
            }
            const wx = m[0] * px + m[4] * py + m[8] * pz + m[12];
            const wy = m[1] * px + m[5] * py + m[9] * pz + m[13];
            const wz = m[2] * px + m[6] * py + m[10] * pz + m[14];
            const radiusSquared = wx * wx + wy * wy + wz * wz;
            minRadiusSquared = Math.min(minRadiusSquared, radiusSquared);
            maxRadiusSquared = Math.max(maxRadiusSquared, radiusSquared);
            const dx = wx - frame.position.x,
                dy = wy - frame.position.y,
                dz = wz - frame.position.z;
            positions[i++] = dx * frame.xAxis.x + dy * frame.xAxis.y + dz * frame.xAxis.z;
            positions[i++] = dx * frame.yAxis.x + dy * frame.yAxis.y + dz * frame.yAxis.z;
            positions[i++] = dx * frame.zAxis.x + dy * frame.zAxis.y + dz * frame.zAxis.z;
        }
    }
    return {
        positions,
        normals,
        minHeight: Math.sqrt(minRadiusSquared) - radius,
        maxHeight: Math.sqrt(maxRadiusSquared) - radius
    };
}
module.exports = { cropParentSurface, parentPatchLayout };
