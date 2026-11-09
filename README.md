# Context Squeezer

Paste long text — LLM agent context, a prompt, logs — and get a shorter version that keeps the meaning. Built by Slid Phi Labs for the [BharatCode Build League 2026](https://bharatcode.ai/hackathon).

## What it does

- One page: paste text, pick a squeeze target (about half / a quarter / a tenth), get the squeezed text back with a copy button.
- The squeeze is done by the BharatCode model API (`qwen-3.8-27b` by default), with a prompt that preserves every fact, name, number, date, decision, and instruction while dropping filler and repetition.
- Shows **measured** bytes in, bytes out, bytes saved, and ratio (out ÷ in) for each run. The ratio is a measurement of the run that just happened — this project never claims a fixed compression ratio.

## Run it

```sh
export BHARATCODE_API_KEY=bc_live_...   # get one at https://bharatcode.ai/account
npm start                                # or: node server.mjs
# open http://localhost:3000
```

No dependencies to install (Node ≥ 20 stdlib only). `PORT` overrides the default port 3000. `BHARATCODE_MODEL` can select `deepseek-v4.1-flash` instead of the default `qwen-3.8-27b`.

## Demo mode (no key)

```sh
MOCK_LLM=1 npm start
```

With no key set, the API answers with a clear error naming the missing variable. With `MOCK_LLM=1`, squeezes run through a deterministic extractive demo adapter instead — every response and the UI badge it as **MOCK, not a model result**. Demo mode exists for UI testing only.

## How the byte math works

- Counts are exact UTF-8 bytes (`Buffer.byteLength` server-side, `TextEncoder` client-side), not characters — they differ on non-ASCII text (e.g. `héllo 🌍` is 7 characters but 11 bytes).
- `ratio = outBytes / inBytes`, `savedBytes = inBytes - outBytes`, computed from the actual strings of each run.

## API facts (verified 2026-11-09)

- Base URL: `https://bharatcode.ai/api/model/v1`; Chat Completions at `POST /chat/completions` with `Authorization: Bearer <key>`.
- Live model catalog (no auth): `qwen-3.8-27b` (context 262,144 tokens, max output 32,000) and `deepseek-v4.1-flash` (context 1,000,000 tokens, max output 32,000).
- The API shares capacity and queues requests when busy — a squeeze can take a minute or more. The server waits up to 10 minutes and retries 429/503 responses.

## Limits (honest scope)

- Input cap: 120,000 bytes per squeeze (leaves room inside Qwen's 262,144-token context window).
- The model can only preserve what it is given; verify important numbers in the output before relying on them.
- No key is bundled with this repo, and no key ever belongs in it — the key comes from the environment only.
- The 1,000 free Adaption credits offered to league participants are not used by this project.
