/**
 * Static runtime import specifiers for the browser-entry graph walk.
 *
 * Type-only imports are omitted. `import()` and `require()` count when the
 * specifier is a string or a template literal with no substitutions
 * (`` import(`node:fs`) ``). A template that contains `${...}` is not static;
 * the runner's resolve hook is the backstop for that form.
 */
import ts from "typescript";

/** Module specifier text, or null when the declaration has none. */
function specifierText(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  const specifier = node.moduleSpecifier;
  if (specifier === undefined || !ts.isStringLiteral(specifier)) {
    return null;
  }
  return specifier.text;
}

/** True for `import type` / `export type` and named lists that are all `type`. */
function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause === undefined) {
      return false;
    }
    if (clause.isTypeOnly || clause.name !== undefined) {
      return clause.isTypeOnly;
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      return true;
    }
    if (ts.isNamespaceImport(bindings)) {
      return false;
    }
    return bindings.elements.every((element) => element.isTypeOnly);
  }
  if (node.isTypeOnly) {
    return true;
  }
  if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

/**
 * Text of a string literal or a template literal with no substitutions.
 * Interpolated templates return null so the walker does not invent a specifier.
 */
function staticCallSpecifier(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

/**
 * Record a static `import("...")` / `import(\`...\`)` or `require` of the same forms.
 */
function pushLiteral(specifiers: string[], node: ts.Node): void {
  if (!ts.isCallExpression(node)) {
    return;
  }
  const first = node.arguments[0];
  if (first === undefined) {
    return;
  }
  const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
  if (!dynamic && !required) {
    return;
  }
  const text = staticCallSpecifier(first);
  if (text !== null) {
    specifiers.push(text);
  }
}

/**
 * Runtime specifiers in source order. Type-only imports are not reachable in the bundle.
 */
export function runtimeSpecifiers(fileName: string, source: string): string[] {
  const scriptKind = fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !isTypeOnly(node)) {
      const specifier = specifierText(node);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }
    pushLiteral(specifiers, node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}
