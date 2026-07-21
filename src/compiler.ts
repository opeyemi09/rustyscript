// Minimal TypeScript-based transpiler for RustyScript (MVP).
// - Supports blocks { ... } with lexical scopes
// - let <name> = <expr>;
// - borrow: let r = &a;
// - borrow_mut: let m = &mut a;
// - moves: let y = x;  (compiler emits __rs.move(x))
// - print(expr);
// The compiler tracks borrows created inside each lexical block and lowers automatic releases
// by inserting __rs.release / __rs.releaseMut calls at scope exit (simple lowering).

// Helpers to detect tokens (very small subset)
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const STR_LIT = /^(['"]).*\1$/;
const NUM_LIT = /^[0-9]+(?:\.[0-9]+)?$/;

export function compile(src: string, filename = 'input.rsc'): string {
  // Preprocess: remove comments, keep lines
  const rawLines = src.split(/\r?\n/);
  const lines = rawLines.map(l => l.replace(/\/\/.*$/, '').trim()).filter(l => l.length > 0);

  const out: string[] = [];
  out.push('// Transpiled by rustyscript (TypeScript MVP)');
  out.push("const __rs = require('./rs_runtime');");
  out.push('');

  // Simple lexical scope stack; each scope records borrows to release at end.
  type Scope = { borrows: { name: string, kind: 'imm' | 'mut', target: string }[] };
  const scopeStack: Scope[] = [{ borrows: [] }];

  function emitScopePrologue() {
    out.push('/* scope start */');
  }

  function emitScopeEpilogue() {
    const scope = scopeStack.pop();
    if (!scope) throw new Error('scope stack underflow');
    if (scope.borrows.length === 0) {
      out.push('/* scope end */');
      return;
    }
    // Simpler lowering: emit release calls now (synchronous scopes).
    for (let b of scope.borrows.reverse()) {
      if (b.kind === 'imm') {
        out.push(`__rs.release(${b.target}); // release borrow ${b.name}`);
      } else {
        out.push(`__rs.releaseMut(${b.target}); // release_mut ${b.name}`);
      }
    }
    out.push('/* scope end */');
  }

  for (let raw of lines) {
    const line = raw.trim();

    if (line === '{') {
      scopeStack.push({ borrows: [] });
      emitScopePrologue();
      continue;
    }
    if (line === '}') {
      emitScopeEpilogue();
      continue;
    }

    // print(...)
    const mPrint = line.match(/^print\s*\(\s*(.+?)\s*\)\s*;?$/);
    if (mPrint) {
      const expr = mPrint[1].trim();
      if (expr.includes('.')) {
        out.push(`console.log((__rs.use(${expr.split('.')[0]})).${expr.split('.')[1]});`);
      } else if (STR_LIT.test(expr) || NUM_LIT.test(expr)) {
        out.push(`console.log(${expr});`);
      } else if (IDENT.test(expr)) {
        out.push(`console.log(__rs.use(${expr}));`);
      } else {
        throw new Error('Unsupported print expression: ' + expr);
      }
      continue;
    }

    // let <name> = &mut <target>;
    let m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*&mut\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/);
    if (m) {
      const [, name, target] = m;
      out.push(`const ${name} = __rs.borrowMut(${target});`);
      scopeStack[scopeStack.length - 1].borrows.push({ name, kind: 'mut', target });
      continue;
    }

    // let <name> = &<target>;
    m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*&\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/);
    if (m) {
      const [, name, target] = m;
      out.push(`const ${name} = __rs.borrow(${target});`);
      scopeStack[scopeStack.length - 1].borrows.push({ name, kind: 'imm', target });
      continue;
    }

    // let <name> = <expr>;
    m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.+?)\s*;?$/);
    if (m) {
      const [, name, expr] = m;
      const trimmed = expr.trim();
      if (IDENT.test(trimmed)) {
        out.push(`const ${name} = __rs.move(${trimmed});`);
      } else if (STR_LIT.test(trimmed) || NUM_LIT.test(trimmed) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        out.push(`const ${name} = __rs.wrap(${trimmed});`);
      } else {
        throw new Error('Unsupported let initializer: ' + expr);
      }
      continue;
    }

    throw new Error('Unsupported statement: ' + line);
  }

  // close remaining scopes
  while (scopeStack.length > 1) {
    emitScopeEpilogue();
  }

  out.push('');
  out.push('// End of transpiled file');
  return out.join('\n');
}
