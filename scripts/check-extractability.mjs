#!/usr/bin/env node
/* global process */
/**
 * Fail when osp-core, osp-cli, or spec/ depend on a package they could not
 * take into the standalone OpenSoul repo (ENGINEERING.md D1).
 *
 * Allowlist: @npc/osp-core imports no @npc/* ; @npc/osp-cli may import only
 * @npc/osp-core ; spec/ imports no @npc/* at all. Relative specifiers must
 * stay inside that package root (inside spec/ for spec files).
 *
 * Comments are ignored. Only static `from "..."`, `import "..."`,
 * `import("...")`, `require("...")`, and `export ... from "..."` are matched.
 * String and template contents are not code, except `${...}` interpolations.
 *
 * Usage: node scripts/check-extractability.mjs [repoRoot]
 * Prints each violation as `file:line specifier reason` and exits 1 if any.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CODE_EXT = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx"]);
const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies"];

/**
 * @typedef {{
 *   rootRel: string,
 *   walkRels: readonly string[],
 *   allowedNpc: ReadonlySet<string>,
 *   checkManifest: boolean,
 *   escapeReason: string
 * }} Scope
 */

/** @type {readonly Scope[]} */
const SCOPES = [
  {
    rootRel: "packages/osp-core",
    walkRels: ["src", "scripts", "test"],
    allowedNpc: new Set(),
    checkManifest: true,
    escapeReason: "relative import escapes package root"
  },
  {
    rootRel: "packages/osp-cli",
    walkRels: ["src", "scripts", "test"],
    allowedNpc: new Set(["@npc/osp-core"]),
    checkManifest: true,
    escapeReason: "relative import escapes package root"
  },
  {
    rootRel: "spec",
    walkRels: ["."],
    allowedNpc: new Set(),
    checkManifest: false,
    escapeReason: "relative import escapes spec/"
  }
];

/**
 * @typedef {{ source: string, i: number, line: number, n: number }} Cursor
 */

/**
 * @param {Cursor} cursor
 * @param {number} count
 */
function advance(cursor, count) {
  const end = Math.min(cursor.n, cursor.i + count);
  while (cursor.i < end) {
    if (cursor.source[cursor.i] === "\n") cursor.line += 1;
    cursor.i += 1;
  }
}

/**
 * @param {string} char
 */
