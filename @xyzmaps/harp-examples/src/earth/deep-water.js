// Draw a single spherical sea surface when even the true geometric horizon
// lies inside a conservatively land-free ETOPO neighbourhood.
const { SIZE, makeSlopes } = require("./ocean-spectrum");
function createDeepWater(THREE, map, sky, env, clouds, wind, slopeGlint, debug) {
    const uniforms = {
        ...sky.uniforms,
        ...env.uniforms,
        ...clouds?.uniforms,
        waterWind: { value: wind },
        deepWave: { value: null },
        deepWeight: { value: 0 },
        deepAltitude: { value: 0 },
        deepPhase: { value: new THREE.Vector2() }
    };
    const material = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        extensions: { derivatives: true },
        defines: {
            ...(debug ? { EARTH_WATER_DEBUG: 1 } : {}),
            ...(slopeGlint ? { EARTH_WATER_SLOPES: 1 } : {}),
            ATMOSPHERE_STEPS: 6,
            EARTH_WATER_MODEL: 1,
            EARTH_WATER_FILTER: 1,
            EARTH_WATER_BODY: 1,
            ...(clouds ? { EARTH_WATER_CLOUDS: 1 } : {})
        },
        vertexShader:
            "varying vec2 ndc;void main(){ndc=position.xy;gl_Position=vec4(position.xy,0.,1.);}",
        fragmentShader: `precision highp float;
varying vec2 ndc;uniform mat4 inverseProjection;uniform mat3 cameraRotation;
uniform sampler2D deepWave;uniform float deepWeight,deepAltitude;uniform vec2 deepPhase;
${require("./atmosphere").glsl}
${require("./environment").glsl}
${require("./sky-view").coordinates}
${require("./water-lighting").glsl}
void main(){
 vec4 ray=inverseProjection*vec4(ndc,1.,1.);
 vec3 dir=normalize(cameraRotation*ray.xyz);
 float b=dot(cameraKm,dir),c=deepAltitude*(2.*planetRadius+deepAltitude),disc=b*b-c;
 if(b>=0. || disc<=0.)discard;
 #ifdef EARTH_WATER_DEBUG
 gl_FragColor=vec4(.04,.45,1.,deepWeight);return;
 #endif
 float distance=c/(-b+sqrt(disc));vec3 delta=dir*distance,p=cameraKm+delta,up=normalize(p);
 // Offset periodic coordinates on the CPU before adding local metres.
 // This keeps narrow glints stable during a low-altitude camera translation.
 const vec3 a=vec3(.812,.331,.48),j=vec3(-.45,.877,.16);
 vec2 coord=deepPhase+vec2(dot(delta,a),dot(delta,j))*8.;
 vec2 shift=cloudTime*vec2(.011,.003);
 vec2 slope=(texture2D(deepWave,coord+shift).rg-.5)*.37+
    (texture2D(deepWave,coord*2.-shift*1.7).ba-.5)*.21;
 vec2 span=fwidth(coord);
 float pixel=max(span.x,span.y);
 if(pixel<.009)slope+=(texture2D(deepWave,coord*17.+shift*6.).ba-.5)*.12*(1.-smoothstep(.002,.009,pixel));
 vec3 g=(a*slope.x+j*slope.y)*sqrt(waterWind/.45);
 vec3 n=normalize(up+g-up*dot(g,up)+waterSwell(p,up,.055));
 vec3 r=reflect(dir,n);r=normalize(r+up*max(0.,.004-dot(r,up)));
 vec3 skyLight,trans;sampleSkyView(r,skyLight,trans);
 #ifdef EARTH_WATER_CLOUDS
 skyLight=reflectedClouds(skyLight,r,waterRoughness(smoothstep(.003,.02,pixel),waterWind));
 #endif
 float day=dot(up,sunDirection);
 vec3 body=vec3(.0012,.0038,.0085)*(.015+smoothstep(-.12,.4,day));
 vec3 light=waterRadiance(body,skyLight,n,-dir,up,sunlight(p),day,smoothstep(.003,.02,pixel),waterWind,vec2(1.));
 vec3 haze=aerialPerspective(cameraKm,dir,distance,trans);
 gl_FragColor=vec4(displayColor(light*trans+haze),deepWeight);
}`
    });
    const geo = new THREE.PlaneGeometry(2, 2),
        mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10500;
    mesh.visible = false;
    map.scene.add(mesh);
    const stats = { visible: false, clearanceKm: 0, weight: 0 };
    const abort = new AbortController();
    let grid,
        loading = false,
        retry = 0,
        job,
        timer,
        texture,
        disposed = false,
        readyAt = 0;
    function generate() {
        if (texture || job) return;
        job = makeSlopes();
        function advance() {
            if (disposed) return;
            const start = performance.now();
            do {
                const s = job.next();
                if (!s.done) continue;
                texture = new THREE.DataTexture(s.value, SIZE, SIZE, THREE.RGBAFormat);
                texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
                texture.minFilter = THREE.LinearMipmapLinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.generateMipmaps = true;
                texture.needsUpdate = true;
                uniforms.deepWave.value = texture;
                job = undefined;
                readyAt = performance.now();
                map.update();
                return;
            } while (performance.now() - start < 1.5);
            timer = setTimeout(advance, 0);
        }
        timer = setTimeout(advance, 0);
    }
    function update(on, now) {
        stats.visible = mesh.visible = false;
        stats.weight = 0;
        if (!on || document.hidden || !sky.uniforms.skyViewEnabled.value) return;
        const cam = map.camera.position,
            h = cam.length() * 0.001 - 6378.137;
        if (h <= 0 || h > 16) return;
        if (!grid) {
            if (!loading && now >= retry) {
                loading = true;
                fetch("/earth-background/ocean-clearance.bin", { signal: abort.signal })
                    .then(r => {
                        if (!r.ok) throw Error("Ocean coverage unavailable");
                        return r.arrayBuffer();
                    })
                    .then(bytes => {
                        if (bytes.byteLength !== 32768) throw Error("Invalid ocean coverage");
                        if (!disposed) {
                            grid = new Uint8Array(bytes);
                            map.update();
                        }
                    })
                    .catch(() => {
                        retry = performance.now() + 60000;
                    })
                    .finally(() => {
                        loading = false;
                    });
            }
            return;
        }
        const longitude = Math.atan2(cam.y, cam.x) / (2 * Math.PI) + 0.5;
        const latitude = 0.5 - Math.asin(cam.z / cam.length()) / Math.PI;
        const x = longitude * 256 - 0.5,
            y = latitude * 128 - 0.5,
            ix = Math.floor(x),
            iy = Math.floor(y);
        const sample = (col, row) =>
            grid[Math.min(127, Math.max(0, row)) * 256 + ((col + 256) % 256)] * 4;
        const lerp = (a, b, t) => a + (b - a) * t;
        const km = lerp(
            lerp(sample(ix, iy), sample(ix + 1, iy), x - ix),
            lerp(sample(ix, iy + 1), sample(ix + 1, iy + 1), x - ix),
            y - iy
        );
        stats.clearanceKm = km;
        const horizon = Math.sqrt(h * (12756.274 + h));
        const t = Math.min(1, Math.max(0, (km - horizon - 10) / 90));
        if (t <= 0) return;
        if (!texture) {
            generate();
            return;
        }
        const start = Math.min(1, (now - readyAt) / 650);
        const weight = t * t * (3 - 2 * t) * Math.min(1, (16 - h) / 6) * start;
        uniforms.deepWeight.value = stats.weight = weight;
        uniforms.deepAltitude.value = h;
        const phase = (a, b, c) => {
            const q = (cam.x * a + cam.y * b + cam.z * c) * 0.008;
            return q - Math.floor(q);
        };
        uniforms.deepPhase.value.set(phase(0.812, 0.331, 0.48), phase(-0.45, 0.877, 0.16));
        stats.visible = mesh.visible = weight > 0.001;
        if (start < 1) map.update();
    }
    return {
        stats,
        update,
        dispose() {
            disposed = true;
            abort.abort();
            clearTimeout(timer);
            map.scene.remove(mesh);
            texture?.dispose();
            geo.dispose();
            material.dispose();
        }
    };
}
module.exports = { createDeepWater };
