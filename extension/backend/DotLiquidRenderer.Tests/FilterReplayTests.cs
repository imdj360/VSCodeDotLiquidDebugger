using System.Collections.Generic;
using System.Linq;
using Xunit;

public class FilterReplayTests
{
    [Fact]
    public void SplitOutsideQuotes_DoesNotSplitQuotedPipes()
    {
        var parts = FilterReplay.SplitOutsideQuotes("\"a|b\" | Upcase | Replace: \"x|y\", \"z\"", '|');

        Assert.Equal(3, parts.Count);
        Assert.Equal("\"a|b\" ", parts[0]);
        Assert.Equal(" Upcase ", parts[1]);
        Assert.Equal(" Replace: \"x|y\", \"z\"", parts[2]);
    }

    [Fact]
    public void SplitOutsideQuotes_DoesNotSplitSingleQuotedPipes()
    {
        var parts = FilterReplay.SplitOutsideQuotes("'a|b' | Downcase", '|');

        Assert.Equal(2, parts.Count);
        Assert.Equal("'a|b' ", parts[0]);
        Assert.Equal(" Downcase", parts[1]);
    }

    [Fact]
    public void SplitOutsideQuotes_RespectsEscapedQuotes()
    {
        var parts = FilterReplay.SplitOutsideQuotes("\"a\\\"|b\" | Upcase", '|');

        Assert.Equal(2, parts.Count);
        Assert.Equal("\"a\\\"|b\" ", parts[0]);
        Assert.Equal(" Upcase", parts[1]);
    }

    [Fact]
    public void IndexOfOutsideQuotes_IgnoresQuotedColon()
    {
        var idx = FilterReplay.IndexOfOutsideQuotes("Replace: \"a:b\", \"z\"", ':');

        Assert.Equal(7, idx);
    }

    [Fact]
    public void BuildFilterCalls_ParsesNoSpacePipes()
    {
        var template = "{% assign x = content.n|Times:2|Plus:3 %}\n{{ x }}";
        var scope = new Dictionary<string, object>
        {
            ["content"] = new Dictionary<string, object> { ["n"] = 5m }
        };

        var calls = FilterReplay.BuildFilterCalls(template, 1, scope);

        Assert.Equal(2, calls.Count);
        Assert.Equal("Times", calls[0].Name);
        Assert.Equal("5", calls[0].Input);
        Assert.Equal("2", calls[0].Arg);
        Assert.Equal("10", calls[0].Output);
        Assert.Equal("Plus", calls[1].Name);
        Assert.Equal("10", calls[1].Input);
        Assert.Equal("3", calls[1].Arg);
        Assert.Equal("13", calls[1].Output);
    }

    [Fact]
    public void BuildFilterCalls_DoesNotSplitQuotedPipeLiteral()
    {
        var template = "{% assign x = \"a|b\" | Upcase %}\n{{ x }}";
        var calls = FilterReplay.BuildFilterCalls(template, 1, new Dictionary<string, object>());

        Assert.Single(calls);
        Assert.Equal("Upcase", calls[0].Name);
        Assert.Equal("a|b", calls[0].Input);
        Assert.Equal("A|B", calls[0].Output);
    }

    [Fact]
    public void BuildFilterCalls_ReplaceUsesSecondArgument()
    {
        var template = "{% assign x = \"abc\" | Replace: \"a\", \"z\" %}\n{{ x }}";
        var calls = FilterReplay.BuildFilterCalls(template, 1, new Dictionary<string, object>());

        Assert.Single(calls);
        Assert.Equal("Replace", calls[0].Name);
        Assert.Equal("a", calls[0].Arg); // first arg shown in UI
        Assert.Equal("zbc", calls[0].Output);
    }

    [Fact]
    public void FilterResolve_ResolvesNestedDictionaryPath()
    {
        var scope = new Dictionary<string, object>
        {
            ["content"] = new Dictionary<string, object>
            {
                ["customer"] = new Dictionary<string, object>
                {
                    ["name"] = "Alice"
                }
            }
        };

        var value = FilterReplay.FilterResolve("content.customer.name", scope);

        Assert.Equal("Alice", value);
    }

