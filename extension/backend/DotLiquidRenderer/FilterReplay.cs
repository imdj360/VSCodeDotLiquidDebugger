using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

internal static class FilterReplay
{
    private static readonly Regex AssignPattern = new(@"\{%-?\s*assign\s+\w+\s*=\s*(.+?)\s*-?%\}", RegexOptions.Compiled);

    // Parses the filter chain from the assign source line and re-evaluates it using
    // the raw scope captured BEFORE the assign ran.
    internal static List<FilterCall> BuildFilterCalls(string template, int lineNum, Dictionary<string, object> prevScope)
    {
        return BuildFilterCalls(template.Split('\n'), lineNum, prevScope);
    }

    internal static List<FilterCall> BuildFilterCalls(IReadOnlyList<string> templateLines, int lineNum, Dictionary<string, object> prevScope)
    {
        var lines = templateLines;
        if (lineNum < 1 || lineNum > lines.Count) return new();

        var ln = lines[lineNum - 1];
        var m = AssignPattern.Match(ln);
        if (!m.Success) return new();

        var parts = SplitOutsideQuotes(m.Groups[1].Value, '|')
            .Select(p => p.Trim())
            .Where(p => p.Length > 0)
            .ToList();
        if (parts.Count < 2) return new();

        var calls = new List<FilterCall>();
        object curr = FilterResolve(parts[0], prevScope);

        for (int i = 1; i < parts.Count; i++)
        {
            var filterPart = parts[i];
            var colonIdx = IndexOfOutsideQuotes(filterPart, ':');
            var filterName = (colonIdx < 0 ? filterPart : filterPart[..colonIdx]).Trim();

            var argVals = new List<object?>();
            if (colonIdx >= 0)
            {
                var argRaw = filterPart[(colonIdx + 1)..].Trim();
                var argExprs = SplitOutsideQuotes(argRaw, ',')
                    .Select(a => a.Trim())
                    .Where(a => a.Length > 0);
                foreach (var expr in argExprs)
                {
                    argVals.Add(FilterResolve(expr, prevScope));
                }
            }

            var output = FilterApply(filterName, curr, argVals);
            calls.Add(new FilterCall
            {
                Name = filterName,
                Input = FilterFmt(curr),
                Arg = argVals.Count == 0 || argVals[0] is null ? null : FilterFmt(argVals[0]),
                Output = FilterFmt(output)
            });
            curr = output;
        }

        return calls;
    }

    internal static List<string> SplitOutsideQuotes(string text, char delimiter)
    {
        var parts = new List<string>();
        var sb = new StringBuilder();
        bool inSingle = false, inDouble = false, escaped = false;

        foreach (var ch in text)
        {
            if (escaped)
            {
                sb.Append(ch);
                escaped = false;
                continue;
            }

            if ((inSingle || inDouble) && ch == '\\')
            {
                sb.Append(ch);
                escaped = true;
                continue;
            }

            if (!inDouble && ch == '\'') { inSingle = !inSingle; sb.Append(ch); continue; }
            if (!inSingle && ch == '"') { inDouble = !inDouble; sb.Append(ch); continue; }

            if (!inSingle && !inDouble && ch == delimiter)
            {
                parts.Add(sb.ToString());
                sb.Clear();
                continue;
            }

            sb.Append(ch);
        }

        parts.Add(sb.ToString());
        return parts;
    }

    internal static int IndexOfOutsideQuotes(string text, char target)
    {
        bool inSingle = false, inDouble = false, escaped = false;

        for (int i = 0; i < text.Length; i++)
        {
            var ch = text[i];

            if (escaped) { escaped = false; continue; }
            if ((inSingle || inDouble) && ch == '\\') { escaped = true; continue; }

            if (!inDouble && ch == '\'') { inSingle = !inSingle; continue; }
            if (!inSingle && ch == '"') { inDouble = !inDouble; continue; }

            if (!inSingle && !inDouble && ch == target) return i;
        }

        return -1;
    }

