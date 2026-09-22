#!/usr/bin/env node
/**
 * Symbol-level reach for docs/inventory/CONTRACT.md.
 *
 * §1: "the unit of a row is a path, not a file". scripts/reach-grade.mjs
 * answers the file question and is the ceiling for this one -- a symbol cannot
 * be more reachable than the file it lives in. This answers the symbol
 * question, which is the one a row is actually filed against.
 *
 * It exists to stop two specific false rows, both of which this project has
 * already produced or nearly produced:
 *
 *   §3, the two-counts rule. `git grep SYMBOL | grep -v <defining file>`
 *   answers "is this imported". Read as "is this used" it deletes the
 *   evidence, because a symbol used where it is defined is exactly what the
 *   exclusion throws away. SEASON_ENDING_RE and RELEASED_RE were reported dead
 *   on that count alone and withdrawn. Both counts are computed here and both
 *   are always reported; there is no way to ask this module for one of them.
 *
 *   Internal use on a reached path. Five contingency.js exports had no
 *   importer and were nearly filed `dead`; they are called inside their own
 *   file, in functions production reaches. `dead` is a deletion candidate.
 *   "Exported and never imported" is a tidy-up. This module never says the
 *   first word on the second's evidence -- the grade is `internal-only` and
 *   its reason names the export keyword as the unused thing.
 *
 * Parsing is the TypeScript parser, not a regex or a brace counter. This
 * codebase is full of regex literals and a `/` cannot be told from division
 * without a real lexer; the first hand-rolled attributor also tracked only
 * `export function` and credited a private function's body to the export above
 * it. typescript is already a devDependency -- `npm run typecheck` runs it.
 *
 * Reachability in code is not reachability in data: a caller can exist whose
 * condition is never true against real rows. Nothing here runs a query, so
 * `unused-in-code` is what it says and never `dead`.
 *
 * Usage:
 *   node scripts/symbol-reach.mjs server/services/contingency.js
 *   node scripts/symbol-reach.mjs --json server/services/player-availability.js SEASON_ENDING_RE
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { gradeReach, reachableEntries, repoGraph } from './reach-grade.mjs';

const ts = createRequire(import.meta.url)('typescript');

const parse = (source, fileName) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

const isExported = node =>
  Boolean(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));

/** Every name bound at the top level of a module, with its extent and whether it is exported. */
export function declarationsOf(source, fileName = 'x.js') {
  const sf = parse(source, fileName);
  const out = [];
  const add = (name, node, exported) => {
    if (!name) return;
    out.push({ name, start: node.getStart(sf), end: node.getEnd(), exported, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };
  const bindingNames = (nameNode, node, exported) => {
    if (ts.isIdentifier(nameNode)) return add(nameNode.text, node, exported);
    if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      for (const el of nameNode.elements) {
        if (ts.isBindingElement(el)) bindingNames(el.name, node, exported);
      }
    }
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      add(stmt.name?.text, stmt, isExported(stmt));
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        bindingNames(decl.name, stmt, isExported(stmt));
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The declaration whose extent contains `offset`, innermost first, or null for
 * module scope. Containment, never "the last declaration seen above" -- that is
 * the rule the first attributor got wrong.
 */
export function enclosingDeclaration(declarations, offset) {
  let best = null;
  for (const d of declarations) {
    if (offset >= d.start && offset < d.end) {
      if (!best || d.start > best.start) best = d;
    }
  }
  return best;
}

/**
 * References to `name` inside its own file, excluding its own declaration, its
 * import and export specifiers, and `obj.name` property access. A property
 * that happens to share the name is not the binding.
 */
export function internalUses(source, fileName, name) {
  const sf = parse(source, fileName);
  const declarations = declarationsOf(source, fileName);
  const own = declarations.filter(d => d.name === name);
  const uses = [];
  const visit = node => {
    if (ts.isIdentifier(node) && node.text === name) {
      const p = node.parent;
      const skip = (ts.isPropertyAccessExpression(p) && p.name === node)
        || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)
        || ts.isExportSpecifier(p)
        || ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name === node)
        || (ts.isVariableDeclaration(p) && p.name === node)
        || (ts.isBindingElement(p) && p.name === node)
        || (ts.isPropertyAssignment(p) && p.name === node);
      const offset = node.getStart(sf);
      const insideOwnDeclaration = own.some(d => offset >= d.start && offset < d.end);
      if (!skip && !insideOwnDeclaration) {
        uses.push({
          name,
          offset,
          line: sf.getLineAndCharacterOfPosition(offset).line + 1,
          enclosing: enclosingDeclaration(declarations, offset),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

/**
 * Tests are not consumers -- CONTRACT.md says so under `decoration`, and names
 * the case: availability-basis.js has six exports, ten tests, and four exports
 * with no production consumer at all. A test importer is counted and reported,
 * and it never sets a grade. Found by running this tool against contingency.js,
 * where symbols imported only by their own test were grading as reached.
 */
export const isTestFile = f => f.startsWith('test/') || /\.test\.[cm]?[jt]sx?$/.test(f);

/**
 * Files that import `name` FROM `definingFile`.
 *
 * The specifier is resolved and compared to the defining file, so another
 * module exporting its own symbol of the same name is not counted. Name
 * collision is not reach -- several modules here define their own
 * FEATURE_NAMES and fitRidge.
 */
export function importersOfSymbol({ files, read }, definingFile, name) {
  const found = [];
  for (const file of files) {
    if (file === definingFile) continue;
    const source = read(file);
    if (typeof source !== 'string') continue;
    const sf = parse(source, file);
    const check = (specifierText, node, local, imported) => {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifierText));
      if (target !== definingFile || imported !== name) return;
      found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, alias: local === name ? null : local });
    };
    // A namespace binding reaches the symbol only if the property is actually
    // read off it. `import * as ns` binds the whole module, so treating the
    // binding alone as a reach would make every export of that file look used
    // by every importer -- over-counting as badly as missing it under-counts.
    // Collected first; the property accesses are checked in the same pass
    // below, because a use can be lexically above its own binding inside a
    // function body.
    const namespaceBindings = [];
    const propertyReads = new Set();

    const visit = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
          && node.moduleSpecifier.text.startsWith('.')) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            check(node.moduleSpecifier.text, node, el.name.text, (el.propertyName || el.name).text);
          }
        }
        // import * as ns from './defining.js'
        if (bindings && ts.isNamespaceImport(bindings)) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), node.moduleSpecifier.text));
          if (target === definingFile) {
            namespaceBindings.push({ local: bindings.name.text, node });
          }
        }
      }
      // const ns = await import('./defining.js')  -- the dynamic namespace form.
      // The destructuring form is handled below; this is the one the two
      // scheduler callers of dispatchTriggeredCapture actually use.
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let init = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
        // `await import('./x.js').catch(...)` -- the module still lands in the
        // variable, so the binding is real. Unwrap the settled-promise chain to
        // the import() underneath it.
        while (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression)
               && (init.expression.name.text === 'catch' || init.expression.name.text === 'then')) {
          init = init.expression.expression;
        }
        if (ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword
            && init.arguments[0] && ts.isStringLiteral(init.arguments[0])
            && init.arguments[0].text.startsWith('.')) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), init.arguments[0].text));
          if (target === definingFile) {
            namespaceBindings.push({ local: node.name.text, node: init });
          }
        }
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
          && node.name.text === name) {
        propertyReads.add(node.expression.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), node.arguments[0].text));
        if (target === definingFile) {
          const decl = node.parent && ts.isAwaitExpression(node.parent) ? node.parent.parent : null;
          const namedHere = decl && ts.isVariableDeclaration(decl) && ts.isObjectBindingPattern(decl.name)
            ? decl.name.elements.find(el => ((el.propertyName || el.name).getText(sf)) === name)
            : null;
          if (namedHere) {
            found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, alias: namedHere.name.getText(sf) === name ? null : namedHere.name.getText(sf) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const binding of namespaceBindings) {
      if (!propertyReads.has(binding.local)) continue;
      found.push({
        file,
        line: sf.getLineAndCharacterOfPosition(binding.node.getStart(sf)).line + 1,
        alias: null,
      });
    }
  }
  return found;
}

