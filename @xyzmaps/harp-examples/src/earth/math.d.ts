import {ClipPlanesEvaluator} from "@xyzmaps/harp-mapview";
import {TileKey} from "@xyzmaps/harp-geoutils";
export const R:number;
export function clipPlanes():ClipPlanesEvaluator;
export function transform(child:{z:number;x:number;y:number},parent:{z:number;x:number;y:number}):number[];
export function fetchTerrain(key:TileKey,token:string,signal?:AbortSignal,repair?:boolean):Promise<ArrayBuffer | {kind:"empty-ocean-dem"}>;
export function triangleHeight(a:number,b:number,c:number,d:number,x:number,y:number):number;
