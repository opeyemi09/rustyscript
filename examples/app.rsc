// Functions demo: ownership + borrows across calls
// Note: functions are void in this MVP. Parameters:
//  - owned param: specify type normally (caller must pass move(x) or a literal)
//  - immutable borrow: param: &Type  (caller passes &x)
//  - mutable borrow: param: &mut Type (caller passes &mut x)

function greet(name: string) {
  // name is owned inside function (local owner)
  print(name);
}

function inspectBorrow(a: & { x: number }) {
  // a is an immutable borrow; cannot modify the owner
  print(a.x);
}

function incMut(a: &mut { x: number }) {
  // a is a mutable borrow; we could mutate via __rs.use(a).x = ...
  // (mutation syntax not formalized in this MVP)
  print(a.x);
}

let s = "Alice";
greet(move(s));   // move s into greet
// print(s);      // compile-time error: use after move

let obj = { x: 10 };
inspectBorrow(&obj); // ok: immutable borrow
incMut(&mut obj);    // ok: mutable borrow (no other borrows present)