function isIdentStart(char) {
  return (
    (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_" || char === "$"
  );
}

/**
 * @param {string} char
 */
function isIdentPart(char) {
  return isIdentStart(char) || (char >= "0" && char <= "9");
}

/**
 * @param {Cursor} cursor
 */
function skipLineComment(cursor) {
  advance(cursor, 2);
  while (cursor.i < cursor.n && cursor.source[cursor.i] !== "\n") advance(cursor, 1);
}

/**
 * @param {Cursor} cursor
 */
function skipBlockComment(cursor) {
  advance(cursor, 2);
  while (
    cursor.i < cursor.n &&
    !(cursor.source[cursor.i] === "*" && cursor.source[cursor.i + 1] === "/")
  ) {
    advance(cursor, 1);
  }
  if (cursor.i < cursor.n) advance(cursor, 2);
}

/**
 * @param {Cursor} cursor
 */
function skipWhitespaceAndComments(cursor) {
  while (cursor.i < cursor.n) {
    const char = cursor.source[cursor.i];
    const next = cursor.source[cursor.i + 1];
    if (char === " " || char === "\t" || char === "\r" || char === "\f") {
      advance(cursor, 1);
      continue;
    }
    if (char === "\n") {
      advance(cursor, 1);
      continue;
    }
    if (char === "/" && next === "/") {
      skipLineComment(cursor);
      continue;
    }
    if (char === "/" && next === "*") {
      skipBlockComment(cursor);
      continue;
    }
    return;
  }
}

/**
 * Read a static specifier quote after the cursor is on the opening quote.
 * Returns null (and rewinds) when the quote is not a static string.
 * @param {Cursor} cursor
 * @returns {string | null}
 */
function readQuoted(cursor) {
  const quote = cursor.source[cursor.i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const savedI = cursor.i;
  const savedLine = cursor.line;
  advance(cursor, 1);
  let value = "";
  while (cursor.i < cursor.n) {
    const char = cursor.source[cursor.i];
    if (char === "\\") {
      advance(cursor, 1);
      if (cursor.i >= cursor.n) break;
      const escaped = cursor.source[cursor.i] ?? "";
      value += escaped;
      advance(cursor, 1);
      continue;
    }
    if (quote === "`" && char === "$" && cursor.source[cursor.i + 1] === "{") {
      cursor.i = savedI;
      cursor.line = savedLine;
      return null;
    }
    if (char === quote) {
      advance(cursor, 1);
      return value;
    }
    value += char;
    advance(cursor, 1);
  }
  cursor.i = savedI;
  cursor.line = savedLine;
  return null;
}

/**
 * @param {Cursor} cursor
 * @param {string} word
 * @param {{ line: number, specifier: string }[]} found
 */
function takeSpecifier(cursor, word, found) {
  const savedI = cursor.i;
  const savedLine = cursor.line;
  skipWhitespaceAndComments(cursor);
  const specLine = cursor.line;
  if (word === "from") {
    const specifier = readQuoted(cursor);
    if (specifier !== null) found.push({ line: specLine, specifier });
    else {
      cursor.i = savedI;
      cursor.line = savedLine;
    }
    return;
  }
  if (word === "import" && cursor.source[cursor.i] === "(") {
    advance(cursor, 1);
    skipWhitespaceAndComments(cursor);
    const openLine = cursor.line;
    const specifier = readQuoted(cursor);
    if (specifier !== null) found.push({ line: openLine, specifier });
    else {
      cursor.i = savedI;
      cursor.line = savedLine;
    }
    return;
  }
  if (
    word === "import" &&
    (cursor.source[cursor.i] === '"' ||
      cursor.source[cursor.i] === "'" ||
      cursor.source[cursor.i] === "`")
  ) {
    const specifier = readQuoted(cursor);
    if (specifier !== null) found.push({ line: specLine, specifier });
    return;
  }
  if (word === "require" && cursor.source[cursor.i] === "(") {
    advance(cursor, 1);
    skipWhitespaceAndComments(cursor);
    const openLine = cursor.line;
    const specifier = readQuoted(cursor);
    if (specifier !== null) found.push({ line: openLine, specifier });
    else {
      cursor.i = savedI;
      cursor.line = savedLine;
    }
    return;
  }
  cursor.i = savedI;
  cursor.line = savedLine;
}

/**
 * Skip a string. Template `${...}` is scanned as code.
 * @param {Cursor} cursor
 * @param {string} quote
 * @param {{ line: number, specifier: string }[]} found
 */
function skipString(cursor, quote, found) {
  advance(cursor, 1);
  while (cursor.i < cursor.n) {
    const char = cursor.source[cursor.i];
    if (char === "\\") {
      advance(cursor, 1);
      if (cursor.i < cursor.n) advance(cursor, 1);
      continue;
    }
    if (quote === "`" && char === "$" && cursor.source[cursor.i + 1] === "{") {
      advance(cursor, 2);
      scanCode(cursor, found, true);
      continue;
    }
    advance(cursor, 1);
    if (char === quote) return;
  }
}

/**
 * @param {Cursor} cursor
 * @param {{ line: number, specifier: string }[]} found
 * @param {boolean} stopOnBrace
 */
function scanCode(cursor, found, stopOnBrace) {
  let depth = 0;
  while (cursor.i < cursor.n) {
    const char = cursor.source[cursor.i] ?? "";
    const next = cursor.source[cursor.i + 1] ?? "";
    if (char === "/" && next === "/") {
      skipLineComment(cursor);
      continue;
    }
    if (char === "/" && next === "*") {
      skipBlockComment(cursor);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      skipString(cursor, char, found);
      continue;
    }
    if (char === "{") {
      depth += 1;
      advance(cursor, 1);
      continue;
    }
    if (char === "}") {
      if (stopOnBrace && depth === 0) {
        advance(cursor, 1);
        return;
      }
      if (depth > 0) depth -= 1;
      advance(cursor, 1);
      continue;
    }
    if (isIdentStart(char)) {
      const start = cursor.i;
      advance(cursor, 1);
      while (cursor.i < cursor.n && isIdentPart(cursor.source[cursor.i] ?? "")) advance(cursor, 1);
      const word = cursor.source.slice(start, cursor.i);
      const before = start === 0 ? "" : (cursor.source[start - 1] ?? "");
      if (!isIdentPart(before) && (word === "from" || word === "import" || word === "require")) {
        takeSpecifier(cursor, word, found);
      }
      continue;
    }
    advance(cursor, 1);
  }
}

/**
 * Static import specifiers in source order. Comments and string literals are ignored.
 * @param {string} source
 * @returns {{ line: number, specifier: string }[]}
 */
export function findStaticSpecifiers(source) {
  /** @type {{ line: number, specifier: string }[]} */
  const found = [];
  const cursor = { source, i: 0, line: 1, n: source.length };
  scanCode(cursor, found, false);
  return found;
}

/**
 * @param {string} specifier
 * @param {ReadonlySet<string>} allowed
 */
function isAllowedNpc(specifier, allowed) {
  for (const name of allowed) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return true;
  }
  return false;
}

/**
 * @param {string} specifier
 */
function isRelativeSpecifier(specifier) {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".."
  );
}

