// three.js shader helpers shared by the viewmodel (weapons/fp) and the particle renderers (fx/particles).

/// Add a shader patch WITHOUT evicting one already there: three has one onBeforeCompile slot, and the bone
/// highlight and the CS2 material system (disjoint anchors) both want it; assigning silently deleted one.
/// customProgramCacheKey is chained too, or materials differing only in patches would share one program.
export function chainBeforeCompile(mat, fn, keyPart) {
  // Read the old key BEFORE swapping, and only if the material has its own: three's prototype default returns
  // onBeforeCompile.toString(), which after the swap bakes this wrapper's source into every key.
  let prevKey = '';
  if (Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey')) {
    try { prevKey = mat.customProgramCacheKey() || ''; } catch { prevKey = ''; }
  }
  const prev = typeof mat.onBeforeCompile === 'function' ? mat.onBeforeCompile : null;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    fn.call(this, shader, renderer);
  };
  mat.customProgramCacheKey = () => (prevKey ? `${prevKey}|${keyPart}` : keyPart);
}
