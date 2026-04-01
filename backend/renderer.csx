#!/usr/bin/env dotnet-script
// renderer.csx — DotLiquid 2.0.361 render backend
// Reads a JSON render request from stdin, writes a JSON RenderResult to stdout.
// Spawned once per render by the VS Code extension.
//
// Install dotnet-script: dotnet tool install -g dotnet-script
// Direct test:
//   echo '{"template":"{% assign n = content.name %}{{ n | Upcase }}","inputJson":"{\"name\":\"Alice\"}","wrapContent":true}' | dotnet-script renderer.csx

#r "nuget: DotLiquid, 2.0.361"
#r "nuget: Newtonsoft.Json, 13.0.3"

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

// ── Types ────────────────────────────────────────────────────────────────────

class RenderRequest {
    public string Template  { get; set; } = "";
    public string InputJson { get; set; } = "{}";
    public bool WrapContent { get; set; } = true;
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

class RenderResult {
    public bool              Success      { get; set; }
    public string            Output       { get; set; } = "";
    public List<TraceVariable> Variables  { get; set; } = new();
    public List<LineMapping>  LineMappings { get; set; } = new();
    public List<RenderError>  Errors      { get; set; } = new();
    public int               RenderTimeMs { get; set; }
}

// ── Trace tag — registers a snapshot of context variables mid-render ─────────
// Injected as {% __trace__ N %} at strategic points in the instrumented template.
// The tag records all current scope variables keyed by line number.

class TraceRecord {
    public int Line { get; set; }
    public Dictionary<string, object> Scope { get; set; } = new();
}

static List<TraceRecord> _traceRecords = new();

class TraceTag : Tag {
    private int _line;

    public override void Initialize(string tagName, string markup, List<string> tokens) {
        base.Initialize(tagName, markup, tokens);
        int.TryParse(markup.Trim(), out _line);
    }

