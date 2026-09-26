/**
 * Static accessibility scan of the client's TSX (item 58, ACCESSIBILITY PASS).
 *
 * Parses each file with the TypeScript compiler (no regex over JSX) and reports:
 *   icon-button-name   a <button>, <a>, Link or NavLink whose only content is icons/SVG and
 *                      that has no aria-label / aria-labelledby (screen readers say "button");
 *   click-no-keyboard  onClick on a non-interactive element (div, span, li, tr, ...) without
 *                      role + tabIndex + onKeyDown, so a keyboard cannot reach or trigger it;
 *   img-alt            <img> without alt;
 *   positive-tabindex  tabIndex > 0, which breaks the page's focus order;
 *   control-label      <input>/<select>/<textarea> with no label (no aria-label, aria-labelledby,
 *                      id, title, and not inside a <label>); a placeholder is not a label.
 *
 * Conservative on purpose: a child expression ({x}) could be text, so it counts as a name,
 * and a {...spread} could carry any prop, so an element with a spread is never flagged for a
 * missing prop. A finding is a real defect or it is not reported. Pure: callers read files.
 */
import ts from 'typescript';

export const RULES = Object.freeze(['icon-button-name', 'click-no-keyboard', 'img-alt', 'positive-tabindex', 'control-label']);

const NON_INTERACTIVE = new Set(['div', 'span', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'p', 'section', 'article', 'header', 'footer', 'aside', 'img', 'svg', 'g', 'label', 'h1', 'h2', 'h3', 'h4', 'main', 'nav', 'figure']);
const LINKISH = new Set(['button', 'a', 'Link', 'NavLink']);
const ICONISH = new Set(['Icon', 'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'img']);
const CONTROLS = new Set(['input', 'select', 'textarea']);
const UNLABELLED_INPUT_TYPES_OK = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

const tagName = node => node.tagName.getText();
function attrs(node) {
  const map = new Map(); let spread = false;
  for (const p of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(p)) { spread = true; continue; }
    map.set(p.name.getText(), p.initializer ?? null);
  }
  return { map, spread };
}
const literal = init => !init ? true : ts.isStringLiteral(init) ? init.text
  : ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNumericLiteral(init.expression)) ? init.expression.text : undefined;

/** true when the children can put text in the accessible name (text, an expression, or text deeper down). */
function hasTextContent(children) {
  for (const c of children) {
    if (ts.isJsxText(c)) { if (c.text.trim()) return true; continue; }
    if (ts.isJsxExpression(c)) { if (c.expression) return true; continue; }
    if (ts.isJsxElement(c)) {
      const name = tagName(c.openingElement);
      const a = attrs(c.openingElement);
      if (ICONISH.has(name)) { if (name !== 'img' && name !== 'Icon') continue; if (a.map.has('alt') && literal(a.map.get('alt'))) return true; if (a.map.has('label')) return true; continue; }
      if (a.map.has('aria-label')) return true;
      if (hasTextContent(c.children)) return true;
      continue;
    }
    if (ts.isJsxSelfClosingElement(c)) {
      const name = tagName(c);
      const a = attrs(c);
      if (a.spread) return true;
      if (name === 'img') { if (literal(a.map.get('alt'))) return true; continue; }
      if (ICONISH.has(name)) { if (a.map.has('aria-label') || a.map.has('label')) return true; continue; }
      return true; // a component we cannot see into may render text
    }
    if (ts.isJsxFragment(c) && hasTextContent(c.children)) return true;
  }
  return false;
}

/** `onClick={e => e.stopPropagation()}`: keeps a click inside a dialog, performs no action. */
function onlyStopsPropagation(init) {
  const fn = init && ts.isJsxExpression(init) && init.expression;
  if (!fn || !ts.isArrowFunction(fn)) return false;
  const body = fn.body.getText().replace(/[{};\s]/g, '');
  return /^\w+\.stopPropagation\(\)$/.test(body);
}

/**
 * A backdrop whose direct child is the dialog: clicking it is a mouse shortcut for closing, and
 * the file must also close on Escape (checked by the caller) so the keyboard has the same exit.
 */
function isScrim(children) {
  return !!children?.some(c => {
    const o = ts.isJsxElement(c) ? c.openingElement : ts.isJsxSelfClosingElement(c) ? c : null;
    return o && literal(attrs(o).map.get('role')) === 'dialog';
  });
}

function insideLabel(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxElement(p) && tagName(p.openingElement) === 'label') return true;
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
}

export function scanSource(src, file = 'input.tsx') {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const report = (rule, node, detail) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ rule, file, line: line + 1, detail });
  };
  const check = (opening, children) => {
    const name = tagName(opening);
    const { map, spread } = attrs(opening);
    const has = k => map.has(k);
    const tab = map.get('tabIndex');
    if (tab !== undefined) {
      const v = tab && ts.isJsxExpression(tab) && tab.expression;
      const n = v && ts.isNumericLiteral(v) ? Number(v.text) : v && ts.isPrefixUnaryExpression(v) ? -1 : typeof literal(tab) === 'string' ? Number(literal(tab)) : NaN;
      if (n > 0) report('positive-tabindex', opening, `<${name} tabIndex={${n}}>`);
    }
    if (spread) return;
    if (LINKISH.has(name) && children && !has('aria-label') && !has('aria-labelledby') && !hasTextContent(children)) {
      report('icon-button-name', opening, `<${name}> with only an icon and no aria-label`);
    }
    if (LINKISH.has(name) && !children && !has('aria-label') && !has('aria-labelledby') && !has('children')) {
      report('icon-button-name', opening, `<${name} /> with no content and no aria-label`);
    }
    if (NON_INTERACTIVE.has(name) && has('onClick') && map.get('aria-hidden') === undefined
      && !onlyStopsPropagation(map.get('onClick')) && !(isScrim(children) && /['"]Escape['"]/.test(src))) {
      if (!(has('role') && has('tabIndex') && has('onKeyDown'))) report('click-no-keyboard', opening, `<${name} onClick> without role, tabIndex and onKeyDown`);
    }
    if (name === 'img' && !has('alt')) report('img-alt', opening, '<img> without alt');
    if (CONTROLS.has(name)) {
      const type = literal(map.get('type'));
      if (name === 'input' && typeof type === 'string' && UNLABELLED_INPUT_TYPES_OK.has(type)) return;
      if (!has('aria-label') && !has('aria-labelledby') && !has('id') && !has('title') && !insideLabel(opening)) {
        report('control-label', opening, `<${name}${typeof type === 'string' ? ` type="${type}"` : ''}> with no label`);
      }
    }
  };
  const visit = node => {
    if (ts.isJsxElement(node)) check(node.openingElement, node.children);
    else if (ts.isJsxSelfClosingElement(node)) check(node, null);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Files local builders own right now (Nick 2026-09-26 03:52, and the Trades client rule of
 * 2026-09-25): the Trades client and War Room, the Coach drawer, the Numbers & People view and
 * the AI spend tracker. They are scanned and reported, never enforced, and never edited here.
 */
export const PROTECTED = Object.freeze([
  /^client\/src\/components\/warroom\//,
  /^client\/src\/components\/trade\//,
  /^client\/src\/components\/coach\//,
  /^client\/src\/.*[Tt]rade[^/]*\.tsx?$/,
  /^client\/src\/.*Coach[^/]*\.tsx?$/,
  /^client\/src\/.*NumbersPeople[^/]*\.tsx?$/,
  /^client\/src\/.*[Ss]pend[^/]*\.tsx?$/,
]);
export const isProtected = file => PROTECTED.some(re => re.test(file.split('\\').join('/')));
