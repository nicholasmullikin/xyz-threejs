// The decoder stores these numeric identifiers on the position attribute.
const providers = [
    ["Unknown", "#a7a7aa"],
    ["Mapbox", "#427ee4"],
    ["Mapterhorn", "#27bb9c"],
    ["Regional pack", "#cf77db"],
    ["Bundled relief", "#bc9062"],
    ["Sea-level fallback", "#597282"],
    ["USGS lidar", "#ffc554"]
];
function providerOf(mesh) {
    return mesh?.userData?.lidarSurface ? 6 :
        mesh?.geometry?.userData.attributeMetadata?.position?.terrainProvider ?? 0;
}
module.exports = { providers, providerOf };
