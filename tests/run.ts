import { createJiti } from "/tmp/pi-mono/node_modules/jiti/lib/jiti.cjs";
const jiti = createJiti("/tmp/pi-cache-match-work");
const fuzz = jiti("./tests/fuzz.ts");
// fuzz runs itself on import; no further action needed.
void fuzz;
