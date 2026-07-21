// Compiler with conservative static borrow-checker implementing the Rust-like model adapted for RustyScript.
// - Explicit move required: move(x)
// - Borrow syntax: &x (immutable), &mut x (mutable)
// - let / const with optional type annotations (type annotations are ignored for now)
// - Blocks { } define lexical scope; borrows end at scope exit
// - Emits runtime instrumentation (__rs.wrap / __rs.move / __rs.borrow / __rs.release / __rs.borrowMut / __rs.releaseMut)
// - Static checks enforce the ownership/borrow rules and error on violations early

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const STR_LIT = /^(['"]).*\1$/;
const NUM_LIT = /^[0-9]+(?:\.[0-9]+)?$/;
const BOOL_LIT = /^(true|false)$/;

let nextResId = 1;
function genResId() { return `#res${nextResId++}`; }

type ResState = {
  immut_borrows: number;
  mut_borrow: boolean;
};

type VarBinding = {
  resId: string | null; // null means moved / no resource
  kind: 'owned' | 'borrow_imm' | 'borrow_mut' | 'moved' | 'const';
};

type ScopeBorrow = {
  varName: string;     // name of the borrow variable (the reference variable in the scope)
  targetVar: string;   // the owner variable name that was borrowed from (used for emission)
  kind: 'imm' | 'mut';
};

type Scope = {
  declaredVars: string[];          // variables declared in this scope (for popping on exit)
  borrows: ScopeBorrow[];          // borrows created in this scope (for release at exit)
};

// Utility for errors with line number
function err(lineNo: number, msg: string): never {
  throw new Error(`Compile error (line ${lineNo}): ${msg}`);
}

export function compile(src: string, filename = 'input.rsc'): string {
  const rawLines = src.split(/\r?\n/);
  // keep original lines for error messages and ignore comments
  const processed: { text: string; raw: string; lineNo: number }[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const text = raw.replace(/\/\/.*$/, '').trim();
    if (text.length === 0) continue;
    processed.push({ text, raw, lineNo: i + 1 });
  }

  const out: string[] = [];
  out.push('// Transpiled by rustyscript (TypeScript MVP)');
  out.push("const __rs = require('./rs_runtime');");
  out.push('');

  // Compiler state
  const resourceStates = new Map<string, ResState>(); // resId -> ResState
  const varStacks = new Map<string, VarBinding[]>();  // varName -> stack of bindings (to support shadowing)
  const scopeStack: Scope[] = [{ declaredVars: [], borrows: [] }];

  function currentBinding(name: string): VarBinding | undefined {
    const stack = varStacks.get(name);
    if (!stack || stack.length === 0) return undefined;
    return stack[stack.length - 1];
  }
  function pushBinding(name: string, binding: VarBinding) {
    let stack = varStacks.get(name);
    if (!stack) { stack = []; varStacks.set(name, stack); }
    stack.push(binding);
    scopeStack[scopeStack.length - 1].declaredVars.push(name);
  }
  function popBinding(name: string) {
    const stack = varStacks.get(name);
    if (!stack || stack.length === 0) throw new Error(`internal compiler error: pop empty binding for ${name}`);
    stack.pop();
  }

  function isCopyLiteral(expr: string) {
    const t = expr.trim();
    return NUM_LIT.test(t) || BOOL_LIT.test(t) || STR_LIT.test(t);
  }

  function declareOwnedFromLiteral(name: string, literal: string) {
    // primitives treated as copy: still wrap to keep runtime uniform, but they are OK to copy semantics.
    const rid = genResId();
    resourceStates.set(rid, { immut_borrows: 0, mut_borrow: false });
    pushBinding(name, { resId: rid, kind: 'owned' });
    out.push(`const ${name} = __rs.wrap(${literal});`);
  }

  function declareMove(lineNo: number, dst: string, src: string) {
    const sb = currentBinding(src);
    if (!sb) err(lineNo, `move from undeclared variable '${src}'`);
    if (sb.kind !== 'owned') {
      err(lineNo, `cannot move from '${src}' (not an owner)`);
    }
    if (sb.resId === null) {
      err(lineNo, `use after move: '${src}'`);
    }
    const rid = sb.resId;
    const rstate = resourceStates.get(rid!)!;
    if (rstate.immut_borrows > 0 || rstate.mut_borrow) {
      err(lineNo, `cannot move '${src}' while it is borrowed`);
    }
    // mark source binding moved
    sb.resId = null;
    sb.kind = 'moved';
    // create new dst binding that owns the same resource
    pushBinding(dst, { resId: rid, kind: 'owned' });
    out.push(`const ${dst} = __rs.move(${src});`);
  }

  function declareBorrow(lineNo: number, name: string, target: string, kind: 'imm' | 'mut') {
    const tb = currentBinding(target);
    if (!tb) err(lineNo, `borrow from undeclared variable '${target}'`);
    if (tb.kind !== 'owned') err(lineNo, `cannot borrow from '${target}' (not an owner)`);
    if (tb.resId === null) err(lineNo, `borrow after move: '${target}'`);
    const rid = tb.resId!;
    const rstate = resourceStates.get(rid)!;
    if (kind === 'imm') {
      if (rstate.mut_borrow) err(lineNo, `cannot create immutable borrow of '${target}' while mutable borrow exists`);
      rstate.immut_borrows += 1;
      pushBinding(name, { resId: rid, kind: 'borrow_imm' });
      scopeStack[scopeStack.length - 1].borrows.push({ varName: name, targetVar: target, kind: 'imm' });
      out.push(`const ${name} = __rs.borrow(${target});`);
    } else {
      // mutable borrow
      if (rstate.immut_borrows > 0 || rstate.mut_borrow) err(lineNo, `cannot create mutable borrow of '${target}' while other borrows exist`);
      rstate.mut_borrow = true;
      pushBinding(name, { resId: rid, kind: 'borrow_mut' });
      scopeStack[scopeStack.length - 1].borrows.push({ varName: name, targetVar: target, kind: 'mut' });
      out.push(`const ${name} = __rs.borrowMut(${target});`);
    }
  }

  function declareLetConst(lineNo: number, declKind: 'let'|'const', name: string, initializer: string) {
    const trimmed = initializer.trim();
    // explicit move: move(x)
    const m = trimmed.match(/^move\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)$/);
    if (m) {
      const src = m[1];
      declareMove(lineNo, name, src);
      return;
    }
    // borrow handled elsewhere
    if (isCopyLiteral(trimmed) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // create resource for object/array/literal
      declareOwnedFromLiteral(name, trimmed);
      return;
    }
    // disallow plain assignment from another variable without move
    if (IDENT.test(trimmed)) {
      err(lineNo, `assigning variable '${trimmed}' to '${name}' requires explicit move(${trimmed}) for ownership transfer`);
    }
    err(lineNo, `unsupported initializer for ${name}: ${initializer}`);
  }

  function handlePrint(lineNo: number, expr: string) {
    const trimmed = expr.trim();
    if (trimmed.includes('.')) {
      const parts = trimmed.split('.');
      const v = parts[0];
      const p = parts.slice(1).join('.');
      const vb = currentBinding(v);
      if (!vb) err(lineNo, `print of undeclared variable '${v}'`);
      if (vb.kind === 'owned' && vb.resId === null) err(lineNo, `use after move: '${v}'`);
      // even if borrow var, __rs.use checks runtime moved state; static check suffices
      out.push(`console.log((__rs.use(${v})).${p});`);
      return;
    }
    if (isCopyLiteral(trimmed)) {
      out.push(`console.log(${trimmed});`);
      return;
    }
    if (IDENT.test(trimmed)) {
      const vb = currentBinding(trimmed);
      if (!vb) err(lineNo, `print of undeclared variable '${trimmed}'`);
      if (vb.kind === 'owned' && vb.resId === null) err(lineNo, `use after move: '${trimmed}'`);
      out.push(`console.log(__rs.use(${trimmed}));`);
      return;
    }
    err(lineNo, `unsupported print expression: ${expr}`);
  }

  function enterScope() {
    scopeStack.push({ declaredVars: [], borrows: [] });
    out.push('/* scope start */');
  }

  function leaveScope() {
    const scope = scopeStack.pop();
    if (!scope) throw new Error('internal compiler error: scope underflow');
    // release borrows in reverse creation order
    for (let b of scope.borrows.slice().reverse()) {
      // decrement resource borrow counters
      const borrowBinding = currentBinding(b.varName);
      if (!borrowBinding) {
        // shouldn't happen, but skip gracefully
      } else {
        const rid = borrowBinding.resId!;
        const rs = resourceStates.get(rid)!;
        if (b.kind === 'imm') {
          rs.immut_borrows -= 1;
          out.push(`__rs.release(${b.targetVar}); // release ${b.varName}`);
        } else {
          rs.mut_borrow = false;
          out.push(`__rs.releaseMut(${b.targetVar}); // release_mut ${b.varName}`);
        }
      }
      // pop the borrow variable binding itself
      if (currentBinding(b.varName)) popBinding(b.varName);
    }
    // pop declared variables (owners etc.)
    for (let i = scope.declaredVars.length - 1; i >= 0; i--) {
      const name = scope.declaredVars[i];
      popBinding(name);
    }
    out.push('/* scope end */');
  }

  // Main loop: process each processed line with its lineNo
  for (const { text: line, raw, lineNo } of processed) {
    if (line === '{') { enterScope(); continue; }
    if (line === '}') { leaveScope(); continue; }

    // print(...)
    const mPrint = line.match(/^print\s*\(\s*(.+?)\s*\)\s*;?$/);
    if (mPrint) { handlePrint(lineNo, mPrint[1]); continue; }

    // let/const with optional type: let x: Type = expr;
    let m = line.match(/^(let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)(\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?$/);
    if (m) {
      const [, declKind, name, _typeAnn, initializer] = m;
      declareLetConst(lineNo, declKind as 'let'|'const', name, initializer);
      continue;
    }

    // borrow forms: let r = &a; let m = &mut a;
    m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*&mut\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/);
    if (m) { const [, name, target] = m; declareBorrow(lineNo, name, target, 'mut'); continue; }
    m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*&\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/);
    if (m) { const [, name, target] = m; declareBorrow(lineNo, name, target, 'imm'); continue; }

    // unsupported
    err(lineNo, `unsupported statement: ${raw}`);
  }

  // close remaining scopes
  while (scopeStack.length > 1) leaveScope();

  out.push('');
  out.push('// End of transpiled file');
  return out.join('\n');
}
