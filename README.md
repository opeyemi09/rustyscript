# rustyscript
RustyScript = TypeScript-like language + Rust-style ownership system
# RustyScript (TypeScript MVP)

This is a TypeScript MVP for RustyScript: a TypeScript-like language with Rust-style ownership guarantees.
It compiles `.rsc` files to `.js` with a small runtime shim that enforces move/borrow rules in dev mode.

Quick start:
1. npm install
2. npm run build
3. node dist/cli.js compile examples/app.rsc
4. node examples/app.js

Next steps:
- Expand parser and IR
- Add lexical lowering into try/finally for guaranteed Drop semantics
- Implement static borrow-checker pass to remove many runtime checks
