// Hard-constraint grep guard: the build FAILS if any
// browser/webview/RSS/incognito surface reappears in src/.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const BANNED = /(webview|BrowserView|<iframe|incognito|rss[-_ ]?feed|paywall)/i;
const dir = fileURLToPath(new URL("./src", import.meta.url));
let bad = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
  const lines = readFileSync(join(dir, f), "utf8").split("\n");
  lines.forEach((l, i) => {
    if (BANNED.test(l)) {
      console.error(`GUARD: banned surface in ${f}:${i + 1}: ${l.trim()}`);
      bad++;
    }
  });
}
if (bad) {
  console.error(`GUARD FAILED — ${bad} banned line(s). The browser does not come back.`);
  process.exit(1);
}
console.log("guard: clean (no browser/webview/RSS surfaces in src/)");
