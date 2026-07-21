// Minimal runtime shim for RustyScript
// Exported for CommonJS compatibility (we emit require('./rs_runtime'))
const META = new WeakMap<object, { moved: boolean, borrowCount: number, mutBorrow: boolean }>();

function ensureMeta(box: any) {
  if (!META.has(box)) {
    META.set(box, { moved: false, borrowCount: 0, mutBorrow: false });
  }
  return META.get(box)!;
}

export function wrap(val: any) {
  if (val && typeof val === 'object' && (val as any).__rs_wrapped) return val;
  const box = { __rs_wrapped: true, __rs_data: val };
  ensureMeta(box);
  return box;
}

export function move(box: any) {
  if (!box || !(box as any).__rs_wrapped) {
    const b = wrap(box);
    const meta = ensureMeta(b);
    if (meta.moved) throw new Error('use after move');
    if (meta.borrowCount > 0 || meta.mutBorrow) throw new Error('cannot move while borrowed');
    meta.moved = true;
    return b;
  }
  const meta = ensureMeta(box);
  if (meta.moved) throw new Error('use after move');
  if (meta.borrowCount > 0 || meta.mutBorrow) throw new Error('cannot move while borrowed');
  meta.moved = true;
  return box;
}

export function use(box: any) {
  if (!box || !(box as any).__rs_wrapped) return box;
  const meta = ensureMeta(box);
  if (meta.moved) throw new Error('use after move');
  return (box as any).__rs_data;
}

export function borrow(box: any) {
  if (!box || !(box as any).__rs_wrapped) throw new Error('cannot borrow non-wrapped value');
  const meta = ensureMeta(box);
  if (meta.moved) throw new Error('borrow after move');
  if (meta.mutBorrow) throw new Error('cannot create immutable borrow while mutable borrow exists');
  meta.borrowCount = meta.borrowCount + 1;
  return box;
}

export function release(box: any) {
  if (!box || !(box as any).__rs_wrapped) throw new Error('release of non-wrapped value');
  const meta = ensureMeta(box);
  if (meta.borrowCount === 0) throw new Error('release called without matching borrow');
  meta.borrowCount = meta.borrowCount - 1;
}

export function borrowMut(box: any) {
  if (!box || !(box as any).__rs_wrapped) throw new Error('cannot borrow_mut non-wrapped value');
  const meta = ensureMeta(box);
  if (meta.moved) throw new Error('borrow_mut after move');
  if (meta.borrowCount > 0 || meta.mutBorrow) throw new Error('cannot create mutable borrow while other borrows exist');
  meta.mutBorrow = true;
  return box;
}

export function releaseMut(box: any) {
  if (!box || !(box as any).__rs_wrapped) throw new Error('release_mut of non-wrapped value');
  const meta = ensureMeta(box);
  if (!meta.mutBorrow) throw new Error('release_mut called without matching borrow_mut');
  meta.mutBorrow = false;
}

// CommonJS wrapper for require()
module.exports = {
  wrap, move, use, borrow, release, borrowMut, releaseMut
};