    public override void Render(Context context, TextWriter result) {
        // Snapshot the current top-level scope (assigned variables)
        var snap = new Dictionary<string, object>();
        // context.Scopes is a List<Hash> — index 0 is innermost
        foreach (var scope in context.Scopes) {
            foreach (var kv in scope) {
                if (!snap.ContainsKey(kv.Key)) {
                    snap[kv.Key] = kv.Value;
                }
            }
        }
        _traceRecords.Add(new TraceRecord { Line = _line, Scope = snap });
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

var sw = System.Diagnostics.Stopwatch.StartNew();
var result = new RenderResult();

try {
    var stdin = Console.In.ReadToEnd();
    var request = JsonConvert.DeserializeObject<RenderRequest>(stdin)
        ?? throw new Exception("Invalid request JSON");

    // Configure DotLiquid — C# naming convention matches Logic Apps
    Template.NamingConvention = new CSharpNamingConvention();

    // Register the trace tag so the parser accepts {% __trace__ N %}
    Template.RegisterTag<TraceTag>("__trace__");

    // ── Parse input JSON ──────────────────────────────────────────────────────
    JObject inputObj;
    try {
        inputObj = JObject.Parse(request.InputJson);
    } catch (Exception ex) {
        result.Errors.Add(new RenderError { Message = $"Invalid input JSON: {ex.Message}" });
        Output(result); return;
    }

    var dataDict = request.WrapContent
        ? new Dictionary<string, object> { ["content"] = JTokenToObject(inputObj) }
        : (Dictionary<string, object>)JTokenToObject(inputObj);

    var dataHash = Hash.FromDictionary(dataDict);

    // ── Pre-process template: extract assign lines + inject trace tags ────────
    var (assignLines, instrumentedTemplate) = InstrumentTemplate(request.Template);

    // ── Parse template ────────────────────────────────────────────────────────
    Template template;
    try {
        template = Template.Parse(instrumentedTemplate);
    } catch (Exception ex) {
        var (errLine, errCol) = ParsePosition(ex.Message);
        result.Errors.Add(new RenderError {
            Message = $"Parse error: {ex.Message}",
            Line = errLine, Column = errCol
        });
        Output(result); return;
    }

    // ── Render ────────────────────────────────────────────────────────────────
    string rawOutput;
    _traceRecords.Clear();
    try {
        rawOutput = template.Render(new RenderParameters(CultureInfo.InvariantCulture) {
            LocalVariables = dataHash,
            ErrorsOutputMode = ErrorsOutputMode.Rethrow
        });
    } catch (Exception ex) {
        var (errLine, errCol) = ParsePosition(ex.Message);
        result.Errors.Add(new RenderError {
            Message = $"Render error: {ex.Message}",
            Line = errLine, Column = errCol
        });
        Output(result); return;
    }

    if (template.Errors?.Count > 0) {
        foreach (var err in template.Errors) {
            var (errLine, errCol) = ParsePosition(err.Message);
            result.Errors.Add(new RenderError { Message = err.Message, Line = errLine, Column = errCol });
        }
    }

    // ── Extract variables from InstanceAssigns + trace snapshots ─────────────
    // InstanceAssigns holds variables that persisted after render (top-level assigns).
    // We also use trace snapshots to get the line number for each variable.
    var variables = new List<TraceVariable>();
    var seenVars  = new HashSet<string>();

    // Build a map: varName → line number from our static analysis
    var varLineMap = assignLines;

    // Use InstanceAssigns for the authoritative post-render values
    foreach (var kv in template.InstanceAssigns) {
        if (seenVars.Contains(kv.Key)) continue;
        seenVars.Add(kv.Key);
        varLineMap.TryGetValue(kv.Key, out int line);
        variables.Add(new TraceVariable {
            Name  = kv.Key,
            Value = FormatValue(kv.Value),
            Line  = line
        });
    }

    // Fill in any vars found in trace snapshots but not in InstanceAssigns
    // (e.g., loop-scope vars captured mid-execution)
    foreach (var rec in _traceRecords) {
        foreach (var kv in rec.Scope) {
            if (seenVars.Contains(kv.Key)) continue;
            // Skip internal/system vars
            if (kv.Key.StartsWith("__") || kv.Key == "forloop") continue;
            seenVars.Add(kv.Key);
            variables.Add(new TraceVariable {
                Name  = kv.Key,
                Value = FormatValue(kv.Value),
                Line  = rec.Line
            });
        }
    }

    // Sort by line
    variables.Sort((a, b) => a.Line.CompareTo(b.Line));

    // ── Line mappings ─────────────────────────────────────────────────────────
    // Match literal segments of each template line to their position in the output.
    var lineMappings = BuildLineMappings(request.Template, rawOutput);

    result.Success      = true;
    result.Output       = rawOutput;
    result.Variables    = variables;
    result.LineMappings = lineMappings;

} catch (Exception ex) {
    result.Errors.Add(new RenderError { Message = $"Backend error: {ex.Message}\n{ex.StackTrace}" });
}

sw.Stop();
result.RenderTimeMs = (int)sw.ElapsedMilliseconds;
Output(result);

// ── Helpers ──────────────────────────────────────────────────────────────────

static void Output(RenderResult r) => Console.Write(JsonConvert.SerializeObject(r));

/// <summary>
/// Walk the template line by line:
/// - Record assign/capture variable names and their line numbers.
/// - Inject {%- __trace__ N -%} after every assign tag so we get
///   a context snapshot at that point during render.
/// </summary>
static (Dictionary<string, int> assignLines, string instrumented) InstrumentTemplate(string template) {
    var assignLines  = new Dictionary<string, int>();
    var outLines     = new List<string>();
    var lines        = template.Split('\n');

    var assignPat  = new Regex(@"\{%-?\s*assign\s+(\w+)\s*=");
    var capturePat = new Regex(@"\{%-?\s*capture\s+(\w+)\s*-?%\}");

    for (int i = 0; i < lines.Length; i++) {
        var line   = lines[i];
        var lineNo = i + 1;
        outLines.Add(line);

        var am = assignPat.Match(line);
        if (am.Success) {
            var name = am.Groups[1].Value;
            assignLines[name] = lineNo;
            // Inject trace tag immediately after — captures updated scope
            outLines.Add($"{{%- __trace__ {lineNo} -%}}");
        }

        var cm = capturePat.Match(line);
        if (cm.Success) {
            assignLines[cm.Groups[1].Value] = lineNo;
        }
    }

    return (assignLines, string.Join('\n', outLines));
}

/// <summary>
/// For each non-tag, non-whitespace template line, find the longest literal
/// segment and locate it in the output. Returns sorted, deduplicated mappings.
/// </summary>
static List<LineMapping> BuildLineMappings(string templateText, string output) {
    var mappings   = new List<LineMapping>();
    var lines      = templateText.Split('\n');
    var searchFrom = 0;

    var tagLine = new Regex(@"^\{%-?\s*(if|else|elsif|endif|for|endfor|assign|capture" +
                             @"|endcapture|comment|endcomment|unless|endunless|case|when" +
                             @"|endcase|break|continue|__trace__)\b");
    var tagSplit = new Regex(@"\{[{%]-?.*?-?[%}]\}");

    for (int i = 0; i < lines.Length; i++) {
        var stripped = lines[i].Trim();
        if (string.IsNullOrWhiteSpace(stripped)) continue;
        if (tagLine.IsMatch(stripped))           continue;

        // Longest literal fragment on this line
        var parts   = tagSplit.Split(stripped);
        var longest = parts.Select(p => p.Trim()).OrderByDescending(p => p.Length).FirstOrDefault() ?? "";
        if (longest.Length < 2) continue;

        var idx = output.IndexOf(longest, searchFrom, StringComparison.Ordinal);
        if (idx < 0) idx = output.IndexOf(longest, StringComparison.Ordinal);
        if (idx < 0) continue;

        var end = output.IndexOf('\n', idx + longest.Length);
        if (end < 0) end = output.Length;

        mappings.Add(new LineMapping {
            TemplateLine = i + 1,
            OutputStart  = idx,
            OutputEnd    = end,
            OutputText   = output.Substring(idx, end - idx)
        });

        searchFrom = Math.Min(end, output.Length);
    }

    return mappings;
}

static string FormatValue(object? v) {
    if (v is null)                                     return "null";
    if (v is string s)                                 return s;
    if (v is IEnumerable<object> list)                 return $"[{string.Join(", ", list.Take(5).Select(FormatValue))}]";
    if (v is IDictionary<string, object> dict)         return $"{{{string.Join(", ", dict.Take(3).Select(kv => $"{kv.Key}: {FormatValue(kv.Value)}"))}}}";
    return v.ToString() ?? "";
}

static object JTokenToObject(JToken token) => token.Type switch {
    JTokenType.Object  => ((JObject)token).Properties()
                            .ToDictionary(p => p.Name, p => JTokenToObject(p.Value)),
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
    return (int.Parse(m.Groups[1].Value),
            m.Groups[2].Success ? int.Parse(m.Groups[2].Value) : null);
}
