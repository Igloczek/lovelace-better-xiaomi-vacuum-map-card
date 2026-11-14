// Stamps the package version into the production bundle in place of the source placeholder.
import { readFileSync, writeFileSync } from "node:fs";

const file = "dist/xiaomi-vacuum-map-card.js";
const placeholder = "@VACUUM_MAP_CARD_VERSION_PLACEHOLDER@";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const bundle = readFileSync(file, "utf8");

if (!bundle.includes(placeholder)) {
    console.error(`${file} has no ${placeholder} to replace.`);
    process.exit(1);
}
writeFileSync(file, bundle.replaceAll(placeholder, version));
console.log(`${file}: version ${version}`);
