using System.Runtime.CompilerServices;
using System.Runtime.Intrinsics;

namespace Source2.Compiler.Simulation;

// The SSE operations BoxCast.cs and MeshSweep.cs are written with (lane for lane as vphysics2 does them), on the portable
// Vector128 API, so they run where System.Runtime.Intrinsics.X86 does not: WebAssembly. Each one gives the bits the x86
// instruction gives (Intel SDM): addps / subps / mulps / divps / sqrtps are IEEE single operations per lane; minps and
// maxps return the second operand when either is NaN or both are zero (a < b ? a : b, a > b ? a : b); cmpltps / cmpleps
// are ordered (NaN compares false) and set all bits of a true lane; movmskps packs the lanes' sign bits; shufps takes
// lanes 0-1 from the first operand and 2-3 from the second, two bits of imm8 each; unpcklps / unpckhps interleave the
// low / high halves; blendvps picks the second operand where the mask's sign bit is set.
// The two files keep source2-compiler's text; only their `using System.Runtime.Intrinsics.X86;` is gone, so `Sse` and
// `Sse41` resolve here.
internal static class Sse
{
    [MethodImpl(MethodImplOptions.AggressiveInlining)] public static Vector128<float> Add(Vector128<float> a, Vector128<float> b) => a + b;
    [MethodImpl(MethodImplOptions.AggressiveInlining)] public static Vector128<float> Subtract(Vector128<float> a, Vector128<float> b) => a - b;
    [MethodImpl(MethodImplOptions.AggressiveInlining)] public static Vector128<float> Multiply(Vector128<float> a, Vector128<float> b) => a * b;
    [MethodImpl(MethodImplOptions.AggressiveInlining)] public static Vector128<float> Divide(Vector128<float> a, Vector128<float> b) => a / b;
    [MethodImpl(MethodImplOptions.AggressiveInlining)] public static Vector128<float> Sqrt(Vector128<float> a) => Vector128.Sqrt(a);
    [MethodImpl(MethodImplOptions.AggressiveInlining)] public static Vector128<float> And(Vector128<float> a, Vector128<float> b) => a & b;
    [MethodImpl(MethodImplOptions.AggressiveInlining)] public static Vector128<float> Or(Vector128<float> a, Vector128<float> b) => a | b;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Vector128<float> Min(Vector128<float> a, Vector128<float> b) => Vector128.ConditionalSelect(Vector128.LessThan(a, b), a, b);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Vector128<float> Max(Vector128<float> a, Vector128<float> b) => Vector128.ConditionalSelect(Vector128.GreaterThan(a, b), a, b);

    [MethodImpl(MethodImplOptions.AggressiveInlining)] public static Vector128<float> CompareLessThan(Vector128<float> a, Vector128<float> b) => Vector128.LessThan(a, b);
    [MethodImpl(MethodImplOptions.AggressiveInlining)] public static Vector128<float> CompareLessThanOrEqual(Vector128<float> a, Vector128<float> b) => Vector128.LessThanOrEqual(a, b);
    [MethodImpl(MethodImplOptions.AggressiveInlining)] public static int MoveMask(Vector128<float> a) => (int)a.ExtractMostSignificantBits();

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Vector128<float> Shuffle(Vector128<float> a, Vector128<float> b, byte imm)
        => Vector128.Create(a.GetElement(imm & 3), a.GetElement((imm >> 2) & 3), b.GetElement((imm >> 4) & 3), b.GetElement((imm >> 6) & 3));

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Vector128<float> UnpackLow(Vector128<float> a, Vector128<float> b) => Vector128.Create(a.GetElement(0), b.GetElement(0), a.GetElement(1), b.GetElement(1));

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Vector128<float> UnpackHigh(Vector128<float> a, Vector128<float> b) => Vector128.Create(a.GetElement(2), b.GetElement(2), a.GetElement(3), b.GetElement(3));
}

internal static class Sse41
{
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Vector128<float> BlendVariable(Vector128<float> a, Vector128<float> b, Vector128<float> mask)
        => Vector128.ConditionalSelect(Vector128.ShiftRightArithmetic(mask.AsInt32(), 31).AsSingle(), b, a);
}
