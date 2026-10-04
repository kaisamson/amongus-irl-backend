// Saves the SFU campus floor plans next to the server, as the fallback when SFU can't be reached
// from the hosting provider. Run from a network that can reach SFU: npm run campus:snapshot
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CampusCache } from "../src/campus.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "snapshot", "campus.json.gz");
const gzip = await new CampusCache().fetchFresh();
await writeFile(out, gzip);
console.log(`Wrote ${out} (${Math.round(gzip.length / 1024)} KB)`);
