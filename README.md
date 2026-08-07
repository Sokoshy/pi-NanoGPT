# pi-nanogpt

NanoGPT provider extension for [Pi](https://github.com/earendil-works/pi-coding-agent).

It discovers text models from NanoGPT's OpenAI-compatible `/api/v1/models?detailed=true` endpoint and registers them as a Pi provider using OpenAI chat completions. Built for Pi ≥ 0.84 (`refreshModels`-based dynamic discovery).

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

Or use Pi's built-in login (prompts for the key and stores it in Pi's auth store):

```text
/login NanoGPT
```

## Usage

- Pick a `NanoGPT/...` model in Pi's model picker.
- `/refresh-nanogpt` forces a catalog refresh from the NanoGPT API.

The model catalog is fetched automatically on startup (or after `/login`) and cached for 24h; the cached catalog is also used when Pi starts offline. The `NanoGPT/...` provider requires a configured API key to load models — set `NANOGPT_API_KEY` or run `/login NanoGPT` first.
