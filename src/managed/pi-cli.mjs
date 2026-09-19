// The pi CLI this runner ships with. The legacy relay starts one per session.
import { loadPi, piPackageDir } from "./pi-sdk.mjs";

const [packageDir, ...args] = process.argv.slice(2);
await (await loadPi(piPackageDir(packageDir))).main(args);
