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

function advance(cursor, count) {
  const end = Math.min(cursor.n, cursor.i + count);
  while (cursor.i < end) {
    if (cursor.source[cursor.i] === "\n") cursor.line += 1;
    cursor.i += 1;
  }
}

function isIdentStart(char) {
  return (
    (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_" || char === "$"
  );
}

function isIdentPart(char) {
  return isIdentStart(char) || (char >= "0" && char <= "9");
}

function skipLineComment(cursor) {
  advance(cursor, 2);
  while (cursor.i < cursor.n && cursor.source[cursor.i] !== "\n") advance(cursor, 1);
}

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

function skipWhitespaceAndComments(cursor) {
  while (cursor.i < cursor.n) {
    const char = cursor.source[cursor.i];
    const next = cursor.source[cursor.i + 1];
    if (char === " " || char === "\t" || char === "\r" || char === "\f" || char === "\n") {
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
      value += cursor.source[cursor.i] ?? "";
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

function takeCallSpecifier(cursor, found, savedI, savedLine) {
  advance(cursor, 1);
  skipWhitespaceAndComments(cursor);
  const openLine = cursor.line;
  const specifier = readQuoted(cursor);
  if (specifier !== null) found.push({ line: openLine, specifier });
  else {
    cursor.i = savedI;
    cursor.line = savedLine;
  }
}

function takeSpecifier(cursor, word, found) {
  const savedI = cursor.i;
  const savedLine = cursor.line;
  skipWhitespaceAndComments(cursor);
  const specLine = cursor.line;
  const char = cursor.source[cursor.i];
  if (word === "from" || (word === "import" && (char === '"' || char === "'" || char === "`"))) {
    const specifier = readQuoted(cursor);
    if (specifier !== null) found.push({ line: specLine, specifier });
    else {
      cursor.i = savedI;
      cursor.line = savedLine;
    }
    return;
  }
  if ((word === "import" || word === "require") && char === "(") {
    takeCallSpecifier(cursor, found, savedI, savedLine);
    return;
  }
  cursor.i = savedI;
  cursor.line = savedLine;
}

/** Skip a string. Template `${...}` is scanned as code. */
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
  scanCode({ source, i: 0, line: 1, n: source.length }, found, false);
  return found;
}

function isAllowedNpc(specifier, allowed) {
  for (const name of allowed) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return true;
  }
  return false;
}

function isRelativeSpecifier(specifier) {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".."
  );
}

function escapesBoundary(file, specifier, boundary) {
  if (!isRelativeSpecifier(specifier)) return false;
  const rel = relative(boundary, resolve(dirname(file), specifier));
  return rel.startsWith("..") || isAbsolute(rel);
}

function displayPath(root, file) {
  return relative(root, file).split(sep).join("/");
}

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

function checkManifest(boundary, rootRel, allowed, violations) {
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
      if (!dep.startsWith("@npc/") || isAllowedNpc(dep, allowed)) continue;
      violations.push(
        `${shown}:${String(lineOfDependency(text, section, dep))} ${dep} disallowed package.json dependency`
      );
    }
  }
}

function walkCode(dir, files) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkCode(full, files);
    else if (entry.isFile() && CODE_EXT.has(extname(entry.name))) files.push(full);
  }
}

/**
 * Scan `repoRoot` for OpenSoul extraction-boundary violations.
 * @param {string} repoRoot
 * @returns {string[]} lines of `file:line specifier reason`
 */
export function checkExtractability(repoRoot) {
  const root = resolve(repoRoot);
  /** @type {string[]} */
  const violations = [];
  for (const scope of SCOPES) {
    const boundary = join(root, scope.rootRel);
    if (scope.checkManifest) {
      checkManifest(boundary, scope.rootRel, scope.allowedNpc, violations);
    }
    /** @type {string[]} */
    const files = [];
    for (const rel of scope.walkRels) walkCode(join(boundary, rel), files);
    for (const file of files) {
      for (const spec of findStaticSpecifiers(readFileSync(file, "utf8"))) {
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

const entry = process.argv[1];
const runningAsCli =
  entry !== undefined && entry.length > 0 && import.meta.url === pathToFileURL(resolve(entry)).href;

if (runningAsCli) {
  const requested = process.argv[2];
  const root =
    requested === undefined || requested.length === 0
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : requested;
  const violations = checkExtractability(root);
  for (const line of violations) process.stdout.write(`${line}\n`);
  process.exit(violations.length === 0 ? 0 : 1);
}
