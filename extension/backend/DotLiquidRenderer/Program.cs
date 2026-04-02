// Program.cs — DotLiquid renderer, NDJSON stdin/stdout loop
// Protocol: one JSON request per line → one JSON response per line
// Run: dotnet DotLiquidRenderer.dll (stays alive, reads until EOF)

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
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
    var res = new RenderResult { Id = TryExtractRequestId(line) ?? 0 };
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
        Console.WriteLine($"{{\"id\":{res.Id},\"success\":false,\"output\":\"\",\"variables\":[],\"lineMappings\":[],\"steps\":[],\"errors\":[{{\"message\":\"Failed to serialize response\"}}],\"renderTimeMs\":{res.RenderTimeMs}}}");
    }
}

// ── Render ────────────────────────────────────────────────────────────────────
static void Render(RenderRequest req, RenderResult res) {
    JToken inputToken;
    try {
        inputToken = JToken.Parse(req.InputJson);
        if (inputToken.Type != JTokenType.Object && inputToken.Type != JTokenType.Array) {
            res.Errors.Add(new RenderError { Message = "Input JSON must be an object or array at the root." });
            return;
        }
    } catch (Exception ex) {
        var (el, ec) = ParsePosition(ex.Message);
        res.Errors.Add(new RenderError { Message = $"Input JSON is invalid: {ex.Message}", Line = el, Column = ec });
        return;
    }

    Dictionary<string, object> dataDict;
    if (req.WrapContent) {
        dataDict = new Dictionary<string, object> { ["content"] = JTokenToObject(inputToken) };
    } else if (inputToken.Type == JTokenType.Object) {
        dataDict = (Dictionary<string, object>)JTokenToObject(inputToken);
    } else {
        // Root array without wrapContent — expose as "items"
        dataDict = new Dictionary<string, object> { ["items"] = JTokenToObject(inputToken) };
    }
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
    var tracingWriter = new TracingWriter();
    TraceTag.CurrentWriter = tracingWriter;
    string rawOutput;
    try {
        template.Render(tracingWriter, new RenderParameters(CultureInfo.InvariantCulture) {
            LocalVariables    = dataHash,
            ErrorsOutputMode  = ErrorsOutputMode.Rethrow
        });
        rawOutput = tracingWriter.ToString();
    } catch (Exception ex) {
        var (el, ec) = ParsePosition(ex.Message);
        res.Errors.Add(new RenderError { Message = $"Render error: {ex.Message}", Line = el, Column = ec });
        return;
    } finally {
        TraceTag.CurrentWriter = null;
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

    var lineMappings = BuildLineMappings(req.Template, rawOutput);

    // Build trace steps sequentially so each assign step can evaluate its filter
    // chain using the raw scope from the *previous* checkpoint (before the assign).
    // Seed with dataDict so that the very first assign can resolve template variables
    // such as content.n (otherwise prevRawScope would be empty and all variable refs
    // fall back to blank values, making numeric filters read as 0).
    var traceSteps = new List<StepRecord>();
    var templateLines = req.Template.Split('\n');
    var prevRawScope = dataDict;
    foreach (var cp in tracingWriter.Checkpoints) {
        var stepType = string.IsNullOrEmpty(cp.StepType) ? "assign" : cp.StepType;
        traceSteps.Add(new StepRecord {
            Line        = cp.Line,
            StepType    = stepType,
            Condition   = string.IsNullOrEmpty(cp.Condition) ? null : cp.Condition,
            OutputEnd   = cp.OutputLength,
            Variables   = cp.Scope
                .Where(kv => !kv.Key.StartsWith("__") && kv.Key != "forloop")
                .ToDictionary(kv => kv.Key, kv => FormatValue(kv.Value)),
            FilterCalls = stepType == "assign"
                ? FilterReplay.BuildFilterCalls(templateLines, cp.Line, prevRawScope)
                : new List<FilterCall>()
        });
        prevRawScope = cp.Scope;
    }

    // Output steps — one per lineMappings entry so loop bodies step per-iteration.
    // Variables carry forward the final trace snapshot (all assigns resolved).
    var finalVars = traceSteps.LastOrDefault()?.Variables ?? new Dictionary<string, string>();
    var outputSteps = lineMappings
        .OrderBy(m => m.OutputStart)
        .Select(m => new StepRecord {
            Line      = m.TemplateLine,
            OutputEnd = m.OutputEnd,
            Variables = finalVars
        });

    var steps = traceSteps.Concat(outputSteps).OrderBy(s => s.OutputEnd).ToList();
    // Clamp last step to full output so closing tokens (too short to map) are never dimmed
    if (steps.Count > 0 && steps[^1].OutputEnd < rawOutput.Length) {
        var last = steps[^1];
        steps[^1] = new StepRecord { Line = last.Line, OutputEnd = rawOutput.Length, StepType = last.StepType, Condition = last.Condition, Variables = last.Variables, FilterCalls = last.FilterCalls };
    }

    res.Success      = true;
    res.Output       = rawOutput;
    res.Variables    = variables;
    res.LineMappings = lineMappings;
    res.Steps        = steps;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
static (Dictionary<string, int> assignLines, string instrumented) InstrumentTemplate(string template) {
    var assignLines = new Dictionary<string, int>();
    var outLines    = new List<string>();
    var lines       = template.Split('\n');
    var assignPat   = new Regex(@"\{%-?\s*assign\s+(\w+)\s*=");
    var capturePat  = new Regex(@"\{%-?\s*capture\s+(\w+)\s*-?%\}");
    var forPat      = new Regex(@"\{%-?\s*for\s+(\w+\s+in\s+\S+)");
    var ifPat       = new Regex(@"\{%-?\s*if\s+(.+?)\s*-?%\}");
    var elsifPat    = new Regex(@"\{%-?\s*elsif\s+(.+?)\s*-?%\}");
    var elsePat     = new Regex(@"\{%-?\s*else\s*-?%\}");
    var unlessPat   = new Regex(@"\{%-?\s*unless\s+(.+?)\s*-?%\}");
    var whenPat     = new Regex(@"\{%-?\s*when\s+(.+?)\s*-?%\}");

    for (int i = 0; i < lines.Length; i++) {
        var ln  = lines[i];
        var num = i + 1;
        outLines.Add(ln);

        var am = assignPat.Match(ln);
        if (am.Success) {
            var name = am.Groups[1].Value;
            assignLines[name] = num;
            outLines.Add($"{{%- __trace__ {num} assign -%}}");
        }
        var cm = capturePat.Match(ln);
        if (cm.Success) { assignLines[cm.Groups[1].Value] = num; }

        // for — fires each iteration; includes loop expression for context
        var fm = forPat.Match(ln);
        if (fm.Success) {
            outLines.Add($"{{%- __trace__ {num} for {fm.Groups[1].Value.Trim()} -%}}");
        }

        // condition branches — trace fires only if that branch executes
        var ifm = ifPat.Match(ln);
        if (ifm.Success)     { outLines.Add($"{{%- __trace__ {num} if {ifm.Groups[1].Value.Trim()} -%}}"); }

        var em = elsifPat.Match(ln);
        if (em.Success)      { outLines.Add($"{{%- __trace__ {num} elsif {em.Groups[1].Value.Trim()} -%}}"); }

        if (elsePat.IsMatch(ln)) {
                               outLines.Add($"{{%- __trace__ {num} else -%}}"); }

        var um = unlessPat.Match(ln);
        if (um.Success)      { outLines.Add($"{{%- __trace__ {num} unless {um.Groups[1].Value.Trim()} -%}}"); }

        var wm = whenPat.Match(ln);
        if (wm.Success)      { outLines.Add($"{{%- __trace__ {num} when {wm.Groups[1].Value.Trim()} -%}}"); }
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

        // Claim additional occurrences (loop iterations) only from the LAST template
        // line that shares this fragment.  Earlier lines with the same text claim one
        // occurrence each via the outer forward-scan.  The last line then picks up all
        // remaining occurrences, which are loop iterations of that line.
        // Example: "hello / {% for %} / hello / {% endfor %}"
        //   → line 1 claims first hello, line 3 (last with "hello") claims all remaining.
        // Example: "alpha / alpha" (two static identical lines, no loop)
        //   → line 1 claims first alpha, line 2 (last) claims second — inner while finds none.
        if (IsLastLineWithFragment(lines, i, longest, tagLine, tagSplit)) {
            var scanFrom = searchFrom;
            while (scanFrom < output.Length) {
                var nIdx = output.IndexOf(longest, scanFrom, StringComparison.Ordinal);
                if (nIdx < 0) break;
                var nEnd = output.IndexOf('\n', nIdx + longest.Length);
                if (nEnd < 0) nEnd = output.Length;
                mappings.Add(new LineMapping { TemplateLine = i + 1, OutputStart = nIdx, OutputEnd = nEnd, OutputText = output[nIdx..nEnd] });
                scanFrom = Math.Min(nEnd + 1, output.Length);
            }
        }
    }
    mappings.Sort((a, b) => a.OutputStart.CompareTo(b.OutputStart));
    return mappings;
}

// Returns true when no non-tag template line AFTER thisIndex produces the same fragment.
// Earlier lines with the same fragment each claim one occurrence and stop; the last line
// claims all remaining occurrences (loop iterations).
static bool IsLastLineWithFragment(string[] lines, int thisIndex, string fragment, Regex tagLine, Regex tagSplit) {
    for (int j = thisIndex + 1; j < lines.Length; j++) {
        var s = lines[j].Trim();
        if (string.IsNullOrWhiteSpace(s) || tagLine.IsMatch(s)) continue;
        var longest = tagSplit.Split(s).Select(p => p.Trim()).OrderByDescending(p => p.Length).FirstOrDefault() ?? "";
        if (longest == fragment) return false;
    }
    return true;
}

static string FormatValue(object? v) {
    if (v is null)                             return "null";
    if (v is string s)                         return s;
    if (v is IEnumerable<object> list) {
        var items = list as IList<object> ?? list.ToList();
        var preview = items.Take(5).Select(FormatValue).ToList();
        var more = items.Count > preview.Count ? $", ... (+{items.Count - preview.Count})" : "";
        return $"[{string.Join(", ", preview)}{more}]";
    }
    if (v is IDictionary<string, object> dict) {
        var entries = dict as ICollection<KeyValuePair<string, object>> ?? dict.ToList();
        var preview = entries.Take(3).Select(kv => $"{kv.Key}: {FormatValue(kv.Value)}").ToList();
        var more = entries.Count > preview.Count ? $", ... (+{entries.Count - preview.Count})" : "";
        return $"{{{string.Join(", ", preview)}{more}}}";
    }
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

static int? TryExtractRequestId(string jsonLine) {
    var m = Regex.Match(jsonLine, "\"id\"\\s*:\\s*(\\d+)");
    return m.Success ? int.Parse(m.Groups[1].Value) : null;
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
    public List<StepRecord>    Steps        { get; set; } = new();
    public List<RenderError>   Errors       { get; set; } = new();
    public int                 RenderTimeMs { get; set; }
}

class StepRecord {
    public int                        Line        { get; set; }
    public int                        OutputEnd   { get; set; }
    public string                     StepType    { get; set; } = "output";
    public string?                    Condition   { get; set; }
    public Dictionary<string, string> Variables   { get; set; } = new();
    public List<FilterCall>           FilterCalls { get; set; } = new();
}

class FilterCall {
    public string  Name   { get; set; } = "";
    public string  Input  { get; set; } = "";
    public string? Arg    { get; set; }
    public string  Output { get; set; } = "";
}

class TracingWriter : StringWriter {
    public record Checkpoint(int OutputLength, int Line, string StepType, string? Condition, Dictionary<string, object> Scope);
    public List<Checkpoint> Checkpoints { get; } = new();
    public TracingWriter() : base(new StringBuilder()) { }
    public void AddCheckpoint(int line, string stepType, string? condition, Dictionary<string, object> scope) =>
        Checkpoints.Add(new Checkpoint(GetStringBuilder().Length, line, stepType, condition, scope));
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
    // Records and CurrentWriter are cleared/set before each render — safe only
    // because requests are processed sequentially. Do not parallelize.
    // Records feed the Variables sidebar; Writer checkpoints feed the step timeline.
    public static List<TraceRecord> Records       { get; } = new();
    public static TracingWriter?    CurrentWriter { get; set; }

    private int     _line;
    private string  _stepType  = "assign";
    private string? _condition = null;

    public override void Initialize(string tagName, string markup, List<string> tokens) {
        base.Initialize(tagName, markup, tokens);
        var parts = markup.Trim().Split(new char[]{' '}, 3);
        if (parts.Length >= 1) int.TryParse(parts[0], out _line);
        if (parts.Length >= 2) _stepType  = parts[1];
        if (parts.Length >= 3) _condition = parts[2];
    }

    public override void Render(Context context, TextWriter result) {
        var snap = new Dictionary<string, object>();
        foreach (var scope in context.Scopes) {
            foreach (var kv in scope) {
                if (!snap.ContainsKey(kv.Key)) snap[kv.Key] = kv.Value;
            }
        }
        Records.Add(new TraceRecord { Line = _line, Scope = snap });
        CurrentWriter?.AddCheckpoint(_line, _stepType, _condition, snap);
    }
}