/**
 * Both counts, always. There is no argument that asks for one of them, because
 * the two questions are incompatible and their output looks identical (§3).
 */
export function consumerCounts({ files, read }, definingFile, name) {
  const source = read(definingFile) ?? '';
  const inside = internalUses(source, definingFile, name).length;
  const outside = importersOfSymbol({ files, read }, definingFile, name).length;
  return { withDefiningFile: inside + outside, withoutDefiningFile: outside, inside, outside };
}

/**
 * The grade for one symbol.
 *
 * The file's grade is the ceiling: a use on a path nothing reaches is not
 * evidence of life. Beneath that ceiling the symbol takes the grade of the
 * entry points ITS OWN importers reach, which can be narrower than the file's
 * -- a file wired through routes/model.js can still export a symbol only
 * betting imports, and grading that symbol by its file is exactly the
 * overstatement §1 exists to prevent.
 */
export function gradeSymbol({ name, definingFile, importers: allImporters = [], internal = [], fileGrade, importerGrades = {} }) {
  const importers = allImporters.filter(i => !isTestFile(i.file));
  const testImporters = allImporters.filter(i => isTestFile(i.file)).map(i => i.file);
  const counts = {
    withDefiningFile: importers.length + internal.length,
    withoutDefiningFile: importers.length,
    tests: testImporters.length,
  };
  const usedInside = [...new Set(internal.map(u => u.enclosing?.name).filter(Boolean))];
  const base = { name, definingFile, counts, usedInside, testImporters, importers: importers.map(i => i.file), fileGrade: fileGrade?.grade ?? null };

  if (fileGrade && (fileGrade.grade === 'unreached' || fileGrade.grade === 'indeterminate')) {
    return { ...base, grade: fileGrade.grade, reason: `the defining file is ${fileGrade.grade}, which is the ceiling for every symbol in it` };
  }

  if (importers.length) {
    const graded = importers.map(i => importerGrades[i.file]).filter(Boolean);
    const entries = [...new Set(graded.flatMap(g => g.entries || []))].sort();
    if (graded.length && graded.every(g => g.grade === 'wired-betting-only')) {
      return { ...base, entries, grade: 'wired-betting-only', reason: `every importer of ${name} is reachable only through a betting surface: ${entries.join(', ')}` };
    }
    if (graded.length && graded.every(g => g.grade === 'hand-run-script' || g.grade === 'unreached')) {
      return { ...base, entries, grade: 'hand-run-script', reason: `${name} is imported only by code that runs when a person types the command` };
    }
    return { ...base, entries, grade: 'wired', reason: `${importers.length} file(s) outside ${path.posix.basename(definingFile)} import ${name}` };
  }

  if (internal.length) {
    return {
      ...base,
      grade: 'internal-only',
      reason: `nothing imports ${name}, and it is used inside its own file in ${usedInside.join(', ') || 'module scope'}, `
        + 'on a path the file grade says is reached. The export keyword is what is unused, not the code path — '
        + 'that is a tidy-up, not a deletion candidate (CONTRACT.md §3)',
    };
  }

  return {
    ...base,
    grade: 'unused-in-code',
    reason: `nothing imports ${name} and nothing inside ${path.posix.basename(definingFile)} uses it. `
      + (testImporters.length ? `${testImporters.length} test file(s) import it, and tests are not consumers (CONTRACT.md §2 decoration). ` : '')
      + 'This is the code half only: dead-in-data needs a query against real rows and none was run here (CONTRACT.md §2)',
  };
}

