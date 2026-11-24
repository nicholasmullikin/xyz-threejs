// Reuse resident satellite pages for survey models that contain geometry only.
// A tile-local tangent frame keeps roof coordinates stable at street scale.
function surveyRoofStyle(THREE, map, cartographic, surfacePages, sun, photo) {
    const level = 14,
        n = 2 ** level,
        lon = cartographic.lon,
        lat = cartographic.lat;
    const x = Math.floor((lon / (2 * Math.PI) + 0.5) * n),
        y = Math.floor((1 - Math.asinh(Math.tan(lat)) / Math.PI) * 0.5 * n);
    const tile = { level, column: x, row: y },
        parent = { level: 12, column: x >> 2, row: y >> 2 };
    const midLon = ((x + 0.5) / n - 0.5) * 2 * Math.PI,
        midLat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
    const c = Math.cos(midLat),
        s = Math.sin(midLat),
        cl = Math.cos(midLon),
        sl = Math.sin(midLon);
    const up = new THREE.Vector3(c * cl, c * sl, s),
        center = up.clone().multiplyScalar(6378137);
    const u = {
        surveyEye: { value: new THREE.Vector3() },
        surveyEast: { value: new THREE.Vector3(-sl, cl, 0) },
        surveyNorth: { value: new THREE.Vector3(-s * cl, -s * sl, c) },
        surveyUp: { value: up },
        surveyInvWidth: { value: n / (2 * Math.PI * 6378137 * c) },
        surveySun: sun
    };
    const slots = photo ? 0 : Math.min(5, Math.max(1, map.renderer.capabilities.maxTextures - 6));
    const indices = Array.from({ length: slots }, (_, i) => i);
    for (const i of indices) {
        u["surveyMap" + i] = { value: null };
        u["surveyUv" + i] = { value: new THREE.Vector4() };
        u["surveyWeight" + i] = { value: 0 };
    }
    function attach(shader) {
        Object.assign(shader.uniforms, u);
        const vary = "varying vec3 surveyLocal; varying vec3 surveyWorldNormal;";
        shader.vertexShader =
            vary +
            "\nuniform vec3 surveyEye,surveyEast,surveyNorth,surveyUp;\n" +
            shader.vertexShader.replace(
                "#include <project_vertex>",
                `
            #include <project_vertex>
            vec3 surveyPoint=(modelMatrix*vec4(transformed,1.)).xyz+surveyEye;
            surveyLocal=vec3(dot(surveyPoint,surveyEast),dot(surveyPoint,surveyNorth),dot(surveyPoint,surveyUp));
            surveyWorldNormal=mat3(modelMatrix)*normal;
        `
            );
        shader.fragmentShader =
            vary +
            "\nuniform float surveyInvWidth; uniform vec3 surveyUp,surveySun,surveyEast,surveyNorth;\n" +
            indices
                .map(
                    i =>
                        `uniform sampler2D surveyMap${i};uniform vec4 surveyUv${i};uniform float surveyWeight${i};`
                )
                .join("\n") +
            `\n${require("./facade-night").facadeLights}
vec3 sampleRoof(vec3 base,sampler2D photo,vec4 tr,float weight,vec2 uv){
                if(weight<=0.)return base;
                vec2 p=uv*tr.xy+tr.zw;
                if(any(lessThan(p,vec2(0.)))||any(greaterThan(p,vec2(1.))))return base;
                vec4 texel=texture2D(photo,p);return mix(base,texel.rgb,weight*texel.a);
            }\n` +
            shader.fragmentShader.replace(
                "#include <output_fragment>",
                `
                vec3 surfaceNormal=normalize(surveyWorldNormal);
                float upward=dot(surfaceNormal,surveyUp);
                vec3 emission=vec3(0.);
                vec3 paint=vec3(.57,.51,.46);
                if(upward>.24){
                    vec2 uv=surveyLocal.xy*surveyInvWidth+.5;
                    paint=vec3(.50,.44,.40);
                    ${indices.map(i => `paint=sampleRoof(paint,surveyMap${i},surveyUv${i},surveyWeight${i},uv);`).join("\n")}
                }else{
                    vec2 wallNormal=vec2(dot(surfaceNormal,surveyEast),dot(surfaceNormal,surveyNorth));
                    vec2 paneCoord=vec2(dot(surveyLocal.xy,normalize(vec2(-wallNormal.y,wallNormal.x))),surveyLocal.z)/vec2(2.7,3.15);
                    vec2 aa=max(fwidth(paneCoord),vec2(.015)),f=fract(paneCoord);
                    vec2 windowMask=smoothstep(vec2(.19,.23)-aa,vec2(.19,.23)+aa,f)*(1.-smoothstep(vec2(.76,.81)-aa,vec2(.76,.81)+aa,f));
                    float seed=facadeHash(vec2(floor(dot(surveyLocal.xy,normalize(wallNormal))*.2),floor(8.*wallNormal.y)));
                    float office=smoothstep(.45,.75,seed);
                    vec2 paneUv=(f-vec2(.19,.23))/vec2(.57,.58),footprint=aa/vec2(.57,.58);
                    float pane=windowMask.x*windowMask.y*facadeSash(paneUv,footprint,office);
                    float glass=mix(pane,.33,smoothstep(.25,1.,max(aa.x,aa.y)));
                    paint=mix(paint,vec3(.29,.32,.34),glass);
                    vec3 worldKm=cameraKm+surveyRelative;
                    float darkness=nightWeight(worldKm)*lightsEnabled;
                    if(darkness>0. && upward>-.35){
                        float resolved=1.-smoothstep(.24,1.,max(aa.x,aa.y));
                        emission=facadeLamps(paneCoord,seed,office,pane,.33,resolved,normalize(worldKm),surveySun,paneUv,footprint)
                            *darkness*mix(.08,.35,smoothstep(.025,.6,citySignal(worldKm)));
                    }
                }
                float facing=max(0.,dot(surfaceNormal,surveySun));
                outgoingLight=surveyRadiance(${photo ? "diffuseColor.rgb,-1." : "pow(paint,vec3(2.2)),facing"},emission,surfaceNormal);
                #include <output_fragment>
            `
            );
    }
    function bind() {
        u.surveyEye.value.copy(map.camera.position).sub(center);
        if (photo) return;
        const coarse = surfacePages(parent).base,
            local = surfacePages(tile);
        for (const i of indices) {
            const page = i === 0 ? coarse : i === 1 ? local.base : local.details[i - 2];
            u["surveyMap" + i].value = page?.texture ?? null;
            u["surveyWeight" + i].value = page
                ? page.fade * Math.max(0, Math.min(1, (page.z - 11) / 3))
                : 0;
            if (!page) continue;
            const tr = u["surveyUv" + i].value.fromArray(page.uv);
            if (i === 0) {
                tr.z += ((x % 4) / 4) * tr.x;
                tr.w += ((3 - (y % 4)) / 4) * tr.y;
                tr.x *= 0.25;
                tr.y *= 0.25;
            }
        }
    }
    function release() {
        for (const i of indices) u["surveyMap" + i].value = null;
    }
    return { attach, bind, release };
}
module.exports = { surveyRoofStyle };
