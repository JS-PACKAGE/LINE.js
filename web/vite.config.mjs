import { readFileSync } from "node:fs";

// The page learns which release it was built from, so it can notice when the local service it talks
// to has since been updated (see web/update.ts). package.json stays the single source of the version.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export default {
  define: { __APP_VERSION__: JSON.stringify(version) },
};
