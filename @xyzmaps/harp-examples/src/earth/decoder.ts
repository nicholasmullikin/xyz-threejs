/** Worker services needed by the Earth renderer. Other examples keep decoder.bundle.js. */
import { PNGTileDecoderService } from "../../decoder/png_decoder";
import "./building-decoder";

PNGTileDecoderService.start();
