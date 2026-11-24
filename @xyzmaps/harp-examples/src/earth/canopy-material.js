const vertex = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 crown;
attribute vec2 groundUv;
attribute vec2 foundation;
uniform vec3 treeEast,treeNorth,treeUp,sunDirection;
uniform float patchWidth,hasPage;
uniform sampler2D surfacePage;
uniform vec4 surfaceUv;uniform vec4 spriteBounds[24];
varying vec2 atlasPosition;
varying vec2 secondPosition;
varying float viewBlend;
varying vec3 tint;
varying float coverage;varying vec3 cardSun;
void main(){
 vec2 offset=(groundUv-.5)*patchWidth;
 vec3 base=(modelMatrix*vec4(0.,0.,0.,1.)).xyz+treeEast*offset.x+treeNorth*offset.y+treeUp*foundation.x;
 vec3 middle=base+treeUp*crown.x*.5,dir=normalize(-middle);
 vec3 right=cross(treeUp,dir);
 if(length(right)<.002)right=cross(vec3(0.,1.,0.),dir);
 right=normalize(right);vec3 lift=normalize(cross(dir,right));
 float extent=crown.x/(crown.y==1.?.725:.893);
 cardSun=vec3(dot(sunDirection,right),dot(sunDirection,lift),dot(sunDirection,dir));
 float elevation=asin(clamp(dot(dir,treeUp),0.,1.));
 float stepView=clamp((elevation-.14)/.61,0.,2.);
 float col=2.*floor(stepView)+step(.5,crown.z);
 int index=int(crown.y*6.+col+.1);
 vec4 box=spriteBounds[index],other=spriteBounds[int(min(float(index)+2.,crown.y*6.+5.))];
 viewBlend=smoothstep(.2,.8,fract(stepView));
 if(viewBlend>.001){box=vec4(min(box.xy,other.xy),max(box.zw,other.zw));}
 vec2 plane=mix(box.xy,box.zw,uv)-.5;
 vec3 world=middle+extent*(right*plane.x*(.88+.23*crown.z)+lift*plane.y);
 vec2 sprite=plane+.5;
 atlasPosition=vec2((col+sprite.x)/8.,(3.-crown.y+sprite.y)/4.);
 secondPosition=atlasPosition+vec2(step(col,3.5)*.25,0.);
 float day=dot(treeUp,sunDirection);
 tint=vec3(.21,.25,.17);
 coverage=foundation.y*(1.-smoothstep(730.,1100.,length(middle)));
 if(hasPage>.5){
   vec2 p=groundUv*surfaceUv.xy+surfaceUv.zw;
   vec2 d=surfaceUv.xy*clamp(crown.x*.16,2.,5.)/patchWidth;
   vec3 c=texture2D(surfacePage,p).rgb,a=texture2D(surfacePage,p+vec2(d.x,0.)).rgb,b=texture2D(surfacePage,p-vec2(d.x,0.)).rgb;
   vec3 f=texture2D(surfacePage,p+vec2(0.,d.y)).rgb,g=texture2D(surfacePage,p-vec2(0.,d.y)).rgb;
   vec3 mean=(2.*c+a+b+f+g)/6.;
   vec3 foliage=mix(mean,min(min(a,b),min(f,g)),.34);
   float lum=dot(foliage,vec3(.27,.55,.18)),green=mean.g-min(mean.r,mean.b);
   // A footprint at a shoreline can span both land and water. Smooth water
   // and uniform bright roofs have little high-frequency land contrast.
   coverage*=smoothstep(.035,.15,length(a-b)+length(f-g))*smoothstep(-.03,.014,green);
   coverage*=1.-smoothstep(.09,.19,mean.r-mean.g);
   coverage*=1.-smoothstep(.45,.63,dot(mean,vec3(.27,.55,.18)));
   tint=clamp(foliage/max(.085,lum),vec3(.65),vec3(1.3))*(.065+.65*clamp(lum,.035,.40))*vec3(.89,1.,.89);
 }
 tint*=mix(.045,1.,smoothstep(-.11,.33,day))*(.9+.15*crown.z);
 if(coverage<.03){gl_Position=vec4(2.,2.,2.,1.);return;}
 gl_Position=projectionMatrix*viewMatrix*vec4(world,1.);
 #include <logdepthbuf_vertex>
}`;
const fragment = `
#include <logdepthbuf_pars_fragment>
uniform sampler2D canopyAtlas;
varying vec2 atlasPosition,secondPosition;
varying float viewBlend,coverage;
varying vec3 tint,cardSun;
void main(){
 vec4 leaf=texture2D(canopyAtlas,atlasPosition);
 if(viewBlend>.001)leaf=mix(leaf,texture2D(canopyAtlas,secondPosition),viewBlend);
 if(leaf.a*coverage<.30)discard;
 #include <logdepthbuf_fragment>
 vec2 xy=leaf.gb*2.-1.;
 vec3 n=normalize(vec3(xy,sqrt(max(.01,1.-dot(xy,xy)))));
 float direct=smoothstep(-.45,.85,dot(n,cardSun));
 vec3 color=tint*(.46+2.55*leaf.r)*mix(.73,1.18,direct);
 gl_FragColor=vec4(color,1.);
}`;
function createPatch(THREE, map, tile, values, atlas, getHeight, getSurfacePages, sun) {
    const { latitudeAt } = require("./canopy-grid");
    const n = 2 ** tile.z,
        longitude = ((tile.x + 0.5) / n) * 360 - 180,
        latitude = latitudeAt((tile.y + 0.5) / n);
    const anchor = map.projection.projectPoint(
        { latitude, longitude, altitude: 0 },
        new THREE.Vector3()
    );
    const up = anchor.clone().normalize(),
        east = new THREE.Vector3(-up.y, up.x, 0).normalize(),
        north = up.clone().cross(east);
    const width = (Math.cos((latitude * Math.PI) / 180) * 2 * Math.PI * 6378137) / n;
    const geometry = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry();
    geometry.index = quad.index;
    geometry.setAttribute("position", quad.attributes.position);
    geometry.setAttribute("uv", quad.attributes.uv);
    const interleaved = new THREE.InstancedInterleavedBuffer(values, 5);
    geometry.setAttribute(
        "groundUv",
        new THREE.InterleavedBufferAttribute(interleaved, 2, 0, false)
    );
    geometry.setAttribute("crown", new THREE.InterleavedBufferAttribute(interleaved, 3, 2, false));
    const heights = new THREE.InstancedBufferAttribute(
        new Float32Array((values.length / 5) * 2),
        2
    ).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("foundation", heights);
    geometry.instanceCount = heights.count;
    const uniforms = {
        treeEast: { value: east },
        treeNorth: { value: north },
        treeUp: { value: up },
        sunDirection: sun,
        patchWidth: { value: width },
        hasPage: { value: 0 },
        surfacePage: { value: null },
        surfaceUv: { value: new THREE.Vector4() },
        canopyAtlas: { value: atlas },
        spriteBounds: { value: require("./canopy-bounds.json").map(b => new THREE.Vector4(...b)) }
    };
    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: vertex,
        fragmentShader: fragment,
        extensions: { fragDepth: true }
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.anchor = anchor;
    const key = { level: tile.z, column: tile.x, row: tile.y };
    mesh.onBeforeRender = () => {
        const page = getSurfacePages(key).base;
        uniforms.hasPage.value = page && page.z >= 12 ? 1 : 0;
        uniforms.surfacePage.value = uniforms.hasPage.value ? page.texture : null;
        if (page) uniforms.surfaceUv.value.fromArray(page.uv);
        material.uniformsNeedUpdate = true;
    };
    mesh.onAfterRender = () => {
        uniforms.surfacePage.value = null;
    };
    let revision;
    function updateGround() {
        const next = getHeight.revisionForTile(tile.x, tile.y, tile.z);
        if (revision === next) return false;
        revision = next;
        let low = Infinity,
            high = -Infinity;
        const grid = 9,
            step = 1 / (grid - 1),
            surface = new Float32Array(grid * grid);
        for (let row = 0; row < grid; row++)
            for (let col = 0; col < grid; col++)
                surface[row * grid + col] = getHeight.atMercator(
                    (tile.x + col * step) / n,
                    (tile.y + row * step) / n
                );
        for (let i = 0; i < heights.count; i++) {
            const h = getHeight.atMercator(
                (tile.x + values[5 * i]) / n,
                (tile.y + 1 - values[5 * i + 1]) / n
            );
            const col = Math.min(grid - 2, Math.floor(values[5 * i] * (grid - 1)));
            const row = Math.min(grid - 2, Math.floor((1 - values[5 * i + 1]) * (grid - 1)));
            const at = row * grid + col;
            const grade =
                Math.hypot(surface[at + 1] - surface[at], surface[at + grid] - surface[at]) /
                (width * step);
            heights.array[2 * i] = h;
            heights.array[2 * i + 1] = 1 - Math.max(0, Math.min(1, (grade - 1.05) / 0.85));
            low = Math.min(low, h);
            high = Math.max(high, h + values[5 * i + 2]);
        }
        heights.needsUpdate = true;
        geometry.boundingSphere = new THREE.Sphere(
            up.clone().multiplyScalar((low + high) * 0.5),
            Math.hypot(width * 0.72, (high - low) * 0.5) + 85
        );
        return true;
    }
    updateGround();
    map.mapAnchors.add(mesh);
    return {
        mesh,
        updateGround,
        dispose() {
            map.mapAnchors.remove(mesh);
            mesh.removeFromParent();
            geometry.dispose();
            material.dispose();
        }
    };
}
module.exports = { createPatch };
