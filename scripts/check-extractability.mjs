#!/usr/bin/env node
/* global process */
/**
 * Extraction boundary for osp-core, osp-cli, and spec/ (ENGINEERING.md D1).
 * osp-core: no @npc/*. osp-cli: only @npc/osp-core. spec/: no @npc/*.
 * Relative, absolute, and file: specifiers must stay inside that root.
 * A package.json value that is a bare path (`../pkg`, `/abs`) is checked like file:.
 * Comments, strings, and regex literals are not code, except template `${...}`.
 * A JSX closing tag (`</div>`, `</>`) is not a regex.
 * Unterminated string, template, block comment, or regex fails closed.
 * .md and .json are not scanned. Also missed: `${}` specifiers, symlinks,
 * package-root config, JSDoc import(), and workspace:* on a non-@npc key.
 * Known limit: after ), a braceless if whose condition is a regex, or a regex in statement position, is read as division and can hide a following import.
 * Known limit: require.resolve, import.meta.resolve, and vi.mock strings that name an @npc package are not detected.
 * Known limit: division after a keyword-named property (x.return / 2) or a TypeScript non-null assertion (count! / total) can fail closed as an unterminated regex.
 * Usage: node scripts/check-extractability.mjs [repoRoot]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const CODE_EXT = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]);
const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];
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
const REGEX_WORD = new Set(
  "return typeof instanceof in of new delete void throw case do else yield await".split(" ")
);
const REGEX_END = "(,=:[!&|?{};+-*%<>~^";
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
function fail(cursor, kind, line) {
  cursor.bad = { kind, line };
}
function canStartRegex(prev) {
  if (prev === "++" || prev === "--") return false;
  if (prev === "" || REGEX_WORD.has(prev)) return true;
  return prev.length === 1 && REGEX_END.includes(prev);
}
function skipLineComment(cursor) {
  advance(cursor, 2);
  while (cursor.i < cursor.n && cursor.source[cursor.i] !== "\n") advance(cursor, 1);
}
function skipBlockComment(cursor) {
  const startLine = cursor.line;
  advance(cursor, 2);
  while (
    cursor.i < cursor.n &&
    !(cursor.source[cursor.i] === "*" && cursor.source[cursor.i + 1] === "/")
  ) {
    advance(cursor, 1);
  }
  if (cursor.i >= cursor.n) fail(cursor, "block comment", startLine);
  else advance(cursor, 2);
}
function skipWhitespaceAndComments(cursor) {
  while (cursor.i < cursor.n && cursor.bad === null) {
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
function takeSpecifier(cursor, word, found) {
  const savedI = cursor.i;
  const savedLine = cursor.line;
  skipWhitespaceAndComments(cursor);
  let specLine = cursor.line;
  let char = cursor.source[cursor.i];
  const call = (word === "import" || word === "require") && char === "(";
  if (call) {
    advance(cursor, 1);
    skipWhitespaceAndComments(cursor);
    specLine = cursor.line;
    char = cursor.source[cursor.i];
  }
  const quoted =
    call ||
    word === "from" ||
    (word === "import" && (char === '"' || char === "'" || char === "`"));
  const specifier = quoted && cursor.bad === null ? readQuoted(cursor) : null;
  if (specifier !== null) {
    found.push({ line: specLine, specifier });
    return true;
  }
  cursor.i = savedI;
  cursor.line = savedLine;
  return false;
}
function skipString(cursor, quote, found) {
  const startLine = cursor.line;
  const kind = quote === "`" ? "template" : "string";
  advance(cursor, 1);
  while (cursor.i < cursor.n) {
    const char = cursor.source[cursor.i] ?? "";
    if (char === "\\") {
      advance(cursor, 2);
      continue;
    }
    if (kind === "string" && (char === "\n" || char === "\r")) {
      fail(cursor, "string", startLine);
      return;
    }
    if (quote === "`" && char === "$" && cursor.source[cursor.i + 1] === "{") {
      advance(cursor, 2);
      scanCode(cursor, found, true);
      if (cursor.bad !== null) return;
      continue;
    }
    advance(cursor, 1);
    if (char === quote) return;
  }
  fail(cursor, kind, startLine);
}
function skipRegex(cursor) {
  const startLine = cursor.line;
  advance(cursor, 1);
  let inClass = false;
  while (cursor.i < cursor.n) {
    const char = cursor.source[cursor.i] ?? "";
    const escaped = char === "\\" ? cursor.source[cursor.i + 1] : undefined;
    if (
      char === "\n" ||
      char === "\r" ||
      escaped === "\n" ||
      escaped === "\r" ||
      (char === "\\" && escaped === undefined)
    )
      break;
    if (escaped !== undefined) {
      advance(cursor, 2);
      continue;
    }
    if (char === "[" && !inClass) inClass = true;
    else if (char === "]" && inClass) inClass = false;
    else if (char === "/" && !inClass) {
      advance(cursor, 1);
      while (/[A-Za-z]/.test(cursor.source[cursor.i] ?? "")) advance(cursor, 1);
      return;
    }
    advance(cursor, 1);
  }
  fail(cursor, "regex", startLine);
}
function isJsxSpace(char) {
  return char === " " || char === "\t" || char === "\r" || char === "\n" || char === "\f";
}
/**
 * When the cursor is on `/` after `<`, consume a JSX closing tag (`</div>`, `</>`).
 * Returns false without moving when the `/` is a regex (`a < /b/`).
 */
