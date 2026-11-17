/* Globe example: application code lives in source and is bundled without post-build patches. */
import {main} from "./earth/main";
main().catch(error=>{
 const message=document.createElement("p");message.setAttribute("role","alert");
 message.style.cssText="position:absolute;inset:20px;color:white;background:#14202d;padding:20px";
 message.textContent="The 3D Earth could not start in this browser. Reload the page or use the 2D maps above.";
 document.body.appendChild(message);
 console.error("Earth initialization failed",error);
});
