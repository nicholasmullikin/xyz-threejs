// The window mask is shared with the daylight material. Group offices by
// floor and neighboring rooms, and integrate panes into their area mean as
// the camera pulls away. Coordinates remain fixed while the sun moves.
const facadeLights = `
float facadeHash(vec2 cell){
    vec3 h=fract(vec3(cell.xyx)*vec3(.1031,.11369,.13787));
    h+=dot(h,h.yzx+19.19);
    return fract((h.x+h.y)*h.z);
}
// Return the exposed glass after the sash and transom. Work in pane
// coordinates so the frames keep their proportions across facade types.
float facadeSash(vec2 uv,vec2 footprint,float office){
    float vertical=1.-smoothstep(.012,.025+footprint.x,abs(uv.x-.5));
    float transom=1.-smoothstep(.012,.025+footprint.y,abs(uv.y-mix(.58,.77,office)));
    vec2 visible=1.-smoothstep(vec2(.025),vec2(.16),footprint);
    return (1.-vertical*visible.x*.84)*(1.-transom*visible.y*.82);
}
vec3 facadeLamps(vec2 cell,float seed,float office,float pane,float paneArea,float resolved,vec3 up,vec3 sun,vec2 paneUv,vec2 footprint){
    vec2 grid=floor(cell),offset=vec2(seed*97.,seed*149.);
    float floorLight=facadeHash(vec2(grid.y,seed*69.));
    float wing=facadeHash(floor(grid/vec2(mix(2.,5.,office),1.))+offset);
    float room=facadeHash(grid+offset);
    // The eastward component distinguishes dusk from dawn at the same solar elevation.
    vec2 east=vec2(-up.y,up.x)/max(.0001,length(up.xy));
    float evening=smoothstep(-.25,.62,-dot(sun.xy,east));
    float occupied=mix(.12+.42*evening,.07+.35*evening,office);
    float roomGroup=mix(.75*wing+.25*room,.63*floorLight+.37*wing,office);
    float threshold=mix(.82,.43,occupied);
    float on=smoothstep(threshold-.035,threshold+.035,roomGroup)*mix(.66,1.,room);
    vec3 warm=mix(vec3(1.,.39,.14),vec3(1.,.72,.44),wing);
    vec3 lamp=mix(warm,vec3(.81,.86,.91),office*(.42+.43*floorLight));
    // A partly lowered shade softens the upper part of a room. As the pane
    // shrinks, fade the interior into its mean rather than aliasing the edge.
    float blind=1.-.68*smoothstep(room-.04-footprint.y,room+.04+footprint.y,paneUv.y)
                       *smoothstep(.4,.78,wing);
    float interior=blind*mix(.70,1.18,clamp(.65*paneUv.y+.35*paneUv.x,0.,1.));
    on*=mix(.91,interior,1.-smoothstep(.08,.4,max(footprint.x,footprint.y)));
    return lamp*mix(paneArea*occupied*.67,pane*on,resolved);
}
`;
module.exports = { facadeLights };
