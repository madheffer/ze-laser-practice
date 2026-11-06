// Source 1 KeyValues text (soundscripts, manifests): "key" "value" pairs and "key" { ... } blocks, // comments,
// [$PLATFORM] conditionals (skipped: they qualify the pair before them), keys repeated as often as the file has
// them (a soundscript's rndwave lists "wave" once per file). Unquoted tokens end at whitespace, quotes or braces.
// Tolerant: a malformed file yields what parsed before the fault. Read-only, data only.
using System.Text;

namespace Lasers.Bake.Source1;

sealed class KvNode
{
    public readonly string Key;
    public readonly string? Value;          // a pair's value; null for a block
    public readonly List<KvNode> Children = [];
    public KvNode(string key, string? value) { Key = key; Value = value; }

    public string? Get(string key) => Children.FirstOrDefault(c => c.Value != null && c.Key.Equals(key, StringComparison.OrdinalIgnoreCase))?.Value;
    public KvNode? Block(string key) => Children.FirstOrDefault(c => c.Value == null && c.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
}

static class KvText
{
    const int MaxDepth = 32;

    /// Every top-level entry of the text, as children of one root node.
    public static KvNode Parse(string text)
    {
        var root = new KvNode("", null);
        var tokens = Tokens(text).GetEnumerator();
        var stack = new Stack<KvNode>();
        stack.Push(root);
        string? key = null;
        while (tokens.MoveNext())
        {
            var (tok, quoted) = tokens.Current;
            if (!quoted && tok == "{")
            {
                if (key == null || stack.Count > MaxDepth) { key = null; continue; }
                var block = new KvNode(key, null);
                stack.Peek().Children.Add(block);
                stack.Push(block);
                key = null;
            }
            else if (!quoted && tok == "}")
            {
                key = null;
                if (stack.Count > 1) stack.Pop();
            }
            else if (!quoted && tok.StartsWith('[') && tok.EndsWith(']')) continue; // a conditional
            else if (key == null) key = tok;
            else { stack.Peek().Children.Add(new KvNode(key, tok)); key = null; }
        }
        return root;
    }

    static IEnumerable<(string, bool)> Tokens(string s)
    {
        var i = 0;
        while (i < s.Length)
        {
            var c = s[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '/') { while (i < s.Length && s[i] != '\n') i++; continue; }
            if (c is '{' or '}') { i++; yield return (c.ToString(), false); continue; }
            if (c == '"')
            {
                var sb = new StringBuilder();
                i++;
                while (i < s.Length && s[i] != '"' && s[i] != '\n') sb.Append(s[i++]);
                i++;
                yield return (sb.ToString(), true);
                continue;
            }
            var st = i;
            while (i < s.Length && !char.IsWhiteSpace(s[i]) && s[i] is not ('"' or '{' or '}')) i++;
            yield return (s[st..i], false);
        }
    }
}
