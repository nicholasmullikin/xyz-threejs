// Surveyed models use geodetic WGS84. At the target, linearize the
// ellipsoid-to-harp-sphere transform in east, north and up. Moving the
// tangent frame with the target keeps the alignment local across a country.
const radius = 6378137;
const eccentricitySquared = 6.6943799901413165e-3;
const sources = [
    {
        id: "helsinki",
        continuous: true,
        title: "City of Helsinki 2024",
        credit: "https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d",
        bounds: [24.81, 60.114, 25.274, 60.308],
        // The 2024 release has separate invisible floor and textured-city trees.
        url: "https://kartta.hel.fi/3d/mesh/Helsinki_2024/2/tileset.json",
        orthometric: true,
        photo: true
    },
    {
        id: "3dbag",
        title: "© 3DBAG by tudelft3d and 3DGI",
        credit: "https://docs.3dbag.nl/en/copyright/",
        bounds: [3.35, 50.73, 7.23, 53.56],
        url: "https://data.3dbag.nl/v20250903/cesium3dtiles/lod22/tileset.json",
        photo: false
    },
    {
        id: "luxembourg",
        continuous: true,
        legacy: true,
        title: "ACT Luxembourg · national photomesh 2020",
        credit: "https://data.public.lu/en/datasets/maquette-3d-du-grand-duche-de-luxembourg/",
        bounds: [5.7, 49.43, 6.55, 50.2],
        url: "/earth-data/luxembourg-2020/tileset.json",
        photo: true
    },
    {
        id: "swiss",
        orthometric: true,
        title: "© swisstopo · swissBUILDINGS3D",
        credit: "https://www.swisstopo.admin.ch/en/landscape-model-swissbuildings3d-20",
        bounds: [5.94, 45.8, 10.51, 47.82],
        url: "https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json",
        photo: false
    },
    {
        id: "plateau",
        title: "Project PLATEAU / MLIT Japan",
        credit: "https://www.mlit.go.jp/plateau/",
        bounds: [127.6, 26.16, 142.1, 43.2],
        url: "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-lod2-texture-latest/tileset.json",
        photo: true
    }
];
function sourceAt(lat, lon) {
    const source = sources.find(
        ({ bounds: [w, s, e, n] }) => lon >= w && lon <= e && lat >= s && lat <= n
    );
    if (!source) return;
    const areas = require("./survey-coverage.json")[source.id];
    if (!areas) return source;
    const x = lon * 1000,
        y = lat * 1000;
    if (source.id === "plateau")
        return areas.some(([w, s, e, n]) => x >= w && y >= s && x <= e && y <= n)
            ? source
            : undefined;
    for (const ring of areas) {
        let inside = false;
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
            const xi = ring[i],
                yi = ring[i + 1],
                xj = ring[j],
                yj = ring[j + 1];
            if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) return source;
    }
}
function surveyTransform(THREE, latitude, longitude, geoidHeight) {
    const rad = Math.PI / 180,
        lat = latitude * rad,
        lon = longitude * rad;
    const s = Math.sin(lat),
        c = Math.cos(lat),
        sl = Math.sin(lon),
        cl = Math.cos(lon);
    const n = radius / Math.sqrt(1 - eccentricitySquared * s * s);
    const m = (n * (1 - eccentricitySquared)) / (1 - eccentricitySquared * s * s);
    const basis = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(-sl, cl, 0),
        new THREE.Vector3(-s * cl, -s * sl, c),
        new THREE.Vector3(c * cl, c * sl, s)
    );
    const linear = basis
        .clone()
        .multiply(
            new THREE.Matrix4().makeScale(radius / (n + geoidHeight), radius / (m + geoidHeight), 1)
        )
        .multiply(basis.clone().transpose());
    const center = new THREE.Vector3(
        (n + geoidHeight) * c * cl,
        (n + geoidHeight) * c * sl,
        (n * (1 - eccentricitySquared) + geoidHeight) * s
    );
    const shift = new THREE.Vector3(c * cl, c * sl, s)
        .multiplyScalar(radius)
        .sub(center.applyMatrix4(linear));
    return linear.setPosition(shift);
}
module.exports = { sources, sourceAt, surveyTransform };
