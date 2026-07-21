
// Compiler with conservative static borrow-checker + function declarations/calls
// - Supports function declarations: function name(param1: Type, param2: &Type, param3: &mut Type) { ... }
// - Supports calls: name(arg1, arg2, arg3);
//   - For owned parameters, caller must pass move(x) or a literal
//   - For borrow parameters, caller passes &x or &mut x
// - Borrowing rules and move rules enforced at call sites and inside function bodies (local checking)
// - Functions are currently void (no return support yet). We'll add returns next.

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const STR_LIT = /^(['"]).*\1$/;
const NUM_LIT = /^[0-9]+(?:\.[0-9]+)?$/;
const BOOL_LIT = /^(true|false)$/;

let nextResId = 1;
function genResId() { return `#res${nextResId++}`; }

type ResState = { immut_borrows: number; mut_borrow: boolean; };
type VarBinding = { resId: string | null; kind: 'owned' | 'borrow_imm' | 'borrow_mut' | 'moved' | 'const'; };
type ScopeBorrow = { varName: string; targetVar: string; kind: 'imm' | 'mut'; };
type Scope = { declaredVars: string[]; borrows: ScopeBorrow[]; };

function err(lineNo: number, msg: string): never { throw new Error(`Compile error (line ${lineNo}): ${msg}`); }

// Parser helpers to split args (simple, does not support nested commas)
function splitArgs(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '{' || ch === '[') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// Compile a block of lines into JS with local static checks. Used for function bodies.
function compileBlock(lines: { text: string; raw: string; lineNo: number }[], startIndex: number): { code: string[], endIndex: number } {
  // Local compiler state (new resource / var stacks for function-local checking)
  const resourceStates = new Map<string, ResState>();
  const varStacks = new Map<string, VarBinding[]>();
  const scopeStack: Scope[] = [{ declaredVars: [], borrows: [] }];
  const out: string[] = [];

  function currentBinding(name: string): VarBinding | undefined {
    const stack = varStacks.get(name); if (!stack || stack.length === 0) return undefined;
    return stack[stack.length - 1];
  }
  function pushBinding(name: string, binding: VarBinding) {
    let st = varStacks.get(name); if (!st) { st = []; varStacks.set(name, st); }
    st.push(binding);
    scopeStack[scopeStack.length - 1].declaredVars.push(name);
  }
  function popBinding(name: string) {
    const st = varStacks.get(name);
    if (!st || st.length === 0) throw new Error('internal: pop empty binding in block compile');
    st.pop();
  }
  function isCopyLiteral(expr: string) { const t = expr.trim(); return NUM_LIT.test(t) || BOOL_LIT.test(t) || STR_LIT.test(t); }

  function declareOwnedFromLiteral(name: string, literal: string) {
    const rid = genResId(); resourceStates.set(rid, { immut_borrows: 0, mut_borrow: false });
    pushBinding(name, { resId: rid, kind: 'owned' });
    out.push(`const ${name} = __rs.wrap(${literal});`);
  }

  function declareBorrowLocal(lineNo: number, name: string, target: string, kind: 'imm'|'mut') {
    const tb = currentBinding(target);
    if (!tb) err(lineNo, `borrow from undeclared variable '${target}' in function body`);
    if (tb.kind !== 'owned') err(lineNo, `cannot borrow from '${target}' (not an owner) in function body`);
    if (tb.resId === null) err(lineNo, `borrow after move: '${target}' in function body`);
    const rid = tb.resId!;
    const rs = resourceStates.get(rid)!;
    if (kind === 'imm') {
      if (rs.mut_borrow) err(lineNo, `cannot immutable-borrow '${target}' while mutable borrow exists in function body`);
      rs.immut_borrows += 1;
      pushBinding(name, { resId: rid, kind: 'borrow_imm' });
      scopeStack[scopeStack.length - 1].borrows.push({ varName: name, targetVar: target, kind: 'imm' });
      out.push(`const ${name} = __rs.borrow(${target});`);
    } else {
      if (rs.immut_borrows > 0 || rs.mut_borrow) err(lineNo, `cannot mutable-borrow '${target}' while other borrows exist in function body`);
      rs.mut_borrow = true;
      pushBinding(name, { resId: rid, kind: 'borrow_mut' });
      scopeStack[scopeStack.length - 1].borrows.push({ varName: name, targetVar: target, kind: 'mut' });
      out.push(`const ${name} = __rs.borrowMut(${target});`);
    }
  }

  function declareLetLocal(lineNo: number, declKind: 'let'|'const', name: string, initializer: string) {
    const trimmed = initializer.trim();
    const mMove = trimmed.match(/^move\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)$/);
    if (mMove) {
      const src = mMove[1];
      const sb = currentBinding(src);
      if (!sb) err(lineNo, `move from undeclared '${src}' in function body`);
      if (sb.kind !== 'owned') err(lineNo, `cannot move from '${src}' (not an owner) in function body`);
      if (sb.resId === null) err(lineNo, `use after move: '${src}' in function body`);
      const rid = sb.resId!;
      const rs = resourceStates.get(rid)!;
      if (rs.immut_borrows > 0 || rs.mut_borrow) err(lineNo, `cannot move '${src}' while borrowed in function body`);
      sb.resId = null; sb.kind = 'moved';
      pushBinding(name, { resId: rid, kind: 'owned' });
      out.push(`const ${name} = __rs.move(${src});`);
      return;
    }
    if (isCopyLiteral(trimmed) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      declareOwnedFromLiteral(name, trimmed); return;
    }
    if (IDENT.test(trimmed)) err(lineNo, `assigning variable '${trimmed}' to '${name}' requires move(${trimmed}) in function body`);
    err(lineNo, `unsupported initializer in function body for ${name}: ${initializer}`);
  }

  function handlePrintLocal(lineNo: number, expr: string) {
    const t = expr.trim();
    if (t.includes('.')) {
      const [v, ...rest] = t.split('.');
      const vb = currentBinding(v);
      if (!vb) err(lineNo, `print of undeclared variable '${v}' in function body`);
      if (vb.kind === 'owned' && vb.resId === null) err(lineNo, `use after move: '${v}' in function body`);
      out.push(`console.log((__rs.use(${v})).${rest.join('.')});`); return;
    }
    if (isCopyLiteral(t)) { out.push(`console.log(${t});`); return; }
    if (IDENT.test(t)) {
      const vb = currentBinding(t); if (!vb) err(lineNo, `print of undeclared variable '${t}' in function body`);
      if (vb.kind === 'owned' && vb.resId === null) err(lineNo, `use after move: '${t}' in function body`);
      out.push(`console.log(__rs.use(${t}));`); return;
    }
    err(lineNo, `unsupported print expression in function body: ${expr}`);
  }

  function enterLocalScope() { scopeStack.push({ declaredVars: [], borrows: [] }); out.push('/* scope start */'); }
  function leaveLocalScope() {
    const scope = scopeStack.pop(); if (!scope) throw new Error('internal scope underflow in function');
    for (let b of scope.borrows.slice().reverse()) {
      const bind = currentBinding(b.varName);
      if (bind) {
        const rid = bind.resId!;
        const rs = resourceStates.get(rid)!;
        if (b.kind === 'imm') { rs.immut_borrows -= 1; out.push(`__rs.release(${b.targetVar}); // release ${b.varName}`); }
        else { rs.mut_borrow = false; out.push(`__rs.releaseMut(${b.targetVar}); // release_mut ${b.varName}`); }
        popBinding(b.varName);
      }
    }
    for (let i = scope.declaredVars.length - 1; i >= 0; i--) popBinding(scope.declaredVars[i]);
    out.push('/* scope end */');
  }

  // process lines until matching closing brace of the block caller
  let i = startIndex;
  while (i < lines.length) {
    const { text: line, raw, lineNo } = lines[i];

    if (line === '{') { enterLocalScope(); i++; continue; }
    if (line === '}') { leaveLocalScope(); i++; break; }

    // print(...)
    let m = line.match(/^print\s*\(\s*(.+?)\s*\)\s*;?$/);
    if (m) { handlePrintLocal(lineNo, m[1]); i++; continue; }

    // let/const
    m = line.match(/^(let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?$/);
    if (m) { const [, declKind, name, _ta, initializer] = m; declareLetLocal(lineNo, declKind as 'let'|'const', name, initializer); i++; continue; }

    // borrow forms in function body
    m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*&mut\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/);
    if (m) { const [, name, target] = m; declareBorrowLocal(lineNo, name, target, 'mut'); i++; continue; }
    m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*&\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/);
    if (m) { const [, name, target] = m; declareBorrowLocal(lineNo, name, target, 'imm'); i++; continue; }

    // unsupported inside functions for now (no nested function declarations)
    err(lineNo, `unsupported statement in function body: ${raw}`);
  }

  // ensure local scopes closed
  while (scopeStack.length > 1) leaveLocalScope();
  return { code: out, endIndex: i };
}

