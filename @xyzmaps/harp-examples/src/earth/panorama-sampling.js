// Longitude is periodic. Across the antimeridian, adjacent screen pixels at
// U=0.999 and 0.001 span 0.002 of the panorama, not an entire mip chain.
const glsl = `
vec4 samplePanorama(sampler2D image,vec2 uv){
 #if __VERSION__ >= 300 || defined(GL_EXT_shader_texture_lod)
 vec2 dx=dFdx(uv),dy=dFdy(uv);
 dx.x-=floor(dx.x+.5);dy.x-=floor(dy.x+.5);
 return texture2DGradEXT(image,uv,dx,dy);
 #else
 // Both lookups execute in the same quad. The alternate coordinates put
 // their discontinuity on the opposite meridian; repeat addressing makes
 // the two samples identical except for their implicit texture footprint.
 vec2 alternate=vec2(fract(uv.x+.5)+.5,uv.y);
 vec4 a=texture2D(image,uv),b=texture2D(image,alternate);
 return abs(fract(uv.x)-.5)>.45?b:a;
 #endif
}`;
module.exports = { glsl };
