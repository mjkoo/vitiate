import { fuzz } from "vitiate";
import { processInput } from "../src/process-input.js";

fuzz("detect-vulnerabilities", (data: Buffer) => {
  processInput(data.toString("utf-8"));
});