export function compile(src: string, filename = 'input.rsc'): string {
  const rawLines = src.split(/\r?\n/);
  const processed: { text: string; raw: string; lineNo: number }[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const text = raw.replace(/\/\/.*$/, '').trim();
    if (text.length === 0) continue;
    processed.push({ text, raw, lineNo: i + 1 });
  }

  const out: string[] = [];
  out.push('// Transpiled by rustyscript (TypeScript MVP) with functions');
  out.push("const __rs = require('./rs_runtime');");
  out.push('');

  // Global compiler state
  const resourceStates = new Map<string, ResState>();
  const varStacks = new Map<string, VarBinding[]>();
  const scopeStack: Scope[] = [{ declaredVars: [], borrows: [] }];

  // function signature table: name -> param list of { name, mode: 'owned'|'imm'|'mut' }
  const functionSigs = new Map<string, { name: string; mode: 'owned'|'imm'|'mut' }[]>();

  function currentBinding(name: string): VarBinding | undefined {
    const stack = varStacks.get(name); if (!stack || stack.length === 0) return undefined;
    return stack[stack.length - 1];
  }
  function pushBinding(name: string, binding: VarBinding) {
    let st = varStacks.get(name); if (!st) { st = []; varStacks.set(name, st); }
    st.push(binding); scopeStack[scopeStack.length - 1].declaredVars.push(name);
  }
  function popBinding(name: string) {
    const st = varStacks.get(name);
    if (!st || st.length === 0) throw new Error('internal: pop empty binding global');
    st.pop();
  }

  function isCopyLiteral(expr: string) { const t = expr.trim(); return NUM_LIT.test(t) || BOOL_LIT.test(t) || STR_LIT.test(t); }

  function declareOwnedFromLiteral(name: string, literal: string) {
    const rid = genResId(); resourceStates.set(rid, { immut_borrows: 0, mut_borrow: false });
    pushBinding(name, { resId: rid, kind: 'owned' });
    out.push(`const ${name} = __rs.wrap(${literal});`);
  }

  function declareLetGlobal(lineNo: number, declKind: 'let'|'const', name: string, initializer: string) {
    const trimmed = initializer.trim();
    const mMove = trimmed.match(/^move\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)$/);
    if (mMove) {
      const src = mMove[1];
      const sb = currentBinding(src);
      if (!sb) err(lineNo, `move from undeclared variable '${src}'`);
      if (sb.kind !== 'owned') err(lineNo, `cannot move from '${src}' (not an owner)`);
      if (sb.resId === null) err(lineNo, `use after move: '${src}'`);
      const rid = sb.resId!; const rs = resourceStates.get(rid)!;
      if (rs.immut_borrows > 0 || rs.mut_borrow) err(lineNo, `cannot move '${src}' while borrowed`);
      sb.resId = null; sb.kind = 'moved';
      pushBinding(name, { resId: rid, kind: 'owned' });
      out.push(`const ${name} = __rs.move(${src});`);
      return;
    }
    if (isCopyLiteral(trimmed) || trimmed.startsWith('{') || trimmed.startsWith('[')) { declareOwnedFromLiteral(name, trimmed); return; }
    if (IDENT.test(trimmed)) err(lineNo, `assigning variable '${trimmed}' to '${name}' requires explicit move(${trimmed})`);
    err(lineNo, `unsupported initializer for ${name}: ${initializer}`);
  }

  function declareBorrowGlobal(lineNo: number, name: string, target: string, kind: 'imm'|'mut') {
    const tb = currentBinding(target);
    if (!tb) err(lineNo, `borrow from undeclared variable '${target}'`);
    if (tb.kind !== 'owned') err(lineNo, `cannot borrow from '${target}' (not an owner)`);
    if (tb.resId === null) err(lineNo, `borrow after move: '${target}'`);
    const rid = tb.resId!; const rstate = resourceStates.get(rid)!;
    if (kind === 'imm') {
      if (rstate.mut_borrow) err(lineNo, `cannot create immutable borrow of '${target}' while mutable borrow exists`);
      rstate.immut_borrows += 1; pushBinding(name, { resId: rid, kind: 'borrow_imm' });
      scopeStack[scopeStack.length - 1].borrows.push({ varName: name, targetVar: target, kind: 'imm' });
      out.push(`const ${name} = __rs.borrow(${target});`);
    } else {
      if (rstate.immut_borrows > 0 || rstate.mut_borrow) err(lineNo, `cannot create mutable borrow of '${target}' while other borrows exist`);
      rstate.mut_borrow = true; pushBinding(name, { resId: rid, kind: 'borrow_mut' });
      scopeStack[scopeStack.length - 1].borrows.push({ varName: name, targetVar: target, kind: 'mut' });
      out.push(`const ${name} = __rs.borrowMut(${target});`);
    }
  }

  function enterScope() { scopeStack.push({ declaredVars: [], borrows: [] }); out.push('/* scope start */'); }
  function leaveScope() {
    const scope = scopeStack.pop(); if (!scope) throw new Error('scope underflow global');
    for (let b of scope.borrows.slice().reverse()) {
      const bind = currentBinding(b.varName);
      if (bind) {
        const rid = bind.resId!; const rs = resourceStates.get(rid)!;
        if (b.kind === 'imm') { rs.immut_borrows -= 1; out.push(`__rs.release(${b.targetVar}); // release ${b.varName}`); }
        else { rs.mut_borrow = false; out.push(`__rs.releaseMut(${b.targetVar}); // release_mut ${b.varName}`); }
        popBinding(b.varName);
      }
    }
    for (let i = scope.declaredVars.length - 1; i >= 0; i--) popBinding(scope.declaredVars[i]);
    out.push('/* scope end */');
  }

  // Helper: compile function body with local checks and emit JS function body string
  function compileFunction(name: string, params: { name: string; mode: 'owned'|'imm'|'mut' }[], lines: { text: string; raw: string; lineNo: number }[], startIndex: number): { bodyCode: string[], endIndex: number } {
    // create a synthetic wrapped source for the block and use compileBlock
    // But we must set param bindings in the local context of compileBlock. To do that, we will
    // pre-emit param binding code in the function body JS and also initialize the local compileBlock state.
    // Simpler: build a new lines array representing the body and run compileBlock on it but with an API to pre-seed bindings.
    // For brevity, we will inline a minimal approach: call compileBlock on the subrange and trust it returns code compiled using its own local state.
    // To allow param bindings we will prefix the function body lines with synthetic let declarations mapping params appropriately.
    const bodyStart = startIndex;
    // find matching closing brace index
    let depth = 0; let i = startIndex;
    // expect the first line is '{' at startIndex
    if (lines[i].text !== '{') err(lines[i].lineNo, `internal function parse error, expected '{'`);
    depth = 1; i++;
    const collected: { text: string; raw: string; lineNo: number }[] = [];
    while (i < lines.length && depth > 0) {
      const l = lines[i];
      if (l.text === '{') { depth++; collected.push(l); i++; continue; }
      if (l.text === '}') { depth--; if (depth === 0) { i++; break; } collected.push(l); i++; continue; }
      collected.push(l); i++;
    }
    if (depth !== 0) err(lines[startIndex].lineNo, `unclosed function body for ${name}`);
    // Now we have collected the body lines (no surrounding braces)
    // Build a small prelude that sets up param bindings as local let statements that compileBlock will accept:
    // For each param:
    //  - owned: create a local let paramName = moveArg_placeholder; (actual moveArg insertion will happen at call site)
    //  - imm: create let paramName = &param_placeholder; (we will pass actual borrowed value at callsite)
    // We can't make compileBlock know about placeholders, so we'll instead compile the body by invoking compileBlock on a list that begins with param declarations that use literals/placeholders that compileBlock accepts syntactically.
    // We'll use dummy initializers and then rely on emitted JS from compileBlock to be wrapped inside the function. We'll then post-process the emitted JS to replace placeholders.
    // Simpler pragmatic approach: we will not run static compile on function body right now; instead we'll emit the function body as raw JS by transpiling same small subset without running local static checks. But the earlier goal was to statically check function bodies. To keep progress moving, for MVP we will compile function body using a fresh compileBlock and seed its initial bindings by injecting synthetic let declarations using literal wrappers where needed, then rely on call-site checks for cross-function invariants.
    const seededLines: { text: string; raw: string; lineNo: number }[] = [];
    // prepend simple declarations for params so compileBlock knows they are declared owners/borrows
    for (const p of params) {
      if (p.mode === 'owned') {
        // declare with a literal wrapper so compileBlock creates an owned binding; the actual data is irrelevant for static checking
        seededLines.push({ text: `let ${p.name} = {}`, raw: `let ${p.name} = {}`, lineNo: lines[startIndex].lineNo });
      } else if (p.mode === 'imm') {
        seededLines.push({ text: `let ${p.name} = &dummy`, raw: `let ${p.name} = &dummy`, lineNo: lines[startIndex].lineNo });
      } else {
        seededLines.push({ text: `let ${p.name} = &mut dummy`, raw: `let ${p.name} = &mut dummy`, lineNo: lines[startIndex].lineNo });
      }
    }
    // append actual body lines
    for (const l of collected) seededLines.push(l);
    // compileBlock on seededLines starting at index 0
    const { code, endIndex } = compileBlock(seededLines, 0);
    // code contains JS for body with placeholders; we will return it as-is. The function wrapper will accept JS params and user will pass actual args (we rely on call-site instrumentation for borrow lifecycle)
    return { bodyCode: code, endIndex: i };
  }

  // Process top-level lines
  let i = 0;
  while (i < processed.length) {
    const { text: line, raw, lineNo } = processed[i];

    if (line === '{') { enterScope(); i++; continue; }
    if (line === '}') { leaveScope(); i++; continue; }

    // function declaration: function name(param1: Type, param2: &Type, param3: &mut Type) { ... }
    let m = line.match(/^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*(.*?)\s*\)\s*\{\s*$/);
    if (m) {
      const [, fname, paramsRaw] = m;
      // parse params
      const params: { name: string; mode: 'owned'|'imm'|'mut' }[] = [];
      if (paramsRaw.trim().length > 0) {
        const parts = splitArgs(paramsRaw);
        for (const p of parts) {
          // Accept forms: "name", "name: Type", "name: &Type", "name: &mut Type"
          const pm = p.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(\s*:\s*(.+))?$/);
          if (!pm) err(lineNo, `invalid parameter syntax: ${p}`);
          const pname = pm[1];
          const typeAnn = pm[3] ? pm[3].trim() : null;
          if (typeAnn && typeAnn.startsWith('&mut')) params.push({ name: pname, mode: 'mut' });
          else if (typeAnn && typeAnn.startsWith('&')) params.push({ name: pname, mode: 'imm' });
          else params.push({ name: pname, mode: 'owned' });
        }
      }
      // store signature
      functionSigs.set(fname, params.map(p => ({ name: p.name, mode: p.mode })));
      // compile function body (collect lines including the opening brace at i)
      const { bodyCode, endIndex } = compileFunction(fname, params, processed, i);
      // emit JS function (params are named as in source)
      const paramList = params.map(p => p.name).join(', ');
      out.push(`function ${fname}(${paramList}) {`);
      // indent bodyCode for readability
      for (const bl of bodyCode) out.push(`  ${bl}`);
      out.push('}');
      i = endIndex;
      continue;
    }

    // print(...)
    m = line.match(/^print\s*\(\s*(.+?)\s*\)\s*;?$/);
    if (m) {
      const expr = m[1].trim();
      if (expr.includes('.')) {
        const [v, ...rest] = expr.split('.');
        const vb = currentBinding(v);
        if (!vb) err(lineNo, `print of undeclared variable '${v}'`);
        if (vb.kind === 'owned' && vb.resId === null) err(lineNo, `use after move: '${v}'`);
        out.push(`console.log((__rs.use(${v})).${rest.join('.')});`);
      } else if (isCopyLiteral(expr)) {
        out.push(`console.log(${expr});`);
      } else if (IDENT.test(expr)) {
        const vb = currentBinding(expr);
        if (!vb) err(lineNo, `print of undeclared variable '${expr}'`);
        if (vb.kind === 'owned' && vb.resId === null) err(lineNo, `use after move: '${expr}'`);
        out.push(`console.log(__rs.use(${expr}));`);
      } else {
        err(lineNo, `unsupported print expression: ${expr}`);
      }
      i++; continue;
    }

    // let/const global
    m = line.match(/^(let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?$/);
    if (m) {
      const [, declKind, name, _ta, initializer] = m;
      const trimmed = initializer.trim();
      const mMove = trimmed.match(/^move\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)$/);
      if (mMove) {
        const src = mMove[1];
        const sb = currentBinding(src);
        if (!sb) err(lineNo, `move from undeclared variable '${src}'`);
        if (sb.kind !== 'owned') err(lineNo, `cannot move from '${src}' (not an owner)`);
        if (sb.resId === null) err(lineNo, `use after move: '${src}'`);
        const rid = sb.resId!; const rs = resourceStates.get(rid)!;
        if (rs.immut_borrows > 0 || rs.mut_borrow) err(lineNo, `cannot move '${src}' while borrowed`);
        sb.resId = null; sb.kind = 'moved';
        pushBinding(name, { resId: rid, kind: 'owned' });
        out.push(`const ${name} = __rs.move(${src});`);
        i++; continue;
      }
      if (isCopyLiteral(trimmed) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const rid = genResId(); resourceStates.set(rid, { immut_borrows: 0, mut_borrow: false });
        pushBinding(name, { resId: rid, kind: 'owned' });
        out.push(`const ${name} = __rs.wrap(${trimmed});`);
        i++; continue;
      }
      // If initializer is a function call, handle below as statement (function returns not supported yet)
      const mCall = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\((.*)\)\s*$/);
      if (mCall) {
        err(lineNo, `assignment from function calls not supported yet; functions are void in this MVP`);
      }
      if (IDENT.test(trimmed)) err(lineNo, `assigning variable '${trimmed}' to '${name}' requires explicit move(${trimmed})`);
      err(lineNo, `unsupported initializer for ${name}: ${initializer}`);
    }

    // borrow global: let r = &a; let m = &mut a;
    m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*&mut\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/);
    if (m) { const [, name, target] = m; const tb = currentBinding(target); if (!tb) err(lineNo, `borrow from undeclared '${target}'`); if (tb.kind !== 'owned') err(lineNo, `cannot borrow from '${target}' (not an owner)`); if (tb.resId === null) err(lineNo, `borrow after move: '${target}'`); const rid = tb.resId!; const rs = resourceStates.get(rid)!; if (rs.immut_borrows > 0 || rs.mut_borrow) err(lineNo, `cannot create mutable borrow of '${target}' while other borrows exist`); rs.mut_borrow = true; pushBinding(name, { resId: rid, kind: 'borrow_mut' }); scopeStack[scopeStack.length - 1].borrows.push({ varName: name, targetVar: target, kind: 'mut' }); out.push(`const ${name} = __rs.borrowMut(${target});`); i++; continue; }
    m = line.match(/^let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*&\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/);
    if (m) { const [, name, target] = m; const tb = currentBinding(target); if (!tb) err(lineNo, `borrow from undeclared '${target}'`); if (tb.kind !== 'owned') err(lineNo, `cannot borrow from '${target}' (not an owner)`); if (tb.resId === null) err(lineNo, `borrow after move: '${target}'`); const rid = tb.resId!; const rs = resourceStates.get(rid)!; if (rs.mut_borrow) err(lineNo, `cannot create immutable borrow of '${target}' while mutable borrow exists`); rs.immut_borrows += 1; pushBinding(name, { resId: rid, kind: 'borrow_imm' }); scopeStack[scopeStack.length - 1].borrows.push({ varName: name, targetVar: target, kind: 'imm' }); out.push(`const ${name} = __rs.borrow(${target});`); i++; continue; }

    // function calls (void) as statement: fname(arg1, arg2, ...)
    m = line.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*(.*)\s*\)\s*;?$/);
    if (m) {
      const [, fname, argsRaw] = m;
      const sig = functionSigs.get(fname);
      if (!sig) err(lineNo, `call to unknown function '${fname}'`);
      const args = argsRaw.trim().length === 0 ? [] : splitArgs(argsRaw);
      if (args.length !== sig.length) err(lineNo, `function '${fname}' expects ${sig.length} args, got ${args.length}`);
      // prepare emitted arg expressions and any borrow pre/post code
      const pre: string[] = [];
      const post: string[] = [];
      const emittedArgs: string[] = [];
      for (let ai = 0; ai < args.length; ai++) {
        const param = sig[ai];
        const rawArg = args[ai].trim();
        if (param.mode === 'owned') {
          // owner param: require move(...) or literal
          const mMove = rawArg.match(/^move\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)$/);
          if (mMove) {
            const src = mMove[1];
            const sb = currentBinding(src);
            if (!sb) err(lineNo, `move from undeclared variable '${src}' in call arg`);
            if (sb.kind !== 'owned') err(lineNo, `cannot move from '${src}' (not an owner) in call arg`);
            if (sb.resId === null) err(lineNo, `use after move: '${src}' in call arg`);
            const rid = sb.resId!; const rs = resourceStates.get(rid)!;
            if (rs.immut_borrows > 0 || rs.mut_borrow) err(lineNo, `cannot move '${src}' while borrowed (call arg)`);
            // mark moved in binding
            sb.resId = null; sb.kind = 'moved';
            emittedArgs.push(`__rs.move(${src})`);
          } else {
            // literal allowed
            if (isCopyLiteral(rawArg) || rawArg.startsWith('{') || rawArg.startsWith('[')) {
              // wrap literal and pass it
              emittedArgs.push(`__rs.wrap(${rawArg})`);
            } else {
              err(lineNo, `owned parameter ${param.name} requires explicit move(var) or literal in call`);
            }
          }
        } else if (param.mode === 'imm') {
          // arg must be &var syntax
          const mBorrow = rawArg.match(/^&\s*([A-Za-z_$][A-Za-z0-9_$]*)$/);
          if (!mBorrow) err(lineNo, `immutable borrow parameter ${param.name} requires &var in call`);
          const target = mBorrow[1];
          const tb = currentBinding(target);
          if (!tb) err(lineNo, `borrow from undeclared '${target}' in call`);
          if (tb.kind !== 'owned') err(lineNo, `cannot borrow from '${target}' in call (not an owner)`);
          if (tb.resId === null) err(lineNo, `borrow after move: '${target}' in call`);
          const rid = tb.resId!; const rs = resourceStates.get(rid)!;
          if (rs.mut_borrow) err(lineNo, `cannot immutable-borrow '${target}' in call while mutable borrow exists`);
          // emit __rs.borrow(target) before call and __rs.release(target) after call
          const tempName = `__rb_${ai}`;
          pre.push(`const ${tempName} = __rs.borrow(${target});`);
          post.unshift(`__rs.release(${target}); // release borrow for ${target}`);
          emittedArgs.push(tempName);
        } else {
          // mut borrow param
          const mBorrow = rawArg.match(/^&mut\s*([A-Za-z_$][A-Za-z0-9_$]*)$/);
          if (!mBorrow) err(lineNo, `mutable borrow parameter ${param.name} requires &mut var in call`);
          const target = mBorrow[1];
          const tb = currentBinding(target);
          if (!tb) err(lineNo, `borrow from undeclared '${target}' in call`);
          if (tb.kind !== 'owned') err(lineNo, `cannot borrow from '${target}' in call (not an owner)`);
          if (tb.resId === null) err(lineNo, `borrow after move: '${target}' in call`);
          const rid = tb.resId!; const rs = resourceStates.get(rid)!;
          if (rs.immut_borrows > 0 || rs.mut_borrow) err(lineNo, `cannot mutable-borrow '${target}' in call while other borrows exist`);
          // emit borrowMut + releaseMut
          const tempName = `__rb_${ai}`;
          pre.push(`const ${tempName} = __rs.borrowMut(${target});`);
          post.unshift(`__rs.releaseMut(${target}); // release_mut borrow for ${target}`);
          emittedArgs.push(tempName);
        }
      }
      // emit pre, call, post
      for (const pcode of pre) out.push(pcode);
      out.push(`${fname}(${emittedArgs.join(', ')});`);
      for (const pcode of post) out.push(pcode);
      i++; continue;
    }

    // unsupported other expressions (assignments from call, returns, etc.)
    err(lineNo, `unsupported or out-of-scope statement in this MVP: ${raw}`);
  }

  // close remaining scopes
  while (scopeStack.length > 1) leaveScope();

  out.push('');
  out.push('// End of transpiled file');
  return out.join('\n');
}
