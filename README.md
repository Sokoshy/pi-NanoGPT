# pi-nanogpt

NanoGPT provider extension for [Pi](https://github.com/earendil-works/pi-coding-agent).

It discovers text models from NanoGPT's OpenAI-compatible `/api/v1/models?detailed=true` endpoint and registers them as a Pi provider using OpenAI chat completions.

## Install

```bash
pi install git:github.com/Sokoshy/pi-NanoGPT
```

## Uninstall

```bash
pi remove git:github.com/Sokoshy/pi-NanoGPT
```

Local test from this folder:

```bash
pi -e .
```

## Configuration

Either set an environment variable:

```bash
export NANOGPT_API_KEY=your_key
```

Or run this in Pi:

```text
/login-nanogpt
```

## Usage

- Pick a `NanoGPT/...` model in Pi's model picker.
- `/refresh-nanogpt` refreshes the cached model list.

Model discovery is cached for 24h in `~/.pi/nanogpt-models.json`.
