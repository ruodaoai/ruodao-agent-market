#!/usr/bin/env node
import { generatePublicText, publicTextFailure, readPublicPayload } from "./public-text-core.mjs";

let result;
try {
  const payload = await readPublicPayload(process.stdin);
  result = await generatePublicText(payload);
} catch {
  result = publicTextFailure("invalid_input");
}
process.stdout.write(JSON.stringify(result) + "\n");
process.exitCode = result.state === "succeeded" ? 0 : 1;
