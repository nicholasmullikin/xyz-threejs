function perimeterIndices(width, height = width) {
    const edge = [];
    for (let x = 0; x < width - 1; x++) edge.push(x);
    for (let y = 0; y < height - 1; y++) edge.push(y * width + width - 1);
    for (let x = width - 1; x > 0; x--) edge.push((height - 1) * width + x);
    for (let y = height - 1; y > 0; y--) edge.push(y * width);
    return edge;
}
function skirtIndexBuffer(main, surfaceVertices, edgeLength) {
    const IndexArray = surfaceVertices + 2 * edgeLength > 65536 ? Uint32Array : Uint16Array;
    const indices = new IndexArray(main.length + 12 * edgeLength);
    indices.set(main);
    for (let i = 0; i < edgeLength; i++) {
        const a = surfaceVertices + 2 * i,
            b = surfaceVertices + 2 * ((i + 1) % edgeLength),
            c = a + 1,
            d = b + 1;
        indices.set([a, b, c, b, d, c, c, b, a, c, d, b], main.length + 12 * i);
    }
    return indices;
}
function gridWidth(geometry) {
    return (
        geometry.userData?.attributeMetadata?.position?.terrainGridWidth ??
        Math.sqrt(geometry.attributes.position.count)
    );
}
// Older decoded grids have just the surface. Grow their arrays before the
// first draw so the seam pass can update the same packed layout.
function prepareTerrainGrid(THREE, geometry, width, edge) {
    if (geometry.userData?.attributeMetadata?.position?.terrainGridWidth) return;
    const count = width * width;
    for (const [name, source] of Object.entries(geometry.attributes)) {
        const stride = source.itemSize;
        const array = new source.array.constructor((count + 2 * edge.length) * stride);
        array.set(source.array);
        if (name === "uv")
            edge.forEach((index, j) => {
                for (let k = 0; k < 2; k++)
                    for (let c = 0; c < stride; c++)
                        array[(count + 2 * j + k) * stride + c] = array[index * stride + c];
            });
        geometry.setAttribute(
            name,
            new THREE.BufferAttribute(array, stride, source.normalized).setUsage(source.usage)
        );
    }
    const index = skirtIndexBuffer(geometry.index.array, count, edge.length);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    if (geometry.groups.length === 1 && geometry.groups[0].start === 0)
        geometry.groups[0].count = index.length;
    geometry.userData ??= {};
    const metadata = (geometry.userData.attributeMetadata ??= {});
    metadata.position = { ...metadata.position, terrainGridWidth: width };
}
module.exports = { perimeterIndices, skirtIndexBuffer, gridWidth, prepareTerrainGrid };
