/**
 * Loads client/src/components/warroom/* for a node:test render: every .ts/.tsx file is
 * compiled with the repo's own TypeScript into a temp dir, relative imports get their
 * .mjs suffix, the stylesheet import is dropped, React and its JSX runtime point at the
 * repo's copy (the same React the test renders with), and the app's api module is a stub:
 * useApi returns globalThis.__warRoomApi[path], and api() throws unless a test set
 * globalThis.__warRoomApiCall (path, opts) to answer it. Subfolders (coach/) compile too, and so do
 * the design-system primitives (client/src/components/ui) the War Room imports (AJ-PICK).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WARROOM_DIR = path.join(REPO, 'client', 'src', 'components', 'warroom');
const UI_DIR = path.join(REPO, 'client', 'src', 'components', 'ui');

export async function loadWarRoom() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-warroom-'));
  const req = createRequire(path.join(REPO, 'package.json'));
  const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };
  const reactPath = JSON.stringify(req.resolve('react'));
  const reactUrl = write('react.mjs', `import { createRequire } from 'node:module';
const R = createRequire(${reactPath})(${reactPath});
export default R;
export const { useState, useEffect, useReducer, useRef, useCallback, useContext, useMemo, createContext, Component, Fragment, forwardRef } = R;`);
  const rtPath = JSON.stringify(req.resolve('react/jsx-runtime'));
  const runtimeUrl = write('jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${rtPath})(${rtPath});
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
  const apiUrl = write('api.mjs', `export function useApi(p) {
  (globalThis.__warRoomPaths ??= []).push(p);
  if (globalThis.__warRoomUseApi) return globalThis.__warRoomUseApi(p); // a test that needs loading / error / refetch
  const d = (globalThis.__warRoomApi ?? {})[p] ?? null;
  return { data: d, loading: false, refreshing: false, error: null, refetch() {} };
}
export function api(p, opts) {
  const call = globalThis.__warRoomApiCall;
  if (!call) throw new Error('the War Room must not call api() directly');
  return call(p, opts);
}`);

  const compile = (dir, rel) => {
    fs.mkdirSync(path.join(temp, rel), { recursive: true });
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) { compile(path.join(dir, ent.name), path.join(rel, ent.name)); continue; }
      if (!/\.tsx?$/.test(ent.name)) continue;
      const src = fs.readFileSync(path.join(dir, ent.name), 'utf8');
      let { outputText } = ts.transpileModule(src, {
        fileName: ent.name,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
      });
      outputText = outputText
        .replace(/^import ['"]\.\/[^'"]+\.css['"];?\s*$/gm, '')
        .replace(/from ['"]react\/jsx-runtime['"]/g, `from '${runtimeUrl}'`)
        .replace(/from ['"]react['"]/g, `from '${reactUrl}'`)
        .replace(/from ['"](?:\.\.\/)+api['"]/g, `from '${apiUrl}'`)
        .replace(/from ['"](\.{1,2}\/[\w/-]+)['"]/g, (_, spec) =>
          `from '${spec}${fs.existsSync(path.join(dir, spec)) && fs.statSync(path.join(dir, spec)).isDirectory() ? '/index' : ''}.mjs'`);
      write(path.join(rel, ent.name.replace(/\.tsx?$/, '.mjs')), outputText);
    }
  };
  compile(WARROOM_DIR, 'warroom');
  compile(UI_DIR, 'ui');
  const mod = name => import(pathToFileURL(path.join(temp, 'warroom', `${name}.mjs`)).href);
  return { temp, mod, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

/** Markup -> visible text. */
export const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
