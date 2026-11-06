// A rule's regular expression runs on rulematch.js, not on Firefox's engine: it must say
// the same as that engine, and do so in time that grows only with the address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../rulematch.js", import.meta.url), "utf8") + "\nthis.api = { ruleMatches, ruleProblem };", ctx);
const { ruleMatches, ruleProblem } = ctx.api;
const rx = (source, flags = "") => `/${source}/${flags}`;

test("what a rule is: text to find, or a regular expression", () => {
  assert.equal(ruleMatches("work.example", "https://work.example/x"), true);
  assert.equal(ruleMatches("work.example", "https://other.example/"), false);
  assert.equal(ruleMatches("work.example", "https://workXexample/"), false, "as text, a dot is a dot");
  assert.equal(ruleMatches("/work.example/", "https://workXexample/"), true);
  assert.equal(ruleMatches("/WORK/i", "https://work.example/"), true);
  assert.equal(ruleMatches("/WORK/", "https://work.example/"), false);
  // The one the README recommends, for a sign-in that passes through another address.
  const anchored = "/^https:\\/\\/(www\\.|m\\.)?youtube\\.com\\//";
  for (const url of ["https://youtube.com/", "https://www.youtube.com/x", "https://m.youtube.com/"]) assert.equal(ruleMatches(anchored, url), true, url);
  for (const url of ["https://accounts.youtube.com/", "http://youtube.com/", "https://notyoutube.com/"]) assert.equal(ruleMatches(anchored, url), false, url);
});

test("what cannot be a rule matches nothing: nothing typed, no text at all, and it is never an error", () => {
  for (const rule of ["", null, undefined, 7, {}, []]) {
    assert.equal(ruleMatches(rule, "https://a.example/"), false, String(rule));
    assert.equal(ruleProblem(rule), null);
  }
  for (const rule of ["/(/", "/[/", "/a{2,1}/", "/*/", "/(?<n>a)(?<n>b)/", "/a/xyz", "/a/gg"]) {
    assert.equal(ruleMatches(rule, "https://a.example/("), false, rule);
    assert.match(ruleProblem(rule), /not a valid/, rule);
  }
  assert.equal(ruleProblem("/^https:\\/\\/a/"), null);
  assert.equal(ruleProblem("plain text"), null);
});

