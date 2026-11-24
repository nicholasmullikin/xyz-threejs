const atmosphere = require("./atmosphere").glsl;
const weather = require("./environment").glsl;
const aerial = require("./aerial-view").coordinates;
const shadow = require("./cloud-shadow-cache").coordinates;

// Share the native terrain's radiometric curve, sun transmittance and clouds.
// The source photography already contains directional shadows: use its regional
// daylight exposure, leaving measured wall geometry and photographic shading intact.
function attachSurveyLight(shader, sky, environment) {
    Object.assign(shader.uniforms, sky.uniforms, environment.uniforms);
    const atlas = !!sky.aerial;
    shader.vertexShader =
        "varying vec3 surveyRelative;\n" +
        shader.vertexShader.replace(
            "#include <project_vertex>",
            "#include <project_vertex>\n surveyRelative=(modelMatrix*vec4(transformed,1.)).xyz*.001;"
        );
    shader.fragmentShader =
        `#define ATMOSPHERE_STEPS 2
        varying vec3 surveyRelative;
        ${environment.localLights ? "#define EARTH_LOCAL_LIGHTS" : ""}
        ${atmosphere}
        ${atlas ? aerial : ""}
        ${atlas ? "#define EARTH_CLOUD_SHADOW_CACHE\n" + shadow : ""}
        ${weather}
        vec3 surveyRadiance(vec3 albedo,float incidence,vec3 emission,vec3 normal){
            vec3 point=cameraKm+surveyRelative;
            float day=dot(normalize(point),sunDirection);
            float scale=incidence<0. ? (.52+.33*max(day,0.)) : (.45+.55*incidence);
            vec3 skyLight=surfaceAmbient(normalize(point),normal,day,vec3(.025)+vec3(.28,.34,.43)*smoothstep(-.12,.18,day));
            vec3 direct=sunlight(point)*cloudShadow(point)*scale*smoothstep(-.03,.06,day);
            float distance=length(surveyRelative);vec3 ray=surveyRelative/max(.00001,distance),trans;
            vec3 haze;
            ${atlas ? "if(aerialViewEnabled>.5)haze=cachedAerial(ray,distance,trans);else" : ""}
                haze=aerialPerspective(cameraKm,ray,distance,trans);
            return displayColor((emission+photographicReflectance(albedo,day)*(skyLight+direct))*trans+haze);
        }
        vec3 surveyLight(vec3 albedo,float incidence){return surveyRadiance(albedo,incidence,vec3(0.),normalize(cameraKm+surveyRelative));}\n` +
        shader.fragmentShader;
}
module.exports = { attachSurveyLight };