    [Fact]
    public void FilterResolve_ResolvesIndexedPath()
    {
        var scope = new Dictionary<string, object>
        {
            ["items"] = new List<object>
            {
                new Dictionary<string, object> { ["n"] = 4m }
            }
        };

        var value = FilterReplay.FilterResolve("items[0].n", scope);

        Assert.Equal(4m, value);
    }

    [Fact]
    public void BuildFilterCalls_IndexedPathReplayMatchesRuntimeArithmetic()
    {
        var template = "{% assign v = items[0].n | Times: 2 %}\n{{ v }}";
        var scope = new Dictionary<string, object>
        {
            ["items"] = new List<object>
            {
                new Dictionary<string, object> { ["n"] = 4m }
            }
        };

        var calls = FilterReplay.BuildFilterCalls(template, 1, scope);

        Assert.Single(calls);
        Assert.Equal("Times", calls[0].Name);
        Assert.Equal("4", calls[0].Input);
        Assert.Equal("2", calls[0].Arg);
        Assert.Equal("8", calls[0].Output);
    }

    [Fact]
    public void FilterApply_TruncateUsesThreeDotsLikeDotLiquid()
    {
        var output = FilterReplay.FilterApply("Truncate", "abcdef", new List<object?> { 3m });

        Assert.Equal("...", output);
    }

    [Fact]
    public void FilterApply_SizeOnNumberReturnsZero()
    {
        var output = FilterReplay.FilterApply("Size", 42m, new List<object?>());

        Assert.Equal(0, output);
    }

    [Fact]
    public void FilterApply_SizeOnStringReturnsStringLength()
    {
        var output = FilterReplay.FilterApply("Size", "hello", new List<object?>());

        Assert.Equal(5, output);
    }

    [Fact]
    public void FilterApply_SortMatchesMixedCaseRuntimeOrder()
    {
        var input = new List<object> { "Banana", "apple" };
        var output = FilterReplay.FilterApply("Sort", input, new List<object?>());

        var list = Assert.IsType<List<object>>(output);
        Assert.Equal(new[] { "apple", "Banana" }, list.Cast<string>().ToArray());
    }

    [Fact]
    public void FilterResolve_MissingPathReturnsBlankString()
    {
        var value = FilterReplay.FilterResolve("content.total", new Dictionary<string, object>());

        Assert.Equal("", value);
    }

    [Fact]
    public void FilterResolve_BracketStringKeyAtRootResolves()
    {
        var scope = new Dictionary<string, object>
        {
            ["key"] = "value"
        };

        var value = FilterReplay.FilterResolve("[\"key\"]", scope);

        Assert.Equal("value", value);
    }

    [Fact]
    public void FilterResolve_SingleQuotedBracketKeyAtRootResolves()
    {
        var scope = new Dictionary<string, object>
        {
            ["key"] = "value"
        };

        var value = FilterReplay.FilterResolve("['key']", scope);

        Assert.Equal("value", value);
    }

    [Fact]
    public void FilterResolve_DynamicIndexExpressionResolves()
    {
        var scope = new Dictionary<string, object>
        {
            ["items"] = new List<object>
            {
                new Dictionary<string, object> { ["price"] = 10m },
                new Dictionary<string, object> { ["price"] = 20m }
            },
            ["forloop"] = new Dictionary<string, object>
            {
                ["index"] = 1m
            }
        };

        var value = FilterReplay.FilterResolve("items[forloop.index].price", scope);

        Assert.Equal(20m, value);
    }

    [Fact]
    public void FilterApply_UnknownFilterReturnsInputUnchanged()
    {
        var output = FilterReplay.FilterApply("NoSuchFilter", "abc", new List<object?>());

        Assert.Equal("abc", output);
    }

    [Fact]
    public void FilterFmt_LongStringsUseDisplayEllipsisAtFortyCharacters()
    {
        var formatted = FilterReplay.FilterFmt(new string('x', 41));

        Assert.Equal(new string('x', 39) + "…", formatted);
    }

    [Fact]
    public void FilterFmt_ExactFortyCharactersDoesNotClip()
    {
        var formatted = FilterReplay.FilterFmt(new string('x', 40));

        Assert.Equal(new string('x', 40), formatted);
    }
}