    internal static object FilterResolve(string expr, Dictionary<string, object> scope)
    {
        expr = expr.Trim();
        if ((expr.StartsWith('"') && expr.EndsWith('"')) ||
            (expr.StartsWith("'") && expr.EndsWith("'"))) return expr[1..^1];
        if (decimal.TryParse(expr, NumberStyles.Number, CultureInfo.InvariantCulture, out var d)) return d;
        if (expr == "true") return true;
        if (expr == "false") return false;

        if (TryResolvePath(expr, scope, out var resolved))
        {
            return resolved ?? "";
        }

        // DotLiquid treats unknown variables as blank/nil. Returning the expression
        // string here makes replay misleading (e.g. "items[0].n" -> 0).
        return "";
    }

    internal static object FilterApply(string name, object input, IReadOnlyList<object?> args)
    {
        var arg0 = args.Count > 0 ? args[0] : null;
        var arg1 = args.Count > 1 ? args[1] : null;
        var iD = FilterToD(input);
        var aD = FilterToD(arg0);

        return name switch
        {
            "Times" => iD * aD,
            // Mirror DotLiquid runtime: integer operands use truncating integer division
            // (10 | DividedBy: 3 → 3), mixed/float operands use decimal division.
            "DividedBy" => aD != 0m
                ? (IsWholeNumber(iD) && IsWholeNumber(aD) ? Math.Truncate(iD / aD) : iD / aD)
                : 0m,
            "Plus" => iD + aD,
            "Minus" => iD - aD,
            "Modulo" => aD != 0m ? iD % aD : 0m,
            "Ceil" => Math.Ceiling(iD),
            "Floor" => Math.Floor(iD),
            "Abs" => Math.Abs(iD),
            "Round" => Math.Round(iD, arg0 == null ? 0 : (int)FilterToD(arg0), MidpointRounding.AwayFromZero),
            "AtLeast" => Math.Max(iD, aD),
            "AtMost" => Math.Min(iD, aD),
            "Upcase" => (object)(input?.ToString() ?? "").ToUpperInvariant(),
            "Downcase" => (object)(input?.ToString() ?? "").ToLowerInvariant(),
            "Append" => (object)((input?.ToString() ?? "") + (arg0?.ToString() ?? "")),
            "Prepend" => (object)((arg0?.ToString() ?? "") + (input?.ToString() ?? "")),
            "Strip" => (object)(input?.ToString() ?? "").Trim(),
            "Lstrip" => (object)(input?.ToString() ?? "").TrimStart(),
            "Rstrip" => (object)(input?.ToString() ?? "").TrimEnd(),
            "Size" => FilterSize(input),
            "Capitalize" => input?.ToString() is string cs && cs.Length > 0
                ? (object)(char.ToUpperInvariant(cs[0]) + cs[1..].ToLowerInvariant())
                : (object)"",
            "Remove" => (object)(input?.ToString() ?? "").Replace(arg0?.ToString() ?? "", ""),
            "Replace" => arg0?.ToString() is string rep1
                ? (object)(input?.ToString() ?? "").Replace(rep1, arg1?.ToString() ?? "")
                : input ?? (object)"",
            "ReplaceFirst" => arg0?.ToString() is string rep2
                ? (object)ReplaceFirst(input?.ToString() ?? "", rep2, arg1?.ToString() ?? "")
                : input ?? (object)"",
            "Truncate" => FilterTruncate(input?.ToString(), arg0, arg1),
            "Split" => input?.ToString()?.Split(arg0?.ToString() ?? "") is string[] arr
                ? (object)(IEnumerable<object>)arr.Cast<object>().ToList()
                : (object)new List<object>(),
            "Join" => input is IEnumerable<object> jl
                ? (object)string.Join(arg0?.ToString() ?? " ", jl.Select(x => x?.ToString() ?? ""))
                : input ?? (object)"",
            "First" => input is IEnumerable<object> fl ? (object)(fl.FirstOrDefault() ?? "") : input ?? (object)"",
            "Last" => input is IEnumerable<object> ll ? (object)(ll.LastOrDefault() ?? "") : input ?? (object)"",
            "Reverse" => input is IEnumerable<object> rl ? (object)rl.Reverse().ToList() : input ?? (object)"",
            "Sort" => input is IEnumerable<object> sl
                ? (object)sl.OrderBy(x => x, FilterSortComparer.Instance).ToList()
                : input ?? (object)"",
            "Map" => input is IEnumerable<object> ml && arg0?.ToString() is string mapKey
                ? (object)ml.Select(x => x is IDictionary<string, object> d
                    ? (d.TryGetValue(mapKey, out var mv) ? mv : (object)"")
                    : (object)"").ToList()
                : input ?? (object)"",
            _ => input
        };
    }