test("what would need more than a straight pass is said, and does nothing", () => {
  for (const [rule, why] of [["/(?=a)b/", /look-around/], ["/(?!a)b/", /look-around/], ["/(?<=a)b/", /look-around/], ["/(?<!a)b/", /look-around/],
    ["/(a)\\1/", /back-reference/], ["/(?<n>a)\\k<n>/", /back-reference/], ["/\\1/", /back-reference/], ["/[\\1]/", /back-reference/]]) {
    assert.match(ruleProblem(rule), why, rule);
    assert.equal(ruleMatches(rule, "aab"), false, rule);
  }
  assert.match(ruleProblem("/\\p{L}/u"), /can't use/);
  assert.match(ruleProblem("/[a--b]/v"), /can't use/);
  assert.match(ruleProblem("/(a{1000}){1000}/"), /too big/);
});

// Each expression, on each address, against Firefox's own engine (node's is the same family).
const SAME = [
  "a", "abc", "a|b", "ab|cd", "(a|b)c", "(?:a|b)c", "(?<name>a)c", "a*", "a+", "a?", "a*b", "a+b", "a?b", "a{2}", "a{2,}", "a{1,2}", "a{0}", "a{0,1}", "(ab){2}", "(ab){2,3}c",
  "a*?b", "a+?b", "a??b", "a{1,2}?b", "^a", "a$", "^a$", "^$", "^", "$", "^(a|b)$", "(^a|b$)", "a|", "|a", "()", "(|a)b", "(a|)b", "(a*)*", "(a*)+b", "(a|b)*c", "(a+)+b", "(a|a)*b",
  ".", "a.c", ".*", ".+b", "^.*$", "[abc]", "[^abc]", "[a-c]", "[^a-c]", "[a-]", "[-a]", "[]", "[^]", "[a-cx-z]", "[\\d]", "[\\D]", "[\\w-]", "[\\d-a]", "[a-\\d]", "[\\]]", "[\\\\]", "[.]",
  "\\d", "\\D", "\\w", "\\W", "\\s", "\\S", "\\d+", "\\w+\\.", "\\.", "\\/", "\\-", "\\a", "\\x41", "\\u0041", "\\x4", "\\u41", "\\t", "\\n", "\\0",
  "\\bfoo", "foo\\b", "\\bfoo\\b", "\\Boo", "fo\\B", "[\\b]", "a{", "a{x}", "a{1", "a{,2}", "{", "}", "]", "a]", "x{1,}y", "(a(b(c)))", "((a|b)|c)d", "(a|b|c|d)+e",
  "^https?:\\/\\/", "^https:\\/\\/(www\\.|m\\.)?youtube\\.com\\/", "^https:\\/\\/([a-z0-9-]+\\.)*example\\.com\\/", "\\.example\\.(com|org)(\\/|$)", "[?&]id=\\d+", "^https?://[^/]+/admin", "/a/b/", "%20", "foo.*bar.*baz",
];
const ADDRESSES = [
  "", "a", "b", "c", "ab", "ac", "bc", "abc", "aa", "aaa", "aab", "abab", "ababc", "cd", "aaaaab", "acbc", "foo", "foobar", "a foo b", "oo", "xfoox", "fo", "A", "AB", "ABC", "Abc", "x y", "a\tb", "a\nb",
  "-", "]", "{", "}", "a{", "a{x}", "a{1", "a{,2}", "\\", ".", "/", "a.c", "a-c", "1", "12", "x1", "a]", "xy", "xxy", "\b", "\0",
  "https://youtube.com/", "https://www.youtube.com/x", "https://m.youtube.com/", "https://accounts.youtube.com/", "http://a.example.com/x", "https://a.b-c.example.com/", "https://example.com/", "https://example.org", "https://x.example.org/a?id=12&b=3",
  "https://x/admin", "https://x/y/admin", "foo bar baz", "foobaz", "/a/b/", "x%20y",
];

test("it says the same as Firefox's own engine", () => {
  for (const source of SAME) for (const flags of ["", "i", "s", "m", "y", "g", "is", "iy"]) {
    for (const url of ADDRESSES) {
      const rule = rx(source, flags);
      assert.equal(ruleProblem(rule), null, rule);
      assert.equal(ruleMatches(rule, url), new RegExp(source, flags).test(url), `${rule} on ${JSON.stringify(url)}`);
    }
  }
});

test("also on expressions nobody thought of: the same answers on thousands of random ones", () => {
  // Small expressions over few characters, so that they do match something, with a fixed
  // seed, so that a failure shows again. Short addresses keep the old engine quick too.
  let seed = 20261107;
  const rand = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const pick = list => list[rand(list.length)];
  const atom = depth => {
    const r = rand(depth > 2 ? 6 : 9);
    if (r < 3) return pick(["a", "b", "c", "-", "\\.", "/"]);
    if (r === 3) return pick([".", "\\d", "\\w", "\\W", "\\b", "\\B", "^", "$"]);
    if (r === 4) return pick(["[ab]", "[^ab]", "[a-c]", "[-a]", "[\\d-]", "[^\\w]"]);
    if (r === 5) return pick(["1", "A", "x"]);
    if (r === 6) return `(${alt(depth + 1)})`;
    if (r === 7) return `(?:${alt(depth + 1)})`;
    return `(?:${alt(depth + 1)}|${alt(depth + 1)})`;
  };
  const piece = depth => {
    const a = atom(depth);
    if (["^", "$", "\\b", "\\B"].includes(a)) return a; // a quantifier on these isn't valid
    return a + pick(["", "", "", "*", "+", "?", "{2}", "{1,2}", "{0,1}", "{2,}", "*?", "+?", "??"]);
  };
  const seq = depth => Array.from({ length: rand(3) + 1 }, () => piece(depth)).join("");
  const alt = depth => (rand(4) === 0 ? `${seq(depth)}|${seq(depth)}` : seq(depth));
  const chars = "aabbc-./1Ax ";
  const text = () => Array.from({ length: rand(9) }, () => chars[rand(chars.length)]).join("");
  let compared = 0;
  for (let i = 0; i < 4000; i++) {
    const source = alt(0), flags = pick(["", "", "i", "y"]);
    let re;
    try { re = new RegExp(source, flags); } catch { continue; }
    assert.equal(ruleProblem(rx(source, flags)), null, rx(source, flags));
    for (let j = 0; j < 12; j++) {
      const url = text();
      assert.equal(ruleMatches(rx(source, flags), url), re.test(url), `${rx(source, flags)} on ${JSON.stringify(url)}`);
      re.lastIndex = 0;
      compared++;
    }
  }
  assert.ok(compared > 20000, `${compared} compared`);
});

test("it takes no longer than the address is long, whatever the expression", () => {
  const evil = [
    "(a+)+$", "(a|a)*x", "(a|aa)+$", "(.*)*z", "(.*)*(.*)*(.*)*z", "((a*)*)*$", "(a*)*(a*)*(a*)*(a*)*b", "a.*.*.*.*.*.*.*.*.*.*.*.*q", "(x+x+)+y", "^(([a-z])+.)+[A-Z]([a-z])+$",
    "(a?){40}a{40}", "(.+)+(.+)+(.+)+!z", "(a|b|c|d|e|f|g)*h",
  ];
  for (const source of evil) {
    for (const address of ["a".repeat(40) + "!", "a".repeat(5000) + "!", "https://evil.example/" + "ab".repeat(2000)]) {
      const t0 = performance.now();
      ruleMatches(rx(source), address);
      const ms = performance.now() - t0;
      assert.ok(ms < 300, `${source} on ${address.length} characters took ${Math.round(ms)} ms`);
    }
  }
});

test("a very long address is only read as far as it matters", () => {
  const long = "https://a.example/?" + "q".repeat(1e6);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) ruleMatches("/(q|x)*zz/", long);
  assert.ok(performance.now() - t0 < 500);
  assert.equal(ruleMatches("/^https:\\/\\/a\\.example/", long), true);
  assert.equal(ruleMatches("/q$/", long.slice(0, 5000)), false, "where it stops reading is not the address's end");
  assert.equal(ruleMatches("/q$/", long.slice(0, 4000)), true);
});

test("the g and y flags keep no state between navigations", () => {
  for (let i = 0; i < 4; i++) {
    assert.equal(ruleMatches("/work/g", "https://work.example/"), true);
    assert.equal(ruleMatches("/work/y", "work.example"), true);
    assert.equal(ruleMatches("/work/y", "https://work.example/"), false);
  }
});

test("an expression is read once, and many edited ones don't pile up", () => {
  for (let i = 0; i < 2000; i++) assert.equal(ruleMatches(`/^x${i}/`, `x${i}`), true);
  assert.equal(ruleMatches("/^x1999/", "x1999"), true);
});