/**
 * @param {string} file
 * @param {string} specifier
 * @param {string} boundary
 */
function escapesBoundary(file, specifier, boundary) {
  if (!isRelativeSpecifier(specifier)) return false;
  const resolved = resolve(dirname(file), specifier);
  const rel = relative(boundary, resolved);
  return rel.startsWith("..") || isAbsolute(rel);
}

/**
 * @param {string} root
 * @param {string} file
 */
function displayPath(root, file) {
  return relative(root, file).split(sep).join("/");
}

/**
 * @param {string} text
 * @param {string} section
 * @param {string} dep
 */
function lineOfDependency(text, section, dep) {
  const lines = text.split("\n");
  let inSection = false;
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!inSection) {
      if (!line.includes(`"${section}"`)) continue;
      inSection = true;
    }
    if (line.includes(`"${dep}"`)) return index + 1;
    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
    }
    if (inSection && depth <= 0 && line.includes("}")) break;
  }
  return 1;
}

/**
 * @param {string} root
 * @param {string} boundary
 * @param {string} rootRel
 * @param {ReadonlySet<string>} allowed
 * @param {string[]} violations
 */
function checkManifest(root, boundary, rootRel, allowed, violations) {
  const manifestPath = join(boundary, "package.json");
  const shown = `${rootRel}/package.json`;
  if (!existsSync(manifestPath)) {
    violations.push(`${shown}:1 (missing) missing package.json`);
    return;
  }
  const text = readFileSync(manifestPath, "utf8");
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    violations.push(`${shown}:1 (unparsed) invalid package.json`);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    violations.push(`${shown}:1 (unparsed) invalid package.json`);
    return;
  }
  for (const section of DEP_SECTIONS) {
    if (!Object.hasOwn(parsed, section)) continue;
    const value = Reflect.get(parsed, section);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      violations.push(`${shown}:1 ${section} package.json ${section} is not an object`);
      continue;
    }
    for (const dep of Object.keys(value)) {
      if (!dep.startsWith("@npc/")) continue;
      if (isAllowedNpc(dep, allowed)) continue;
      const line = lineOfDependency(text, section, dep);
      violations.push(`${shown}:${String(line)} ${dep} disallowed package.json dependency`);
    }
  }
}

/**
 * @param {string} dir
 * @param {string[]} files
 */
function walkCode(dir, files) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCode(full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (CODE_EXT.has(extname(entry.name))) files.push(full);
  }
}

/**
 * @param {string} repoRoot
 * @returns {string[]} violation lines (`file:line specifier reason`)
 */
export function checkExtractability(repoRoot) {
  const root = resolve(repoRoot);
  /** @type {string[]} */
  const violations = [];
  for (const scope of SCOPES) {
    const boundary = join(root, scope.rootRel);
    if (scope.checkManifest) {
      checkManifest(root, boundary, scope.rootRel, scope.allowedNpc, violations);
    }
    /** @type {string[]} */
    const files = [];
    for (const rel of scope.walkRels) walkCode(join(boundary, rel), files);
    for (const file of files) {
      const specs = findStaticSpecifiers(readFileSync(file, "utf8"));
      for (const spec of specs) {
        let reason = null;
        if (spec.specifier.startsWith("@npc/") && !isAllowedNpc(spec.specifier, scope.allowedNpc)) {
          reason = "disallowed @npc import";
        } else if (escapesBoundary(file, spec.specifier, boundary)) {
          reason = scope.escapeReason;
        }
        if (reason === null) continue;
        violations.push(
          `${displayPath(root, file)}:${String(spec.line)} ${spec.specifier} ${reason}`
        );
      }
    }
  }
  violations.sort();
  return violations;
}

/**
 * @returns {boolean}
 */
function runningAsCli() {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (runningAsCli()) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const requested = process.argv[2];
  const root =
    requested === undefined || requested.length === 0 ? resolve(scriptDir, "..") : requested;
  const violations = checkExtractability(root);
  for (const line of violations) process.stdout.write(`${line}\n`);
  process.exit(violations.length === 0 ? 0 : 1);
}
