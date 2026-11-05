"""Read constants out of particles.dll at the addresses a decompile names (DAT_180534a20, _UNK_180534cb4, ...).

    python tools/particles/consts.py <particles.dll> 180534a20 180534cb0 ...

Prints each address as float32 x4, double and hex, so a SIMD constant (four lanes) and a scalar both read right.
Image base 0x180000000 (the default the decompile uses).
"""
import struct, sys
from pe import PE

p = PE(sys.argv[1])
for a in sys.argv[2:]:
    addr = int(a.lower().replace('dat_', '').replace('_unk_', '').replace('unk_', '').lstrip('_'), 16)
    off = p.rva2off(addr - p.base) if hasattr(p, 'rva2off') else None
    if off is None:
        # PE helper without rva2off: walk sections
        for name, va, vs, ro, rs in p.sections:
            if va <= addr - p.base < va + max(vs, rs):
                off = ro + (addr - p.base - va)
                break
    if off is None:
        print(f'{a}: not in a section'); continue
    raw = p.data[off:off + 16]
    f4 = struct.unpack('<4f', raw)
    d = struct.unpack('<d', raw[:8])[0]
    print(f'{a}: f32 {", ".join(f"{x:.9g}" for x in f4)} | f64 {d:.9g} | hex {raw.hex()}')
