// dotnet run -c Release --project rubikon/tests/ShimCheck: every SseShim operation against the real SSE instruction on
// random lanes (plus NaN, +-0, +-inf, denormals), compared as bits. Exits 1 on the first difference.
using System.Runtime.Intrinsics;
using X = System.Runtime.Intrinsics.X86;
using S = Source2.Compiler.Simulation;

if (!X.Sse41.IsSupported) { Console.WriteLine("needs SSE4.1"); return 2; }
var rng = new Random(1234);
float[] special = [float.NaN, -float.NaN, 0f, -0f, float.PositiveInfinity, float.NegativeInfinity, 1e-40f, -1e-40f, float.Epsilon, float.MaxValue, 1f, -1f];
float Lane() => rng.Next(6) == 0 ? special[rng.Next(special.Length)] : BitConverter.Int32BitsToSingle(rng.Next(int.MinValue, int.MaxValue));
Vector128<float> V() => Vector128.Create(Lane(), Lane(), Lane(), Lane());
bool Same(Vector128<float> a, Vector128<float> b) => a.AsUInt32().Equals(b.AsUInt32());
int bad = 0;
void Check(string op, Vector128<float> want, Vector128<float> got, Vector128<float> a, Vector128<float> b)
{
    if (Same(want, got) || bad++ > 10) return;
    Console.WriteLine($"{op}: a={a} b={b} sse={want.AsUInt32()} shim={got.AsUInt32()}");
}
const int N = 2_000_000;
for (var i = 0; i < N; i++)
{
    var a = V(); var b = V(); var imm = (byte)rng.Next(256);
    Check("add", X.Sse.Add(a, b), S.Sse.Add(a, b), a, b);
    Check("sub", X.Sse.Subtract(a, b), S.Sse.Subtract(a, b), a, b);
    Check("mul", X.Sse.Multiply(a, b), S.Sse.Multiply(a, b), a, b);
    Check("div", X.Sse.Divide(a, b), S.Sse.Divide(a, b), a, b);
    Check("sqrt", X.Sse.Sqrt(a), S.Sse.Sqrt(a), a, b);
    Check("and", X.Sse.And(a, b), S.Sse.And(a, b), a, b);
    Check("or", X.Sse.Or(a, b), S.Sse.Or(a, b), a, b);
    Check("min", X.Sse.Min(a, b), S.Sse.Min(a, b), a, b);
    Check("max", X.Sse.Max(a, b), S.Sse.Max(a, b), a, b);
    Check("cmplt", X.Sse.CompareLessThan(a, b), S.Sse.CompareLessThan(a, b), a, b);
    Check("cmple", X.Sse.CompareLessThanOrEqual(a, b), S.Sse.CompareLessThanOrEqual(a, b), a, b);
    if (X.Sse.MoveMask(a) != S.Sse.MoveMask(a) && bad++ < 10) Console.WriteLine($"movemask: {a}");
    Check($"shuffle {imm:x2}", X.Sse.Shuffle(a, b, imm), S.Sse.Shuffle(a, b, imm), a, b);
    Check("unpacklo", X.Sse.UnpackLow(a, b), S.Sse.UnpackLow(a, b), a, b);
    Check("unpackhi", X.Sse.UnpackHigh(a, b), S.Sse.UnpackHigh(a, b), a, b);
    var m = V();
    Check("blendv", X.Sse41.BlendVariable(a, b, m), S.Sse41.BlendVariable(a, b, m), a, m);
}
Console.WriteLine(bad == 0 ? $"all {N} x 16 operations match SSE bit for bit" : $"{bad} differences");
return bad == 0 ? 0 : 1;
