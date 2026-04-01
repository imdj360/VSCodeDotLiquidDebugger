// Program.cs — DotLiquid renderer, NDJSON stdin/stdout loop
// Protocol: one JSON request per line → one JSON response per line
// Run: dotnet DotLiquidRenderer.dll (stays alive, reads until EOF)

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using DotLiquid;
using DotLiquid.NamingConventions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;

// ── One-time DotLiquid setup ──────────────────────────────────────────────────
Template.NamingConvention = new CSharpNamingConvention();
Template.RegisterTag<TraceTag>("__trace__");

// ── NDJSON loop ───────────────────────────────────────────────────────────────
string? line;
while ((line = Console.ReadLine()) != null) {
    if (string.IsNullOrWhiteSpace(line)) continue;
    var res = new RenderResult();
    var sw  = System.Diagnostics.Stopwatch.StartNew();
    try {
        var req = JsonConvert.DeserializeObject<RenderRequest>(line, new JsonSerializerSettings {
            ContractResolver = new CamelCasePropertyNamesContractResolver()
        })
            ?? throw new Exception("Invalid request JSON");
        res.Id = req.Id;
        Render(req, res);
    } catch (Exception ex) {
        res.Errors.Add(new RenderError { Message = $"Backend error: {ex.Message}" });
    }
    sw.Stop();
    res.RenderTimeMs = (int)sw.ElapsedMilliseconds;
    try {
        Console.WriteLine(JsonConvert.SerializeObject(res, new JsonSerializerSettings {
            ContractResolver = new CamelCasePropertyNamesContractResolver()
        }));
    } catch {
        Console.WriteLine($"{{\"id\":{res.Id},\"success\":false,\"output\":\"\",\"variables\":[],\"lineMappings\":[],\"errors\":[{{\"message\":\"Failed to serialize response\"}}],\"renderTimeMs\":{res.RenderTimeMs}}}");
    }
}

