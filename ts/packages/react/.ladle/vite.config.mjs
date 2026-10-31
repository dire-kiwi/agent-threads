import { fileURLToPath } from "node:url";

// The stories read the fixtures from spec/, outside the package.
export default {
  server: { fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } },
};
