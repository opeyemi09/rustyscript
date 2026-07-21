// Demo: RustyScript v0 (TypeScript MVP)
// supports let, moves, borrows (& / &mut), blocks { }

let x = "hello";
let y = x;       // move x -> y
print(y);
print(x);       // use-after-move -> runtime error (dev mode)

{
  let a = { x: 1 };
  let r = &a;     // immutable borrow
  print(r.x);
  // r is released automatically at end of block
}

{
  let a = { x: 2 };
  let m = &mut a; // mutable borrow
  print(m.x);
  // mutation could be modeled by directly accessing __rs.use(m) in expanded syntax
}
