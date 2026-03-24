# llm-latchkey

An plugin for Simon Willison's [LLM](https://llm.datasette.io/) tool that lets models make authenticated HTTP API requests via [Latchkey](https://github.com/imbue-ai/latchkey).

## Installation

First, install Latchkey and configure credentials for at least one service:

```bash
npm install -g latchkey
latchkey auth set github -H "Authorization: Bearer ghp_..."
```

Then install this plugin:

```bash
llm install llm-latchkey
```

## Usage

```bash
llm -T latchkey "What are my most recent GitHub notifications?" --td
```

The model gets a single `latchkey` tool that accepts any latchkey command string. The tool description includes usage instructions, examples, and the list of supported services, so the model knows how to use it.