// ── Render ────────────────────────────────────────────────────────────────────
static void Render(RenderRequest req, RenderResult res) {
    JObject inputObj;
    try {
        inputObj = JObject.Parse(req.InputJson);
    } catch (Exception ex) {
        var (el, ec) = ParsePosition(ex.Message);
        res.Errors.Add(new RenderError { Message = $"Input JSON is invalid: {ex.Message}", Line = el, Column = ec });
        return;
    }

    var dataDict = req.WrapContent
        ? new Dictionary<string, object> { ["content"] = JTokenToObject(inputObj) }
        : (Dictionary<string, object>)JTokenToObject(inputObj);
    var dataHash = Hash.FromDictionary(dataDict);

    var (assignLines, instrumented) = InstrumentTemplate(req.Template);

    Template template;
    try {
        template = Template.Parse(instrumented);
    } catch (Exception ex) {
        var (el, ec) = ParsePosition(ex.Message);
        res.Errors.Add(new RenderError { Message = $"Parse error: {ex.Message}", Line = el, Column = ec });
        return;
    }

    TraceTag.Records.Clear();
    string rawOutput;
    try {
        rawOutput = template.Render(new RenderParameters(CultureInfo.InvariantCulture) {
            LocalVariables    = dataHash,
            ErrorsOutputMode  = ErrorsOutputMode.Rethrow
        });
    } catch (Exception ex) {
        var (el, ec) = ParsePosition(ex.Message);
        res.Errors.Add(new RenderError { Message = $"Render error: {ex.Message}", Line = el, Column = ec });
        return;
    }

    if (template.Errors?.Count > 0) {
        foreach (var err in template.Errors) {
            var (el, ec) = ParsePosition(err.Message);
            res.Errors.Add(new RenderError { Message = err.Message, Line = el, Column = ec });
        }
    }

    // Variables — InstanceAssigns for post-render values, TraceTag for loop-scope
    var variables = new List<TraceVariable>();
    var seenVars  = new HashSet<string>();

    foreach (var kv in template.InstanceAssigns) {
        if (seenVars.Contains(kv.Key)) continue;
        seenVars.Add(kv.Key);
        assignLines.TryGetValue(kv.Key, out int varLine);
        variables.Add(new TraceVariable { Name = kv.Key, Value = FormatValue(kv.Value), Line = varLine });
    }
    foreach (var rec in TraceTag.Records) {
        foreach (var kv in rec.Scope) {
            if (seenVars.Contains(kv.Key)) continue;
            if (kv.Key.StartsWith("__") || kv.Key == "forloop") continue;
            seenVars.Add(kv.Key);
            variables.Add(new TraceVariable { Name = kv.Key, Value = FormatValue(kv.Value), Line = rec.Line });
        }
    }
    variables.Sort((a, b) => a.Line.CompareTo(b.Line));

    res.Success      = true;
    res.Output       = rawOutput;
    res.Variables    = variables;
    res.LineMappings = BuildLineMappings(req.Template, rawOutput);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
static (Dictionary<string, int> assignLines, string instrumented) InstrumentTemplate(string template) {
    var assignLines = new Dictionary<string, int>();
    var outLines    = new List<string>();
    var lines       = template.Split('\n');
    var assignPat   = new Regex(@"\{%-?\s*assign\s+(\w+)\s*=");
    var capturePat  = new Regex(@"\{%-?\s*capture\s+(\w+)\s*-?%\}");

    for (int i = 0; i < lines.Length; i++) {
        var ln = lines[i];
        outLines.Add(ln);
        var am = assignPat.Match(ln);
        if (am.Success) {
            var name = am.Groups[1].Value;
            assignLines[name] = i + 1;
            outLines.Add($"{{%- __trace__ {i + 1} -%}}");
        }
        var cm = capturePat.Match(ln);
        if (cm.Success) { assignLines[cm.Groups[1].Value] = i + 1; }
    }
    return (assignLines, string.Join('\n', outLines));
}

static List<LineMapping> BuildLineMappings(string templateText, string output) {
    var mappings   = new List<LineMapping>();
    var lines      = templateText.Split('\n');
    var searchFrom = 0;
    var tagLine    = new Regex(@"^\{%-?\s*(if|else|elsif|endif|for|endfor|assign|capture" +
                                @"|endcapture|comment|endcomment|unless|endunless|case|when" +
                                @"|endcase|break|continue|__trace__)\b");
    var tagSplit   = new Regex(@"\{[{%]-?.*?-?[%}]\}");

    for (int i = 0; i < lines.Length; i++) {
        var stripped = lines[i].Trim();
        if (string.IsNullOrWhiteSpace(stripped) || tagLine.IsMatch(stripped)) continue;
        var parts   = tagSplit.Split(stripped);
        var longest = parts.Select(p => p.Trim()).OrderByDescending(p => p.Length).FirstOrDefault() ?? "";
        if (longest.Length < 2) continue;
        var idx = output.IndexOf(longest, searchFrom, StringComparison.Ordinal);
        if (idx < 0) idx = output.IndexOf(longest, StringComparison.Ordinal);
        if (idx < 0) continue;
        var end = output.IndexOf('\n', idx + longest.Length);
        if (end < 0) end = output.Length;
        mappings.Add(new LineMapping { TemplateLine = i + 1, OutputStart = idx, OutputEnd = end, OutputText = output[idx..end] });
        searchFrom = Math.Min(end, output.Length);
    }
    return mappings;
}

static string FormatValue(object? v) {
    if (v is null)                             return "null";
    if (v is string s)                         return s;
    if (v is IEnumerable<object> list)         return $"[{string.Join(", ", list.Take(5).Select(FormatValue))}]";
    if (v is IDictionary<string, object> dict) return $"{{{string.Join(", ", dict.Take(3).Select(kv => $"{kv.Key}: {FormatValue(kv.Value)}"))}}}";
    return v.ToString() ?? "";
}

static object JTokenToObject(JToken token) => token.Type switch {
    JTokenType.Object  => ((JObject)token).Properties().ToDictionary(p => p.Name, p => JTokenToObject(p.Value)),
    JTokenType.Array   => ((JArray)token).Select(JTokenToObject).ToList<object>(),
    JTokenType.Integer => token.Value<long>(),
    JTokenType.Float   => token.Value<double>(),
    JTokenType.Boolean => (object)token.Value<bool>(),
    JTokenType.Null    => (object)"",
    _                  => (object)(token.Value<string>() ?? "")
};

static (int? line, int? col) ParsePosition(string msg) {
    var m = Regex.Match(msg, @"[Ll]ine[:\s]+(\d+)(?:[,\s]+[Cc]ol(?:umn)?[:\s]+(\d+))?");
    if (!m.Success) return (null, null);
    return (int.Parse(m.Groups[1].Value), m.Groups[2].Success ? int.Parse(m.Groups[2].Value) : null);
}

// ── Types ─────────────────────────────────────────────────────────────────────
class RenderRequest {
    public int    Id          { get; set; }
    public string Template    { get; set; } = "";
    public string InputJson   { get; set; } = "{}";
    public bool   WrapContent { get; set; } = true;
}

class RenderResult {
    public int                 Id           { get; set; }
    public bool                Success      { get; set; }
    public string              Output       { get; set; } = "";
    public List<TraceVariable> Variables    { get; set; } = new();
    public List<LineMapping>   LineMappings { get; set; } = new();
    public List<RenderError>   Errors       { get; set; } = new();
    public int                 RenderTimeMs { get; set; }
}

class TraceVariable {
    public string Name  { get; set; } = "";
    public string Value { get; set; } = "";
    public int    Line  { get; set; }
}

class LineMapping {
    public int    TemplateLine { get; set; }
    public int    OutputStart  { get; set; }
    public int    OutputEnd    { get; set; }
    public string OutputText   { get; set; } = "";
}

class RenderError {
    public string Message { get; set; } = "";
    public int?   Line    { get; set; }
    public int?   Column  { get; set; }
}

class TraceRecord {
    public int                        Line  { get; set; }
    public Dictionary<string, object> Scope { get; set; } = new();
}

class TraceTag : Tag {
    // INVARIANT: The NDJSON loop is single-threaded (Console.ReadLine blocks).
    // Records is cleared before each render and read after — this is safe only
    // because requests are processed sequentially. Do not add async/parallel
    // request handling without replacing this with instance-scoped state.
    public static List<TraceRecord> Records { get; } = new();

    private int _line;

    public override void Initialize(string tagName, string markup, List<string> tokens) {
        base.Initialize(tagName, markup, tokens);
        int.TryParse(markup.Trim(), out _line);
    }

    public override void Render(Context context, TextWriter result) {
        var snap = new Dictionary<string, object>();
        foreach (var scope in context.Scopes) {
            foreach (var kv in scope) {
                if (!snap.ContainsKey(kv.Key)) snap[kv.Key] = kv.Value;
            }
        }
        Records.Add(new TraceRecord { Line = _line, Scope = snap });
    }
}
