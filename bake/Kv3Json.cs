// KV3 -> JSON with depth, value count, string length and output size bounded during the walk, so a hostile tree fails
// before it costs memory. NaN / infinite floats become null, blobs {"$blob": b64}.
// ParticleBake writes each .vpcf's DATA block this way; the particle runtime (web/src/fx/particles) reads it.
using System.Globalization;
using System.Text.Json;
using ValveKeyValue;

namespace Lasers.Bake;

sealed class Kv3JsonLimitException(string message) : Exception(message);

static class Kv3Json
{
    const int MaxDepth = 64, MaxNodes = 250_000, MaxStringBytes = 64 * 1024;
    const long MaxOutputBytes = 4L * 1024 * 1024;

    public static byte[] ToUtf8(KVObject root)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            var nodes = 0;
            Write(w, root, 1, ref nodes);
            w.Flush();
            if (ms.Length > MaxOutputBytes) throw new Kv3JsonLimitException($"KV3 JSON exceeds {MaxOutputBytes} bytes");
        }
        return ms.ToArray();
    }

    static void Write(Utf8JsonWriter w, KVObject o, int depth, ref int nodes)
    {
        if (depth > MaxDepth) throw new Kv3JsonLimitException($"KV3 nests deeper than {MaxDepth}");
        if (++nodes > MaxNodes) throw new Kv3JsonLimitException($"KV3 holds more than {MaxNodes} values");
        switch (o.ValueType)
        {
            case KVValueType.Collection:
                w.WriteStartObject();
                foreach (var (k, v) in o.Children) { w.WritePropertyName(Bounded(k ?? "")); Write(w, v, depth + 1, ref nodes); }
                w.WriteEndObject();
                break;
            case KVValueType.Array:
                w.WriteStartArray();
                foreach (var v in o.Values) Write(w, v, depth + 1, ref nodes);
                w.WriteEndArray();
                break;
            case KVValueType.Null: w.WriteNullValue(); break;
            case KVValueType.Boolean: w.WriteBooleanValue(o.ToBoolean(CultureInfo.InvariantCulture)); break;
            case KVValueType.FloatingPoint or KVValueType.FloatingPoint64:
                var d = o.ToDouble(CultureInfo.InvariantCulture);
                if (double.IsFinite(d)) w.WriteNumberValue(d); else w.WriteNullValue();
                break;
            case KVValueType.UInt64: w.WriteNumberValue(o.ToUInt64(CultureInfo.InvariantCulture)); break;
            case KVValueType.Int16 or KVValueType.Int32 or KVValueType.Int64 or KVValueType.UInt16 or KVValueType.UInt32 or KVValueType.Pointer:
                w.WriteNumberValue(o.ToInt64(CultureInfo.InvariantCulture));
                break;
            case KVValueType.BinaryBlob:
                var blob = o.AsBlob();
                if (blob.Length > MaxStringBytes) throw new Kv3JsonLimitException($"KV3 blob of {blob.Length} bytes");
                w.WriteStartObject(); w.WriteBase64String("$blob", blob); w.WriteEndObject();
                break;
            default: w.WriteStringValue(Bounded(o.ToString(CultureInfo.InvariantCulture) ?? "")); break;
        }
    }

    static string Bounded(string s) => s.Length * 3 > MaxStringBytes && System.Text.Encoding.UTF8.GetByteCount(s) > MaxStringBytes
        ? throw new Kv3JsonLimitException($"KV3 string of {s.Length} chars") : s;
}