/** The real repository: grade some or all exported symbols of one file. */
export function repoSymbolReport(definingFile, names = null, { cwd = process.cwd() } = {}) {
  const { files, importers: graph, isEntry, isHandRun } = repoGraph({ cwd });
  const read = f => {
    try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return null; }
  };
  const source = read(definingFile);
  if (source == null) throw new Error(`cannot read ${definingFile}`);

  const gradeFile = f => gradeReach(reachableEntries(graph, f, { isEntry }), { isHandRunScript: isHandRun });
  const fileGrade = gradeFile(definingFile);

  const wanted = names?.length
    ? names
    : [...new Set(declarationsOf(source, definingFile).filter(d => d.exported).map(d => d.name))];

  const symbols = wanted.map(name => {
    const imps = importersOfSymbol({ files, read }, definingFile, name);
    const importerGrades = Object.fromEntries(imps.map(i => [i.file, gradeFile(i.file)]));
    return gradeSymbol({
      name,
      definingFile,
      importers: imps,
      internal: internalUses(source, definingFile, name),
      fileGrade,
      importerGrades,
    });
  });
  return { file: definingFile, fileGrade: fileGrade.grade, symbols };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const [file, ...names] = argv.filter(a => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node scripts/symbol-reach.mjs [--json] <repo-relative file> [symbol ...]');
    process.exit(2);
  }
  const report = repoSymbolReport(file, names);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n### ${report.file}  (file grade: ${report.fileGrade})`);
    for (const s of report.symbols) {
      console.log(`\n  ${s.name} -> ${s.grade}`);
      console.log(`    counts: ${s.counts.withDefiningFile} with the defining file, ${s.counts.withoutDefiningFile} without`);
      if (s.usedInside.length) console.log(`    used inside: ${s.usedInside.join(', ')}`);
      if (s.importers.length) console.log(`    imported by: ${s.importers.join(', ')}`);
      console.log(`    why: ${s.reason}`);
    }
  }
}
