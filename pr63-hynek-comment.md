@boweiliu Thanks for the contribution :) This is funny. I used to think that letting agents use public HTTP APIs directly to circumvent MCP was a good thing and now we're using MCP to circumvent the issues with the "normal" public HTTP API :)

A few questions:

- Did you test that google services still work after the change in oauthUtils.ts?
- Having implemented this, do you think there's a reason to keep the "normal" notion integration in place? As in, are there any use cases that can be served with the "normal" integration but not this one?
- Could you please expand the description in the NotionMcp's `info` string? It's a string that agents get to read while examining available services so by reading `info` of both the "old" `Notion` and of `NotionMCP`, they should be able to make a decision about which one to use.

Also, the `info` string usually contains pointers to a documentation that the agent can use to be able to actually use the API. This is maybe my only potential objection to this MR: is there a good documentation for the MCP server when you want to use it directly over http? (We generally avoid including private or undocumented APIs because agents have no way of knowing how exactly to use them.)

— hynek-urban, 2026-05-05 08:22 UTC, PR #63