    internal static string ReplaceFirst(string input, string search, string replacement)
    {
        var idx = input.IndexOf(search, StringComparison.Ordinal);
        return idx < 0 ? input : input[..idx] + replacement + input[(idx + search.Length)..];
    }

    private static bool IsWholeNumber(decimal v) => v == Math.Truncate(v);

    internal static decimal FilterToD(object? v) =>
        decimal.TryParse(v?.ToString(), NumberStyles.Number, CultureInfo.InvariantCulture, out var d) ? d : 0m;

    internal static string FilterFmt(object? v, int max = 40)
    {
        if (v == null) return "null";
        if (v is string s) return s.Length > max ? s[..(max - 1)] + "…" : s;
        if (v is IEnumerable<object> list) return $"[{list.Count()} items]";
        var str = v.ToString() ?? "null";
        return str.Length > max ? str[..(max - 1)] + "…" : str;
    }

    private static object FilterSize(object? input)
    {
        if (input is string s) return s.Length;
        if (input is IEnumerable<object> l) return l.Count();
        if (input is IEnumerable e && input is not string)
        {
            int count = 0;
            foreach (var _ in e) count++;
            return count;
        }
        return 0;
    }

    // Mirrors DotLiquid's sort behaviour: numeric values sort numerically,
    // everything else sorts lexicographically (ordinal, case-sensitive).
    private sealed class FilterSortComparer : IComparer<object?>
    {
        public static readonly FilterSortComparer Instance = new();
        public int Compare(object? x, object? y)
        {
            var xs = x?.ToString() ?? "";
            var ys = y?.ToString() ?? "";
            var xIsNum = decimal.TryParse(xs, NumberStyles.Number, CultureInfo.InvariantCulture, out var xd);
            var yIsNum = decimal.TryParse(ys, NumberStyles.Number, CultureInfo.InvariantCulture, out var yd);
            if (xIsNum && yIsNum) return xd.CompareTo(yd);
            return string.Compare(xs, ys, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static object FilterTruncate(string? input, object? lengthArg, object? omissionArg)
    {
        var ts = input ?? "";
        int length = (int)FilterToD(lengthArg);
        var omission = omissionArg?.ToString() ?? "...";

        if (ts.Length <= length) return ts;
        if (length <= omission.Length) return omission;

        var keep = Math.Max(0, length - omission.Length);
        if (keep >= ts.Length) return ts;
        return ts[..keep] + omission;
    }

    internal static bool TryResolvePath(string expr, Dictionary<string, object> scope, out object? value)
    {
        value = null;
        var parts = SplitPathSegments(expr);
        if (parts.Length == 0) return false;

        if (!TryResolveSegment(scope, parts[0], scope, out object? cur))
        {
            return false;
        }

        for (int i = 1; i < parts.Length; i++)
        {
            if (!TryResolveSegment(cur, parts[i], scope, out cur))
            {
                return false;
            }
        }

        value = cur;
        return true;
    }

    private static string[] SplitPathSegments(string expr)
    {
        var parts = new List<string>();
        var sb = new StringBuilder();
        bool inSingle = false, inDouble = false, escaped = false;
        int bracketDepth = 0;

        foreach (var ch in expr)
        {
            if (escaped)
            {
                sb.Append(ch);
                escaped = false;
                continue;
            }

            if ((inSingle || inDouble) && ch == '\\')
            {
                sb.Append(ch);
                escaped = true;
                continue;
            }

            if (!inDouble && ch == '\'') { inSingle = !inSingle; sb.Append(ch); continue; }
            if (!inSingle && ch == '"') { inDouble = !inDouble; sb.Append(ch); continue; }

            if (!inSingle && !inDouble)
            {
                if (ch == '[') { bracketDepth++; sb.Append(ch); continue; }
                if (ch == ']') { bracketDepth = Math.Max(0, bracketDepth - 1); sb.Append(ch); continue; }
                if (ch == '.' && bracketDepth == 0)
                {
                    parts.Add(sb.ToString());
                    sb.Clear();
                    continue;
                }
            }

            sb.Append(ch);
        }

        parts.Add(sb.ToString());
        return parts.ToArray();
    }

    private static bool TryResolveSegment(object? container, string segment, Dictionary<string, object> rootScope, out object? value)
    {
        value = null;
        if (container == null) return false;

        var (head, accessors, ok) = ParseSegment(segment);
        if (!ok) return false;

        object? cur = container;
        if (!string.IsNullOrEmpty(head))
        {
            if (!TryGetMember(cur, head, out cur))
            {
                return false;
            }
        }

        foreach (var accessor in accessors)
        {
            if (accessor.Kind == AccessorKind.Index)
            {
                if (!TryGetIndex(cur, accessor.Index, out cur))
                {
                    return false;
                }
            }
            else if (accessor.Kind == AccessorKind.Key)
            {
                if (!TryGetMember(cur, accessor.Text, out cur))
                {
                    return false;
                }
            }
            else
            {
                if (!TryResolvePath(accessor.Text, rootScope, out var dynamicKey))
                {
                    return false;
                }

                if (int.TryParse(dynamicKey?.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var dynamicIndex))
                {
                    if (!TryGetIndex(cur, dynamicIndex, out cur))
                    {
                        return false;
                    }
                }
                else if (!TryGetMember(cur, dynamicKey?.ToString() ?? "", out cur))
                {
                    return false;
                }
            }
        }

        value = cur;
        return true;
    }

    private static (string head, List<PathAccessor> accessors, bool ok) ParseSegment(string segment)
    {
        var accessors = new List<PathAccessor>();
        var bracket = segment.IndexOf('[');
        var head = bracket < 0 ? segment : segment[..bracket];

        if (bracket < 0)
        {
            return (head, accessors, true);
        }

        var i = bracket;
        while (i < segment.Length)
        {
            if (segment[i] != '[') return ("", accessors, false);
            var close = segment.IndexOf(']', i + 1);
            if (close < 0) return ("", accessors, false);

            var raw = segment[(i + 1)..close].Trim();
            if (raw.Length == 0) return ("", accessors, false);

            if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index))
            {
                accessors.Add(PathAccessor.ForIndex(index));
            }
            else if ((raw.StartsWith('"') && raw.EndsWith('"')) || (raw.StartsWith("'") && raw.EndsWith("'")))
            {
                accessors.Add(PathAccessor.ForKey(raw[1..^1]));
            }
            else
            {
                accessors.Add(PathAccessor.ForDynamic(raw));
            }

            i = close + 1;
        }

        return (head, accessors, true);
    }

    private static bool TryGetMember(object? container, string key, out object? value)
    {
        value = null;
        if (container == null) return false;

        if (container is IDictionary<string, object> genericDict)
        {
            return genericDict.TryGetValue(key, out value);
        }

        if (container is IDictionary dict)
        {
            if (!dict.Contains(key)) return false;
            value = dict[key];
            return true;
        }

        return false;
    }

    private static bool TryGetIndex(object? container, int index, out object? value)
    {
        value = null;
        if (container == null || index < 0) return false;

        if (container is IList<object> genericList)
        {
            if (index >= genericList.Count) return false;
            value = genericList[index];
            return true;
        }

        if (container is IList list)
        {
            if (index >= list.Count) return false;
            value = list[index];
            return true;
        }

        return false;
    }

    private enum AccessorKind { Index, Key, Dynamic }

    private readonly record struct PathAccessor(AccessorKind Kind, int Index, string Text)
    {
        public static PathAccessor ForIndex(int index) => new(AccessorKind.Index, index, "");
        public static PathAccessor ForKey(string key) => new(AccessorKind.Key, -1, key);
        public static PathAccessor ForDynamic(string expr) => new(AccessorKind.Dynamic, -1, expr);
    }
}
