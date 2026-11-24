// Two quads per fixture draw a soft ground pool and the visible luminaire.
// Depth testing lets intervening buildings, terrain and trees hide the light.
const vertex = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 base;attribute vec3 slopeSeed;
uniform vec3 east,north,up;
uniform float viewportHeight,fade;
varying vec2 disc;varying float source,weight,seed;
void main(){
    source=position.z;disc=position.xy;seed=slopeSeed.z;
    vec3 anchor=(modelMatrix*vec4(0.,0.,0.,1.)).xyz;
    vec3 p=anchor+base;
    float distance=length(p);
    weight=fade*(1.-smoothstep(1000.,1750.,distance));
    vec4 mv;
    if(source<.5){
        vec2 d=disc*(6.+2.*seed);
        p+=d.x*east+d.y*north+up*(dot(d,slopeSeed.xy)+.25);
        mv=viewMatrix*vec4(p,1.);
    }else{
        mv=viewMatrix*vec4(p+up*(5.6+1.8*seed),1.);
        // Below one pixel conserve apparent energy as the glow shrinks.
        float metresPerPixel=2.*max(1.,-mv.z)/(projectionMatrix[1][1]*viewportHeight);
        float radius=max(.85,1.5*metresPerPixel);
        weight*=min(1.,.95/(radius*radius));
        mv.xy+=disc*radius;
    }
    gl_Position=projectionMatrix*mv;
    #include <logdepthbuf_vertex>
}`;
const fragment = `
#include <logdepthbuf_pars_fragment>
varying vec2 disc;varying float source,weight,seed;
void main(){
    float r2=dot(disc,disc);
    if(r2>1. || weight<.002)discard;
    #include <logdepthbuf_fragment>
    float intensity=source>.5?(.36*exp(-5.*r2)+.68*exp(-30.*r2)):.13*exp(-3.6*r2);
    vec3 lamp=mix(vec3(1.,.58,.28),vec3(.96,.83,.64),seed);
    gl_FragColor=vec4(lamp*intensity*weight,1.);
}`;
function streetLightMesh(THREE, map, height, capacity, uniforms) {
    const anchor = new THREE.Vector3(),
        up = new THREE.Vector3(),
        east = new THREE.Vector3(),
        north = new THREE.Vector3();
    const g = new THREE.InstancedBufferGeometry(),
        corners = [],
        indices = [];
    for (const l of [0, 1]) {
        corners.push(-1, -1, l, 1, -1, l, 1, 1, l, -1, 1, l);
        const i = l * 4;
        indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(corners, 3));
    g.setIndex(indices);
    const bases = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(
        THREE.DynamicDrawUsage
    );
    const slopes = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(
        THREE.DynamicDrawUsage
    );
    g.setAttribute("base", bases);
    g.setAttribute("slopeSeed", slopes);
    const sampled = new WeakMap(),
        target = new THREE.Vector3();
    function update(points, center, versions) {
        map.projection.projectPoint(center, anchor);
        up.copy(anchor).normalize();
        east.set(-up.y, up.x, 0).normalize();
        north.crossVectors(up, east);
        for (let i = 0; i < points.length; i++) {
            const { mx, my, record, index, id } = points[i];
            // A moving camera normally keeps most of the same fixtures. Reuse
            // geometry in Earth coordinates until this source tile's DEM changes.
            let page = sampled.get(record);
            const version = versions.get(id);
            if (!page || page.version !== version) {
                page = { version, points: new Map() };
                sampled.set(record, page);
            }
            let fixture = page.points.get(index);
            if (!fixture) {
                const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI,
                    lon = mx * 360 - 180;
                const h = height.atMercator(mx, my);
                const d = 3 / (40075016.68558 * Math.cos((lat * Math.PI) / 180));
                const world = map.projection.projectPoint(
                    { latitude: lat, longitude: lon, altitude: h },
                    new THREE.Vector3()
                );
                const clamp = s => Math.max(-1.5, Math.min(1.5, s));
                fixture = {
                    world,
                    e: clamp((height.atMercator((mx + d) % 1, my) - h) / 3),
                    n: clamp((height.atMercator(mx, my - d) - h) / 3),
                    seed:
                        ((Math.imul(Math.floor(mx * 1e8), 1597334677) ^
                            Math.imul(Math.floor(my * 1e8), 3812015801)) >>>
                            0) /
                        4294967296
                };
                page.points.set(index, fixture);
            }
            target.subVectors(fixture.world, anchor).toArray(bases.array, 3 * i);
            slopes.setXYZ(i, fixture.e, fixture.n, fixture.seed);
        }
        g.instanceCount = points.length;
        for (const a of [bases, slopes]) {
            a.updateRange.offset = 0;
            a.updateRange.count = 3 * points.length;
            if (points.length) a.needsUpdate = true;
        }
    }
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            ...uniforms,
            east: { value: east },
            north: { value: north },
            up: { value: up }
        },
        vertexShader: vertex,
        fragmentShader: fragment,
        side: THREE.DoubleSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: true,
        depthWrite: false
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.anchor = anchor;
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    map.mapAnchors.add(mesh);
    return {
        update,
        dispose() {
            map.mapAnchors.remove(mesh);
            mesh.removeFromParent();
            g.dispose();
            mat.dispose();
        }
    };
}
module.exports = { streetLightMesh };
