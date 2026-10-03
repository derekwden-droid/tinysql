import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Builds the generated half of the Claude Code plugin in `plugin/`.
 *
 * A plugin ships only its own folder, with no build step at install time, so
 * the MCP server has to be committed as JavaScript. Each TypeScript module the
 * server imports at runtime becomes one `.mjs` file, transpiled one-to-one
 * with its comments kept. No bundler and no minifier: the directory's reviewers
 * read the shipped files, and these read like `src/`.
 *
 *   npm run build:plugin    rewrites plugin/server/, plugin/examples/ and plugin/LICENSE
 *
 * `tests/plugin.test.ts` compares this function's output with the committed
 * files, so a change to the engine that skips the rebuild fails the tests.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/mcp/server.ts";
export const GENERATED_DIRS = ["plugin/server", "plugin/examples"];
const EXAMPLES = ["employees.csv", "departments.csv", "orders.csv"];

/** Every generated file, keyed by its repository-relative path with "/" separators, with LF line endings. */
export function renderPlugin(): Map<string, string> {
  const files = new Map<string, string>();

  // Walk the runtime import graph from the entry point. The walk reads each
  // module's transpiled output, so type-only imports never pull a file in.
  const queue = [ENTRY];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const source = queue.shift()!;
    if (seen.has(source)) continue;
    seen.add(source);

    const js = transpile(source, readFileSync(join(ROOT, source), "utf8"));
    files.set(`plugin/server/${source.replace(/^src\//, "").replace(/\.ts$/, ".mjs")}`, js);

    for (const { fileName } of ts.preProcessFile(js, true, true).importedFiles) {
      if (!fileName.startsWith(".")) continue; // node: built-ins
      queue.push(posix.join(posix.dirname(source), fileName.replace(/\.mjs$/, ".ts")));
    }
  }

  // The bundled sample data, so the plugin can demo itself without the user's files.
  for (const name of EXAMPLES) {
    files.set(`plugin/examples/${name}`, lf(readFileSync(join(ROOT, "public/datasets", name), "utf8")));
  }
  // Installs receive only the plugin folder, and the MIT terms travel with every copy.
  files.set("plugin/LICENSE", lf(readFileSync(join(ROOT, "LICENSE"), "utf8")));
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

function transpile(source: string, text: string): string {
  const output = ts.transpileModule(text, {
    fileName: source,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
    transformers: { after: [rewriteSpecifiers] },
  });
  const header =
    `// Generated from ${source} by scripts/build-plugin.ts. Do not edit:\n` +
    "// change the TypeScript source and run `npm run build:plugin`.\n";
  return lf(header + output.outputText);
}

/** `./catalog.js` -> `./catalog.mjs`: the plugin has no package.json, so ESM needs the .mjs extension. */
const rewriteSpecifiers: ts.TransformerFactory<ts.SourceFile> = (context) => (file) => {
  const { factory } = context;
  const rewrite = (specifier: ts.Expression | undefined): ts.Expression | undefined =>
    specifier !== undefined && ts.isStringLiteral(specifier) && /^\.\.?\/.*\.js$/.test(specifier.text)
      ? factory.createStringLiteral(specifier.text.replace(/\.js$/, ".mjs"))
      : specifier;

  const statements = file.statements.map((statement) => {
    if (ts.isImportDeclaration(statement)) {
      return factory.updateImportDeclaration(
        statement,
        statement.modifiers,
        statement.importClause,
        rewrite(statement.moduleSpecifier)!,
        statement.attributes,
      );
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      return factory.updateExportDeclaration(
        statement,
        statement.modifiers,
        statement.isTypeOnly,
        statement.exportClause,
        rewrite(statement.moduleSpecifier),
        statement.attributes,
      );
    }
    return statement;
  });
  return factory.updateSourceFile(file, statements);
};

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function writePlugin(): string[] {
  for (const dir of GENERATED_DIRS) rmSync(join(ROOT, dir), { recursive: true, force: true });
  const written: string[] = [];
  for (const [path, content] of renderPlugin()) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), content);
    written.push(path);
  }
  return written;
}

if (process.argv.includes("--write")) {
  for (const path of writePlugin()) console.log(path);
}
