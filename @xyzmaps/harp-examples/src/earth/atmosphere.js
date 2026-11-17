/* Spherical single-scattering atmosphere, in kilometres. Apache-2.0.
 * References: Maxime Heckel, On Rendering the Sky, Sunsets, and Planets;
 * Bruneton/Neyret atmospheric transmittance, Rayleigh and Cornette-Shanks phases.
 * CPU optical-depth LUT avoids a nested light raymarch in every sky fragment.
 */

const R = require("./math").R / 1000,
    TOP = R + 100;
function makeLut(THREE) {
    const width = 256,
        height = 64,
        data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const altitude = (y / (height - 1)) ** 2 * 100 + 0.001,
                r = R + altitude,
                mu = (x / (width - 1)) * 2 - 1;
            const groundDisc = r * r * (mu * mu - 1) + R * R;
            let trans = [0, 0, 0];
            if (!(mu < 0 && groundDisc > 0)) {
                const distance = -r * mu + Math.sqrt(r * r * (mu * mu - 1) + TOP * TOP);
                let odR = 0,
                    odM = 0,
                    odO = 0;
                const steps = 48,
                    step = distance / steps;
                for (let i = 0; i < steps; i++) {
                    const t = (i + 0.5) * step,
                        h = Math.max(0, Math.sqrt(r * r + t * t + 2 * r * mu * t) - R);
                    odR += Math.exp(-h / 8) * step;
                    odM += Math.exp(-h / 1.2) * step;
                    odO += Math.max(0, 1 - Math.abs(h - 25) / 15) * step;
                }
                trans = [0.005802, 0.013558, 0.0331].map((beta, i) =>
                    Math.exp(-beta * odR - 0.00444 * odM - [0.00065, 0.001881, 0.000085][i] * odO)
                );
            }
            const j = (y * width + x) * 4;
            data[j] = Math.round(trans[0] * 255);
            data[j + 1] = Math.round(trans[1] * 255);
            data[j + 2] = Math.round(trans[2] * 255);
            data[j + 3] = 255;
        }
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}
const glsl = `
uniform sampler2D transmittanceLut;
uniform vec3 sunDirection;
uniform vec3 cameraKm;
const float planetRadius=6378.137;
const float atmosphereRadius=6478.137;
const vec3 betaR=vec3(.005802,.013558,.0331);
const vec3 betaO=vec3(.00065,.001881,.000085);
vec2 sphereInterval(vec3 origin,vec3 dir,float radius){
 float b=dot(origin,dir),d=b*b-dot(origin,origin)+radius*radius;
 if(d<0.)return vec2(1e9,-1e9);
 float q=sqrt(d);return vec2(-b-q,-b+q);
}
vec3 sunlight(vec3 p){
 float h=max(length(p)-planetRadius,0.);
 float mu=dot(normalize(p),sunDirection);
 vec2 uv=vec2(mu*.5+.5,sqrt(clamp(h/100.,0.,1.)));
 return texture2D(transmittanceLut,uv*vec2(255./256.,63./64.)+vec2(.5/256.,.5/64.)).rgb;
}
vec3 densities(vec3 p){
 float h=max(length(p)-planetRadius,0.);
 return vec3(exp(-h/8.),exp(-h/1.2),max(0.,1.-abs(h-25.)/15.));
}
vec3 atmosphere(vec3 origin,vec3 dir,float limit,out vec3 transmission){
 vec2 interval=sphereInterval(origin,dir,atmosphereRadius);
 float start=max(0.,interval.x),end=min(limit,interval.y);
 transmission=vec3(1.);
 if(end<=start)return vec3(0.);
 float mu=dot(dir,sunDirection),g=.8;
 float phaseR=3./(16.*3.14159265)*(1.+mu*mu);
 float phaseM=3.*(1.-g*g)*(1.+mu*mu)/(8.*3.14159265*(2.+g*g)*pow(max(.001,1.+g*g-2.*g*mu),1.5));
 vec3 depth=vec3(0.),scatter=vec3(0.);
 // Quadratic spacing resolves the dense air near a ground-level camera.
 for(int i=0;i<ATMOSPHERE_STEPS;i++){
  float a=float(i)/float(ATMOSPHERE_STEPS),b=float(i+1)/float(ATMOSPHERE_STEPS);
  bool nearDense=length(origin+dir*start)<length(origin+dir*end);
  float sa=nearDense?a*a:1.-(1.-a)*(1.-a),sb=nearDense?b*b:1.-(1.-b)*(1.-b);
  float ta=start+(end-start)*sa,tb=start+(end-start)*sb;
  float stepSize=tb-ta;
  vec3 p=origin+dir*((ta+tb)*.5),density=densities(p);
  vec3 extinction=betaR*density.x+vec3(.00444)*density.y+betaO*density.z;
  vec3 atten=exp(-depth-extinction*stepSize*.5);
  scatter+=atten*sunlight(p)*(density.x*betaR*phaseR+density.y*vec3(.003996)*phaseM)*stepSize;
  depth+=extinction*stepSize;
 }
 transmission=exp(-depth);
 return scatter*8.;
}
vec3 displayColor(vec3 color){
 color=max(color,vec3(0.));
 // Fitted filmic response, followed by exactly one linear-to-display conversion.
 color=clamp((color*(2.51*color+.03))/(color*(2.43*color+.59)+.14),0.,1.);
 return pow(color,vec3(1./2.2));
}
`;
function create(THREE, map) {
    const uniforms = {
        transmittanceLut: { value: makeLut(THREE) },
        sunDirection: { value: new THREE.Vector3() },
        cameraKm: { value: new THREE.Vector3() },
        inverseProjection: { value: new THREE.Matrix4() },
        cameraRotation: { value: new THREE.Matrix3() }
    };
    const material = new THREE.ShaderMaterial({
        uniforms,
        depthTest: true,
        depthWrite: false,
        defines: { ATMOSPHERE_STEPS: 24 },
        vertexShader: `varying vec2 ndc;void main(){ndc=position.xy;gl_Position=vec4(position.xy,1.,1.);}`,
        fragmentShader: `precision highp float;varying vec2 ndc;uniform mat4 inverseProjection;uniform mat3 cameraRotation;${glsl}
 void main(){vec4 p=inverseProjection*vec4(ndc,1.,1.);vec3 dir=normalize(cameraRotation*p.xyz);
 vec2 ground=sphereInterval(cameraKm,dir,planetRadius);float end=ground.x>0.?ground.x:1e8;
 vec3 trans;vec3 color=atmosphere(cameraKm,dir,end,trans);
 if(ground.x<0.){float disc=smoothstep(cos(.0048),cos(.0044),dot(dir,sunDirection));color+=trans*disc*14.;}
 float noise=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5;
 gl_FragColor=vec4(displayColor(color)+noise/255.,1.);}`
    });
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    sky.frustumCulled = false;
    sky.renderOrder = 10000;
    map.scene.add(sky);
    function update() {
        uniforms.cameraKm.value.copy(map.camera.position).multiplyScalar(0.001);
        uniforms.inverseProjection.value.copy(map.camera.projectionMatrixInverse);
        uniforms.cameraRotation.value.setFromMatrix4(map.camera.matrixWorld);
    }
    return {
        uniforms,
        update,
        sky,
        dispose() {
            map.scene.remove(sky);
            sky.geometry.dispose();
            material.dispose();
            uniforms.transmittanceLut.value.dispose();
        }
    };
}
module.exports = { create, glsl, makeLut };
