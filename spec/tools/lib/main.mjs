// Whether a module is the script node was started with. Comparing import.meta.url with argv[1]
// as strings isn't enough: the URL is percent-encoded and has symlinks resolved, argv[1] neither.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(moduleUrl) {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
