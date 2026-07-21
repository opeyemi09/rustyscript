// Demo: RustyScript v0 (TypeScript MVP)
// uses explicit move(...) and borrow syntax (& / &mut)

let x: string = "hello";
let y = move(x);       // explicit move x -> y
print(y);
print(x);              // compile-time error: use after move (static pass)

{
  let a = { x: 1 };
  let r = &a;          // immutable borrow
  print(r.x);
  // r released automatically at block end
}

{
  let a = { x: 2 };
  let m = &mut a;      // mutable borrow
  print(m.x);
  // m released at block end
}
