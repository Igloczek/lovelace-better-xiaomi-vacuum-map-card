import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { localize } from "../src/localize/localize";

const LANGUAGES_DIR = join(__dirname, "../src/localize/languages");
const languageFiles = readdirSync(LANGUAGES_DIR).filter(file => file.endsWith(".json"));

describe("translations", () => {
    // `lv.json` shipped for years without being registered, so Latvian users silently got English.
    it.each(languageFiles)("%s is registered and used for its language", file => {
        const lang = file.replace(/\.json$/, "");
        const translations = JSON.parse(readFileSync(join(LANGUAGES_DIR, file), "utf8"));

        expect(localize("common.version", lang)).toBe(translations.common.version);
        expect(localize("common.description", lang)).toBe(translations.common.description);
    });
});
