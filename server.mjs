// Context Squeezer — tiny backend for the BharatCode Build League.
// Zero dependencies: Node stdlib only. Serves the one-page UI and proxies
// squeeze requests to the BharatCode model API.
//
// API facts (verified 2026-11-09, see BUILD-LOG.md):
//   Base URL: https://bharatcode.ai/api/model/v1
//   Chat Completions: POST /chat/completions, Bearer <BHARATCODE_API_KEY>
//   Models (live /models catalog): qwen-3.8-27b (ctx 262,144, out max 32,000),
//   deepseek-v4.1-flash (ctx 1,000,000, out max 32,000).
//   Requests queue when the shared capacity is busy — a short reply has taken
//   100+ s in the reference client (marg), so this server waits up to 600 s
//   and retries 429/503. An unauthenticated POST produced no response at all
//   within 120 s (connection held open), so do not assume a fast 401.
//
// Byte math is exact UTF-8 byte counts, measured per run. No ratio is ever
// claimed in advance: ratio = outBytes / inBytes for the run that just happened.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BHARATCODE_BASE_URL || "https://bharatcode.ai/api/model/v1").replace(/\/$/, "");
const DEFAULT_MODEL = "qwen-3.8-27b";
const MODELS = ["qwen-3.8-27b", "deepseek-v4.1-flash"];
// Input cap: 120,000 UTF-8 bytes leaves comfortable room inside Qwen's
// 262,144-token context window after the system prompt + output budget.
const MAX_INPUT_BYTES = 120_000;
const FETCH_TIMEOUT_MS = 600_000; // 10 min, per the API's queue behaviour
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

const TARGETS = {
  half: { pct: 50, label: "about half (~50%)" },
  quarter: { pct: 25, label: "about a quarter (~25%)" },
  tenth: { pct: 10, label: "about a tenth (~10%)" },
};

const byteLen = (s) => Buffer.byteLength(s, "utf8");

function systemPrompt(target) {
  return (
    "You compress text for an engineer who needs the same meaning in fewer bytes. " +
    `Rewrite the input shorter, targeting ${target.label} of the original byte length. ` +
    "Preserve every fact, name, number, date, decision, and instruction. " +
    "Drop filler, repetition, and pleasantries. Do not add facts, do not change numbers, " +
    "do not turn prose into bullet points unless the input already uses them. " +
    "Output ONLY the compressed text: no preamble, no commentary, no quotation marks around it."
  );
}

// --- mock adapter: local UI testing only, never a model result ---------------
// Deterministic extractive squeeze: keep the first sentence plus evenly
// spaced sentences until roughly the target fraction of sentences is kept.
// Every response and the UI flag it as mock.
function mockSqueeze(text, targetKey) {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*/g) || [text];
  const frac = TARGETS[targetKey].pct / 100;
  const keep = Math.max(1, Math.round(sentences.length * frac));
  const step = sentences.length / keep;
  const picked = [];
  for (let i = 0; i < keep; i++) picked.push(sentences[Math.min(sentences.length - 1, Math.floor(i * step))].trim());
  return picked.join(" ");
}

// --- BharatCode client -------------------------------------------------------
async function callBharatCode({ apiKey, model, targetKey, text }) {
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt(TARGETS[targetKey]) },
      { role: "user", content: text },
    ],
    max_tokens: 16_000, // inside the 32,000 ceiling; output is a fraction of a <=120 KB input
  };
  let delayMs = 5_000;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "context-squeezer/1.0",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        const err = new Error(`BharatCode API HTTP ${res.status}: ${detail}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error(`unexpected response shape: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return content;
    } catch (err) {
      const retryable =
        err.name === "TimeoutError" ||
        RETRY_STATUSES.has(err.status) ||
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT";
      if (retryable && attempt < 2) {
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs *= 2;
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

// --- HTTP helpers ------------------------------------------------------------
function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": byteLen(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_INPUT_BYTES + 10_000) {
        reject(new Error("request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", "Content-Length": data.length });
    res.end(data);
  });
}

// --- server ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      serveFile(res, path.join(PUBLIC_DIR, "index.html"));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      serveFile(res, path.join(PUBLIC_DIR, url.pathname.slice("/public/".length)));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, {
        hasKey: Boolean(process.env.BHARATCODE_API_KEY),
        mock: process.env.MOCK_LLM === "1",
        model: process.env.BHARATCODE_MODEL || DEFAULT_MODEL,
        baseUrl: BASE_URL,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      try {
        const r = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const catalog = await r.json();
        sendJson(res, 200, { models: (catalog.data || []).map((m) => ({ id: m.id, context_window: m.context_window, status: m.status })), live: true });
      } catch {
        sendJson(res, 200, { models: MODELS.map((id) => ({ id, context_window: null, status: "fallback" })), live: false });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/squeeze") {
      const started = Date.now();
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: "bad_json", message: "Request body must be JSON." });
        return;
      }
      const text = typeof payload.text === "string" ? payload.text : "";
      const targetKey = TARGETS[payload.target] ? payload.target : "half";
      const model = MODELS.includes(payload.model) ? payload.model : process.env.BHARATCODE_MODEL || DEFAULT_MODEL;
      if (!text.trim()) {
        sendJson(res, 400, { error: "empty_input", message: "Paste some text first." });
        return;
      }
      const inBytes = byteLen(text);
      if (inBytes > MAX_INPUT_BYTES) {
        sendJson(res, 413, { error: "input_too_large", message: `Input is ${inBytes} bytes; the cap is ${MAX_INPUT_BYTES} bytes.`, inBytes, maxInputBytes: MAX_INPUT_BYTES });
        return;
      }

      const apiKey = process.env.BHARATCODE_API_KEY;
      let squeezed;
      let mock = false;
      if (!apiKey) {
        if (process.env.MOCK_LLM === "1") {
          mock = true;
          squeezed = mockSqueeze(text, targetKey);
        } else {
          sendJson(res, 503, {
            error: "no_api_key",
            message: "BHARATCODE_API_KEY is not set. Get a key at https://bharatcode.ai/account and run: export BHARATCODE_API_KEY=bc_live_... (or start with MOCK_LLM=1 for a clearly-marked demo squeeze).",
          });
          return;
        }
      } else {
        try {
          squeezed = await callBharatCode({ apiKey, model, targetKey, text });
        } catch (err) {
          const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
          sendJson(res, status, { error: "upstream_error", message: err.message.slice(0, 500) });
          return;
        }
      }

      const outBytes = byteLen(squeezed);
      sendJson(res, 200, {
        squeezed,
        inBytes,
        outBytes,
        savedBytes: inBytes - outBytes,
        ratio: inBytes === 0 ? 0 : outBytes / inBytes,
        model,
        mock,
        mockNote: mock ? "MOCK — extractive demo squeeze, not a model result." : undefined,
        elapsedMs: Date.now() - started,
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    sendJson(res, 500, { error: "server_error", message: String(err && err.message ? err.message : err).slice(0, 300) });
  }
});

server.listen(PORT, () => {
  console.log(`Context Squeezer listening on http://localhost:${PORT}`);
  console.log(`model API: ${BASE_URL} (key ${process.env.BHARATCODE_API_KEY ? "set" : "NOT SET"}; mock ${process.env.MOCK_LLM === "1" ? "ON" : "off"})`);
});
