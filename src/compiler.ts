// Compiler with conservative static borrow-checker (explicit move required)
// Supports:
//  - let/const with optional type annotations: let x: Type = ...;
//  - explicit move: let y = move(x);
//  - immutable borrow: let r = &a;
//  - mutable borrow: let m = &mut a;
//  - print(...)
//
// Note: this is still a small MVP compiler that emits runtime instrumentation
// (rs_runtime) and performs conservative lexical static checks.

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const STR_LIT = /^(['"]).*\1$/;
const NUM_LIT = /^[0-9]+(?:\.[0-9]+)?$/;

let nextResId = 1;
function genResId() { return `#res${nextResId++}`; }

type ResState = { immBorrows: number; mutBorrow: boolean };
type VarBinding = { resId: string | null; kind: 'owned' | 'borrow_imm' | 'borrow_mut' | 'moved' };
type Scope = { declaredVars: string[]; borrows: { varName: string; targetVar: string; kind: 'imm' | 'mut' }[] };

export function compile(src: string, filename = 'input.rsc'): string {
  const rawLines = src.split(/\r?\n/);
  const lines = rawLines.map(l => l.replace(/\/\/.*$/, '').trim()).filter(l => l.length > 0);

  const out: string[] = [];
  out.push('// Transpiled by rustyscript (TypeScript MVP)');
  out.push("const __rs = require('./rs_runtime');");
  out.push('');

  const resStates = new Map<string, ResState>();
  const varStacks = new Map<string, VarBinding[]>();
  const scopeStack: Scope[] = [{ declaredVars: [], borrows: [] }];

  function currentBinding(name: string): VarBinding | undefined {
    const stack = varStacks.get(name); if (!stack || stack.length === 0) return undefined;
    return stack[stack.length - 1];
  }
  function pushBinding(name: string, b: VarBinding) {
    let s = varStacks.get(name); if (!s) { s = []; varStacks.set(name, s); }
    s.push(b);
    scopeStack[scopeStack.length - 1].declaredVars.push(name);
  }
  function popBinding(name: string) {
    const s = varStacks.get(name);
    if (!s || s.length === 0) throw new Error('internal: pop empty binding');
    s.pop();
  }

  function declareOwnedFromLiteral(name: string, literal: string) {
    const rid = genResId();
    resStates.set(rid, { immBorrows: 0, mutBorrow: false });
    pushBinding(name, { resId: rid, kind: 'owned' });
    out.push(`const ${name} = __rs.wrap(${literal});`);
  }

  function declareMove(name: string, src: string, rawLine: string) {
    const sb = currentBinding(src);
    if (!sb) throw new Error(`move from undeclared variable '${src}' (line: ${rawLine})`);
    if (sb.kind !== 'owned') throw new Error(`cannot move from '${src}' (not an owner) (line: ${rawLine})`);
    if (sb.resId === null) throw new Error(`use after move: '${src}' (line: ${rawLine})`);
    const rid = sb.resId;
    const rstate = resStates.get(rid)!;
    if (rstate.immBorrows > 0 || rstate.mutBorrow) {
      throw new Error(`cannot move '${src}' while it is borrowed (line: ${rawLine})`);
    }
    // mark source moved and create new binding owning same resource
    sb.resId = null;
    sb.kind = 'moved';
    pushBinding(name, { resId: rid, kind: 'owned' });
    out.push(`const ${name} = __rs.move(${src});`);
  }

  function declareBorrow(name: string, target: string, kind: 'imm' | 'mut', rawLine: string) {
    const tb = currentBinding(target);
    if (!tb) throw new Error(`borrow from undeclared variable '${target}' (line: ${rawLine})`);
    if (tb.kind !== 'owned') throw new Error(`cannot borrow from '${target}' (not an owner) (line: ${rawLine})`);
    if (tb.resId === null) throw new Error(`borrow after move: '${target}' (line: ${rawLine})`);
    const rid = tb.resId!;
    const rstate = resStates.get(rid)!;
    if (kind === 'imm') {
      if (rstate.mutBorrow) throw new Error(`cannot create immutable borrow of '${target}' while mutable borrow exists (line: ${rawLine})`);
      rstate.immBorrows += 1;
      pushBinding(name, { resId: rid, kind: 'borrow_imm' });
      scopeStack[scopeStack.length - 1].borrows.push({ varName: name, targetVar: target, kind: 'imm' });
      out.push(`const ${name} = __rs.borrow(${target});`);
    } else {
      if (rstate.immBorrows > 0 || rstate.mutBorrow) throw new Error(`cannot create mutable borrow of '${target}' while other borrows exist (line: ${rawLine})`);
      rstate.mutBorrow = true;
      pushBinding(name, { resId: rid, kind: 'borrow_mut' });
      scopeStack[scopeStack.length - 1].borrows.push({ varName: name, targetVar: target, kind: 'mut' });
      out.push(`const ${name} = __rs.borrowMut(${target});`);
    }
  }

  function declareLetOrConst(kindLetOrConst: 'let' | 'const', name: string, initializer: string, rawLine: string) {
    const trimmed = initializer.trim();
    // explicit move required: move(x)
    const mMove = trimmed.match(/^move\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)$/);
    if (mMove) {
      const src = mMove[1];
      declareMove(name, src, rawLine);
      return;
    }
    // borrow forms are handled elsewhere
    if (STR_LIT.test(trimmed) || NUM_LIT.test(trimmed) || (trimmed.startsWith('{') && trimmed.endsWith('}')) || trimmed.startsWith('[')) {
      declareOwnedFromLiteral(name, trimmed);
      return;
    }
    throw new Error(`Unsupported initializer (must use move(...) for variable-to-variable transfer): ${initializer} (line: ${rawLine})`);
  }

  function handlePrint(expr: string, rawLine: string) {
    const trimmed = expr.trim();
    if (trimmed.includes('.')) {
      const [v, p] = trimmed.split('.');
      const vb = currentBinding(v);
      if (!vb) throw new Error(`print of undeclared variable '${v}' (line: ${rawLine})`);
      if (vb.resId === null && vb.kind === 'owned') throw new Error(`use after move: '${v}' (line: ${rawLine})`);
      out.push(`console.log((__rs.use(${v})).${p});`);
      return;
    }
    if (STR_LIT.test(trimmed) || NUM_LIT.test(trimmed)) {
      out.push(`console.log(${trimmed});`); return;
    }
    if (IDENT.test(trimmed)) {
      const vb = currentBinding(trimmed);
      if (!vb) throw new Error(`print of undeclared variable '${trimmed}' (line: ${rawLine})`);
      if (vb.resId === null && vb.kind === 'owned') throw new Error(`use after move: '${trimmed}' (line: ${rawLine})`);
      out.push(`console.log(__rs.use(${trimmed}));`); return;
    }
    throw new Error(`Unsupported print expression: ${expr} (line: ${rawLine})`);
  }

  function enterScope() {
    scopeStack.push({ declaredVars: [], borrows: [] });
    out.push('/* scope start */');
  }

  function leaveScope() {
    const scope = scopeStack.pop();
    if (!scope) throw new Error('scope underflow');
    // release borrows in reverse order and update resource states
    for (let b of scope.borrows.slice().reverse()) {
      const tb = currentBinding(b.targetVar);
      // target must have a binding (or moved owner); we only need the resId recorded in the borrow binding
      // find resource id from the borrow binding on var b.varName
      const borrowBinding = currentBinding(b.varName);
      if (!borrowBinding) {
        // shouldn't happen
      } else {
        const rid = borrowBinding.resId!;
        const rs = resStates.get(rid)!;
        if (b.kind === 'imm') {
          rs.immBorrows -= 1;
          out.push(`__rs.release(${b.targetVar}); // release ${b.varName}`);
        } else {
          rs.mutBorrow = false;
          out.push(`__rs.releaseMut(${b.targetVar}); // release_mut ${b.varName}`);
        }
      }
    }
    // pop declared bindings
    for (let i = scope.declaredVars.length - 1; i >= 0; i--) {
      popBinding(scope.declaredVars[i]);
    }
    out.push('/* scope end */');
  }

  for (let raw of lines) {
    const line = raw.trim();

    if (line === '{') { enterScope(); continue; }
    if (line === '}') { leaveScope(); continue; }

    // print(...)
    const mPrint = line.match(/^print\s*\(\s*(.+?)\s*\)\s*;?$/);
    if (mPrint) { handlePrint(mPrint[1], raw); continue; }

    // let/const with optional type annotation: let x: Type = ...
    let m = line.match(/^(let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)(\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?$/);
    if (m) {
      const [, declKind, name, typeAnn, initializer] = m;
      // declare variable (we will add binding inside the helper)
      declareLetOrConst(declKind as 'let' | 'const', name, initializer, raw);
      continue;
    }

    // borrow forms
    m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*&mut\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/);
    if (m) {
      const [, name, target] = m;
      declareBorrow(name, target, 'mut', raw); continue;
    }
    m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*&\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/);
    if (m) {
      const [, name, target] = m;
      declareBorrow(name, target, 'imm', raw); continue;
    }

    throw new Error('Unsupported statement: ' + line);
  }

  while (scopeStack.length > 1) leaveScope();

  return out.join('\n');
}
