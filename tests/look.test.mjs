// What can be checked of the look without a Firefox: that every page shares one set of
// names, keeps the names other work builds on, and loads nothing from outside. How it
// looks is for tools/shoot.py and a person's eyes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const PAGES = ["sidebar/sidebar.html", "settings/settings.html"];
const STYLES = ["sidebar/tokens.css", "sidebar/sidebar.css", "settings/settings.css"];

test("every page links the design's names before its own styles", () => {
  for (const page of PAGES) {
    const links = [...read(page).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
    assert.ok(links[0]?.endsWith("tokens.css"), `${page} starts with ${links[0]}`);
  }
});

test("the names other work builds on are in tokens.css", () => {
  const tokens = read("sidebar/tokens.css");
  for (const name of ["--text", "--muted", "--faint", "--hover", "--selected", "--tile", "--accent", "--radius", "--row", "--frame", "--raised"]) {
    assert.match(tokens, new RegExp(`^\\s*${name}:`, "m"), name);
  }
});

test("nothing is loaded from outside: no web fonts, no addresses, no imports", () => {
  for (const file of [...STYLES, ...PAGES]) {
    // An SVG's own namespace is a name, not something loaded.
    const text = read(file).replaceAll("http://www.w3.org/2000/svg", "");
    assert.doesNotMatch(text, /https?:\/\/|@font-face|@import/, file);
    assert.doesNotMatch(text, /url\((?!["']?data:)/, file);
  }
});

test("what moves stops for those who ask for no motion", () => {
  assert.match(read("sidebar/tokens.css"), /prefers-reduced-motion: reduce[^}]*transition: none !important; animation: none !important;/);
});

test("the surface stays a plain :root name, which the owner's tidier.css overrides per space", () => {
  assert.match(read("sidebar/tokens.css"), /:root \{[^}]*--frame: light-dark\(#ececf0, #1f1f23\);/s);
  assert.match(read("sidebar/sidebar.css"), /html \{ background: var\(--frame\);/);
});
