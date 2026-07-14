import { fuzz } from "@vitiate/core";
import jpeg from "jpeg-js";

// jpeg-js (pinned 0.4.4): a compact but dense binary decoder (marker state
// machine, Huffman decode, IDCT, colour convert). jpeg-js is pure CommonJS, so
// the coverage measured here comes from vitiate's `instrument.packages` CJS
// instrumentation. maxResolutionInMP / maxMemoryUsageInMB cap the known
// resource-exhaustion path (CVE-2020-8175) so runs are not dominated by giant
// allocations. Malformed-JPEG throws are expected and swallowed.
fuzz("jpeg-js decode", (data: Buffer) => {
  let img;
  try {
    img = jpeg.decode(data, {
      maxResolutionInMP: 100,
      maxMemoryUsageInMB: 512,
    });
  } catch {
    return;
  }

  if (typeof img.width !== "number" || typeof img.height !== "number") {
    throw new Error("jpeg.decode returned malformed dimensions");
  }
  if (!(img.data instanceof Uint8Array) && !Buffer.isBuffer(img.data)) {
    throw new Error("jpeg.decode returned non-buffer pixel data");
  }
});
