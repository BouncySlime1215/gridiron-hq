/**
 * Loads one client module (and whatever it imports, relatively) for a node:test render: each
 * .ts/.tsx file reached from the entry is compiled with the repo's own TypeScript into a temp
 * dir that mirrors client/src, stylesheet imports are dropped, React and its JSX runtime point at
 * the repo's copy, and the app's api module is the same stub warroom-tsx.mjs uses (useApi returns
 * globalThis.__warRoomApi[path] or __warRoomUseApi(path); api() calls __warRoomApiCall).
 * Only imports that survive compilation are followed, so type-only files are never loaded.
 *
 *   const c = await loadClientModule('components/trade/NumbersPeople.tsx');
 *   const { default: NumbersPeople } = await c.mod();
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(REPO, 'client', 'src');

export async function loadClientModule(entry) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-client-'));
  const req = createRequire(path.join(REPO, 'package.json'));
  const write = (rel, text) => {
    const file = path.join(temp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return pathToFileURL(file).href;
  };
  const reactPath = JSON.stringify(req.resolve('react'));
  const reactUrl = write('__react.mjs', `import { createRequire } from 'node:module';
const R = createRequire(${reactPath})(${reactPath});
export default R;
export const { useState, useEffect, useReducer, useRef, useCallback, useContext, useMemo, createContext, forwardRef, Component, Fragment } = R;`);
  const rtPath = JSON.stringify(req.resolve('react/jsx-runtime'));
  const runtimeUrl = write('__jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${rtPath})(${rtPath});
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
  const apiUrl = write('__api.mjs', `export function useApi(p) {
  (globalThis.__warRoomPaths ??= []).push(p);
  if (globalThis.__warRoomUseApi) return globalThis.__warRoomUseApi(p);
  const d = (globalThis.__warRoomApi ?? {})[p] ?? null;
  return { data: d, loading: false, refreshing: false, error: null, refetch() {} };
}
export function api(p, opts) {
  const call = globalThis.__warRoomApiCall;
  if (!call) throw new Error('this module must not call api() in this test');
  return call(p, opts);
}`);

  const done = new Set();
  const resolveSrc = (fromDir, spec) => {
    const base = path.resolve(fromDir, spec);
    for (const c of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) if (fs.existsSync(c)) return c;
    return null;
  };
  const compile = file => {
    if (done.has(file)) return;
    done.add(file);
    const rel = path.relative(SRC, file).replace(/\.tsx?$/, '.mjs');
    let { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: path.basename(file),
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
    });
    outputText = outputText
      .replace(/^import ['"][^'"]+\.css['"];?\s*$/gm, '')
      .replace(/from ['"]react\/jsx-runtime['"]/g, `from '${runtimeUrl}'`)
      .replace(/from ['"]react['"]/g, `from '${reactUrl}'`)
      .replace(/from ['"](?:\.\.?\/)+api['"]/g, `from '${apiUrl}'`)
      .replace(/from ['"](\.{1,2}\/[\w/.-]+)['"]/g, (_, spec) => {
        const target = resolveSrc(path.dirname(file), spec);
        if (!target) throw new Error(`${path.relative(SRC, file)}: cannot resolve ${spec}`);
        compile(target);
        const out = path.relative(path.dirname(path.join(temp, rel)), path.join(temp, path.relative(SRC, target).replace(/\.tsx?$/, '.mjs')));
        return `from '${out.startsWith('.') ? out : `./${out}`}'`;
      });
    write(rel, outputText);
  };
  compile(path.join(SRC, entry));
  const url = pathToFileURL(path.join(temp, entry.replace(/\.tsx?$/, '.mjs'))).href;
  return { temp, mod: () => import(url), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}