function skipJsxClosingTag(cursor) {
  if (cursor.source[cursor.i] !== "/") return false;
  const savedI = cursor.i;
  const savedLine = cursor.line;
  advance(cursor, 1);
  while (isJsxSpace(cursor.source[cursor.i] ?? "")) advance(cursor, 1);
  if ((cursor.source[cursor.i] ?? "") !== ">") {
    if (!isIdentStart(cursor.source[cursor.i] ?? "")) {
      cursor.i = savedI;
      cursor.line = savedLine;
      return false;
    }
    advance(cursor, 1);
    while (cursor.i < cursor.n) {
      const char = cursor.source[cursor.i] ?? "";
      if (isIdentPart(char) || char === "-") {
        advance(cursor, 1);
        continue;
      }
      if (char === "." || char === ":") {
        advance(cursor, 1);
        if (!isIdentStart(cursor.source[cursor.i] ?? "")) {
          cursor.i = savedI;
          cursor.line = savedLine;
          return false;
        }
        advance(cursor, 1);
        continue;
      }
      break;
    }
    while (isJsxSpace(cursor.source[cursor.i] ?? "")) advance(cursor, 1);
    if ((cursor.source[cursor.i] ?? "") !== ">") {
      cursor.i = savedI;
      cursor.line = savedLine;
      return false;
    }
  }
  advance(cursor, 1);
  return true;
}
function takeTripleSlash(cursor, found) {
  let end = cursor.i;
  while (end < cursor.n && cursor.source[end] !== "\n") end += 1;
  const match = /^\/\/\/\s*<reference\s+(?:types|path)\s*=\s*(["'])([^"']+)\1/.exec(
    cursor.source.slice(cursor.i, end)
  );
  if (match !== null && match[2] !== undefined)
    found.push({ line: cursor.line, specifier: match[2] });
}
function scanCode(cursor, found, stopOnBrace) {
  let depth = 0;
  let prev = "";
  while (cursor.i < cursor.n && cursor.bad === null) {
    const char = cursor.source[cursor.i] ?? "";
    const next = cursor.source[cursor.i + 1] ?? "";
    if (char === " " || char === "\t" || char === "\r" || char === "\f" || char === "\n") {
      advance(cursor, 1);
      continue;
    }
    if (char === "/") {
      if (next === "/") {
        takeTripleSlash(cursor, found);
        skipLineComment(cursor);
        continue;
      }
      if (next === "*") {
        skipBlockComment(cursor);
        continue;
      }
      if (canStartRegex(prev)) {
        if (prev === "<" && skipJsxClosingTag(cursor)) {
          prev = ">";
          continue;
        }
        skipRegex(cursor);
        prev = "re";
        continue;
      }
      prev = "/";
      advance(cursor, 1);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      skipString(cursor, char, found);
      prev = "str";
      continue;
    }
    if (char === "{") {
      depth += 1;
      prev = "{";
      advance(cursor, 1);
      continue;
    }
    if (char === "}") {
      if (stopOnBrace && depth === 0) {
        advance(cursor, 1);
        return;
      }
      if (depth > 0) depth -= 1;
      prev = "}";
      advance(cursor, 1);
      continue;
    }
    if (isIdentStart(char)) {
      const start = cursor.i;
      advance(cursor, 1);
      while (cursor.i < cursor.n && isIdentPart(cursor.source[cursor.i] ?? "")) advance(cursor, 1);
      const word = cursor.source.slice(start, cursor.i);
      const before = start === 0 ? "" : (cursor.source[start - 1] ?? "");
      const boundary = !isIdentPart(before);
      if (boundary && (word === "from" || word === "import" || word === "require")) {
        prev = takeSpecifier(cursor, word, found) ? "str" : word;
        continue;
      }
      if (boundary && word === "module" && prev === "declare") {
        const savedI = cursor.i;
        const savedLine = cursor.line;
        skipWhitespaceAndComments(cursor);
        const specLine = cursor.line;
        const specifier = cursor.bad === null ? readQuoted(cursor) : null;
        if (specifier !== null) {
          found.push({ line: specLine, specifier });
          prev = "str";
        } else {
          cursor.i = savedI;
          cursor.line = savedLine;
          prev = word;
        }
        continue;
      }
      prev = word;
      continue;
    }
    if ((char === "+" || char === "-") && next === char) {
      prev = char + char;
      advance(cursor, 2);
      continue;
    }
    prev = char;
    advance(cursor, 1);
  }
}
function scanSource(source) {
  /** @type {{ line: number, specifier: string }[]} */
  const found = [];
  const cursor = { source, i: 0, line: 1, n: source.length, bad: null };
  scanCode(cursor, found, false);
  return { found, bad: cursor.bad };
}
function isAllowedNpc(specifier, allowed) {
  for (const name of allowed) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return true;
  }
  return false;
}
function escapesBoundary(file, specifier, boundary) {
  let target = null;
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".."
  ) {
    target = resolve(dirname(file), specifier);
  } else if (specifier.startsWith("/")) target = resolve(specifier);
  else if (specifier.startsWith("file:")) {
    if (specifier.startsWith("file://")) {
      try {
        target = fileURLToPath(specifier);
      } catch {
        target = resolve(specifier.slice("file://".length));
      }
    } else {
      const rest = specifier.slice("file:".length);
      target = rest.startsWith("/") ? resolve(rest) : resolve(dirname(file), rest);
    }
  }
  if (target === null) return false;
  const rel = relative(boundary, target);
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
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (inSection && depth <= 0 && line.includes("}")) break;
  }
  return 1;
}
function pathEscapesBoundary(spec, boundary) {
  const target = spec.startsWith("/") ? resolve(spec) : resolve(boundary, spec);
  const rel = relative(boundary, target);
  return rel.startsWith("..") || isAbsolute(rel);
}
function bareDepPath(version) {
  if (
    version.startsWith("./") ||
    version.startsWith("../") ||
    version === "." ||
    version === ".." ||
    version.startsWith("/")
  ) {
    return version;
  }
  return null;
}
function depEscapes(version, boundary) {
  const bare = bareDepPath(version);
  if (bare !== null) return pathEscapesBoundary(bare, boundary);
  const cut = version.indexOf(":");
  if (cut < 1) return false;
  const scheme = version.slice(0, cut);
  if (scheme !== "file" && scheme !== "link" && scheme !== "workspace") return false;
  const spec = version.slice(cut + 1);
  if (scheme === "workspace" && !spec.startsWith(".") && !spec.startsWith("/")) return false;
  return pathEscapesBoundary(spec, boundary);
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
      const version = Reflect.get(value, dep);
      const versionText = typeof version === "string" ? version : "";
      const named = /@npc\/[A-Za-z0-9._-]+/.exec(versionText);
      const namedPkg = named === null ? null : (named[0] ?? null);
      let specifier = null;
      if (dep.startsWith("@npc/") && !isAllowedNpc(dep, allowed)) specifier = dep;
      else if (namedPkg !== null && !isAllowedNpc(namedPkg, allowed)) specifier = namedPkg;
      else if (depEscapes(versionText, boundary)) specifier = versionText;
      if (specifier === null) continue;
      violations.push(
        `${shown}:${String(lineOfDependency(text, section, dep))} ${specifier} disallowed package.json dependency`
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
/** @param {string} repoRoot @returns {string[]} `file:line specifier reason` */
export function checkExtractability(repoRoot) {
  const root = resolve(repoRoot);
  /** @type {string[]} */
  const violations = [];
  for (const scope of SCOPES) {
    const boundary = join(root, scope.rootRel);
    if (scope.checkManifest) checkManifest(boundary, scope.rootRel, scope.allowedNpc, violations);
    /** @type {string[]} */
    const files = [];
    for (const rel of scope.walkRels) walkCode(join(boundary, rel), files);
    for (const file of files) {
      const scanned = scanSource(readFileSync(file, "utf8"));
      if (scanned.bad !== null) {
        violations.push(
          `${displayPath(root, file)}:${String(scanned.bad.line)} - unterminated ${scanned.bad.kind}; cannot verify imports`
        );
      }
      for (const spec of scanned.found) {
        let reason = null;
        if (spec.specifier.startsWith("@npc/") && !isAllowedNpc(spec.specifier, scope.allowedNpc)) {
          reason = "disallowed @npc import";
        } else if (escapesBoundary(file, spec.specifier, boundary)) reason = scope.escapeReason;
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
