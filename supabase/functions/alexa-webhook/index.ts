import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { createVerify, X509Certificate } from "node:crypto";
import { X509Certificate as WebCryptoX509Certificate } from "@peculiar/x509";
import { APP_CONFIG, PROVIDER_ENDPOINTS, requiredEnv } from "./config.ts";
import { AGENT_TOOLS } from "./tool-definitions.ts";
import type { AlexaEnvelope, ApiKeyRoute, ChatMessage, LlmRoute } from "./types.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const CERT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TIMESTAMP_TOLERANCE_MS = 150 * 1000;
const certCache = new Map<string, { pem: string; expiresAt: number }>();
const CURRENT_INFO_RE = /\b(hoy|ayer|ahora|actual|actualidad|reciente|últim[oa]s?|noticias?|resultado|partido|jugó|juega|cotizaci[oó]n|precio|vale)\b/i;


function jsonError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), { status, headers: JSON_HEADERS });
}

function alexaResponse(
  speech: string,
  shouldEndSession = false,
  sessionAttributes: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({
    version: "1.0",
    sessionAttributes,
    response: {
      outputSpeech: { type: "PlainText", text: speech },
      ...(shouldEndSession ? {} : {
        reprompt: {
          outputSpeech: { type: "PlainText", text: "¿Qué necesitás?" },
        },
      }),
      shouldEndSession,
    },
  }), { status: 200, headers: JSON_HEADERS });
}

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const newSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
  const legacySecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  let secret = legacySecret;

  if (newSecrets) {
    try {
      secret = JSON.parse(newSecrets).default ?? legacySecret;
    } catch {
      // Fall back to the legacy runtime-provided secret during key migration.
    }
  }

  if (!url || !secret) throw new Error("supabase_admin_not_configured");
  return createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function voiceSafe(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)]\((?:https?:\/\/)?[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#>`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, APP_CONFIG.maxSpeechCharacters);
}

const NATURAL_INTENT_PREFIX: Record<string, string> = {
  WhyIntent: "por qué",
  WhenIntent: "cuándo",
  WhatIntent: "qué",
  WhoIntent: "quién",
  WhereIntent: "dónde",
  HowIntent: "cómo",
  WhichIntent: "cuál",
  TellIntent: "contame sobre",
  NewsIntent: "últimas noticias sobre",
  CryptoPriceIntent: "precio actual de la criptomoneda",
  StockPriceIntent: "cotización actual de la acción",
  SportsScheduleIntent: "próximo partido de",
  SportsResultIntent: "último resultado de",
  ReadUrlIntent: "leé esta dirección",
  ContinueIntent: "",
  AskIntent: "",
};

function questionFromIntent(envelope: AlexaEnvelope): string | null {
  const intentName = envelope.request?.intent?.name ?? "";
  if (!(intentName in NATURAL_INTENT_PREFIX)) return null;
  const value = envelope.request?.intent?.slots?.query?.value?.trim();
  if (!value) return null;
  return [NATURAL_INTENT_PREFIX[intentName], value].filter(Boolean).join(" ").trim();
}

function argentinaNow(): string {
  return new Intl.DateTimeFormat(APP_CONFIG.locale, {
    timeZone: APP_CONFIG.timezone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
}

function publicHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost"
      || host === "0.0.0.0"
      || host === "169.254.169.254"
      || host === "metadata.google.internal"
      || /^127\./.test(host)
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || host === "::1"
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function fetchWithDeadline(url: string, init: RequestInit, deadline: number, capMs: number): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining < 150) throw new DOMException("Deadline exceeded", "AbortError");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(remaining, capMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function pickApiKey(
  supabase: ReturnType<typeof getAdminClient>,
  category: string,
  provider: string,
): Promise<ApiKeyRoute | null> {
  const { data, error } = await supabase.rpc("pick_api_key", {
    p_category: category,
    p_provider: provider,
  });
  if (error) throw new Error(`pick_${category}_key_failed:${error.message}`);
  return (data?.[0] ?? null) as ApiKeyRoute | null;
}

async function reportApiKey(
  supabase: ReturnType<typeof getAdminClient>,
  keyId: string,
  succeeded: boolean,
  status: number,
): Promise<void> {
  await supabase.rpc("report_llm_key_result", {
    p_key_id: keyId,
    p_succeeded: succeeded,
    p_http_status: status,
    p_cooldown_seconds: 60,
  });
}

async function webSearch(
  supabase: ReturnType<typeof getAdminClient>,
  query: string,
  deadline: number,
): Promise<string> {
  for (const provider of ["tavily", "exa"]) {
    const key = await pickApiKey(supabase, "search", provider);
    if (!key) continue;
    const request = provider === "tavily"
      ? {
        url: PROVIDER_ENDPOINTS.tavilySearch,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: key.api_key,
            query,
            max_results: 3,
            search_depth: "ultra-fast",
            topic: CURRENT_INFO_RE.test(query) ? "news" : "general",
            include_answer: true,
            include_raw_content: false,
          }),
        },
      }
      : {
        url: PROVIDER_ENDPOINTS.exaSearch,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key.api_key },
          body: JSON.stringify({ query, numResults: 3, type: "auto", contents: { text: { maxCharacters: 800 } } }),
        },
      };
    try {
      const response = await fetchWithDeadline(request.url, request.init, deadline, 1700);
      if (!response.ok) {
        await reportApiKey(supabase, key.key_id, false, response.status);
        continue;
      }
      const data = await response.json();
      await reportApiKey(supabase, key.key_id, true, response.status);
      const results = (Array.isArray(data?.results) ? data.results : []).slice(0, 3).map((item: Record<string, unknown>) => ({
        title: String(item.title ?? "").slice(0, 180),
        url: String(item.url ?? "").slice(0, 500),
        snippet: String(item.content ?? item.text ?? item.summary ?? "").slice(0, 900),
      }));
      return JSON.stringify({ provider, answer: String(data?.answer ?? "").slice(0, 1200), results }).slice(0, 4800);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
  }
  return JSON.stringify({ error: "search_unavailable", message: "No fue posible consultar fuentes web a tiempo." });
}

async function cryptoPrice(
  supabase: ReturnType<typeof getAdminClient>,
  rawCoin: unknown,
  rawCurrency: unknown,
  deadline: number,
): Promise<string> {
  const coin = typeof rawCoin === "string" ? rawCoin.trim().toLowerCase().slice(0, 80) : "";
  const currency = typeof rawCurrency === "string" && rawCurrency.toLowerCase() === "ars" ? "ars" : "usd";
  if (!coin) return JSON.stringify({ error: "coin_required" });
  const key = await pickApiKey(supabase, "data", "coingecko");
  if (!key) return JSON.stringify({ error: "crypto_provider_unavailable" });
  const aliases: Record<string, string> = {
    btc: "bitcoin", bitcoin: "bitcoin", eth: "ethereum", ethereum: "ethereum",
    sol: "solana", solana: "solana", xrp: "ripple", ripple: "ripple",
    doge: "dogecoin", dogecoin: "dogecoin", ada: "cardano", cardano: "cardano",
  };
  const coinId = aliases[coin] ?? coin.replace(/[^a-z0-9-]/g, "-");
  const qs = new URLSearchParams({
    ids: coinId,
    vs_currencies: currency,
    include_24hr_change: "true",
    include_last_updated_at: "true",
  });
  try {
    const response = await fetchWithDeadline(`${PROVIDER_ENDPOINTS.coinGecko}/simple/price?${qs}`, {
      method: "GET",
      headers: { "x-cg-demo-api-key": key.api_key, "Accept": "application/json" },
    }, deadline, 1400);
    const data = await response.json().catch(() => ({}));
    await reportApiKey(supabase, key.key_id, response.ok, response.status);
    if (!response.ok) return JSON.stringify({ error: "crypto_lookup_failed", status: response.status });
    return JSON.stringify({ provider: "coingecko", coin: coinId, currency, data: data?.[coinId] ?? null });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return JSON.stringify({ error: "crypto_lookup_failed" });
  }
}

async function stockQuote(
  supabase: ReturnType<typeof getAdminClient>,
  rawSymbol: unknown,
  deadline: number,
): Promise<string> {
  const symbol = typeof rawSymbol === "string" ? rawSymbol.trim().toUpperCase().replace(/[^A-Z0-9.:-]/g, "").slice(0, 15) : "";
  if (!symbol) return JSON.stringify({ error: "symbol_required" });
  for (const provider of ["finnhub", "alphavantage"]) {
    const key = await pickApiKey(supabase, "data", provider);
    if (!key) continue;
    const url = provider === "finnhub"
      ? `${PROVIDER_ENDPOINTS.finnhub}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key.api_key)}`
      : `${PROVIDER_ENDPOINTS.alphaVantage}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key.api_key)}`;
    try {
      const response = await fetchWithDeadline(url, { method: "GET", headers: { "Accept": "application/json" } }, deadline, 1400);
      const data = await response.json().catch(() => ({}));
      await reportApiKey(supabase, key.key_id, response.ok, response.status);
      if (!response.ok) continue;
      const quote = provider === "finnhub" ? {
        current: data?.c, change: data?.d, percent_change: data?.dp,
        high: data?.h, low: data?.l, open: data?.o, previous_close: data?.pc, timestamp: data?.t,
      } : data?.["Global Quote"];
      if (quote && Object.keys(quote).length > 0) return JSON.stringify({ provider, symbol, quote });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
  }
  return JSON.stringify({ error: "stock_quote_unavailable", symbol });
}

async function latestNews(
  supabase: ReturnType<typeof getAdminClient>,
  rawQuery: unknown,
  deadline: number,
): Promise<string> {
  const query = typeof rawQuery === "string" ? rawQuery.trim().slice(0, 300) : "";
  if (!query) return JSON.stringify({ error: "query_required" });
  const key = await pickApiKey(supabase, "data", "newsdata");
  if (key) {
    const qs = new URLSearchParams({ apikey: key.api_key, q: query, language: "es" });
    try {
      const response = await fetchWithDeadline(`${PROVIDER_ENDPOINTS.newsData}?${qs}`, {
        method: "GET", headers: { "Accept": "application/json" },
      }, deadline, 1400);
      const data = await response.json().catch(() => ({}));
      await reportApiKey(supabase, key.key_id, response.ok, response.status);
      if (response.ok && Array.isArray(data?.results) && data.results.length > 0) {
        const results = data.results.slice(0, 3).map((item: Record<string, unknown>) => ({
          title: String(item.title ?? "").slice(0, 180),
          description: String(item.description ?? "").slice(0, 700),
          published_at: String(item.pubDate ?? "").slice(0, 40),
          source: String(item.source_name ?? item.source_id ?? "").slice(0, 100),
        }));
        return JSON.stringify({ provider: "newsdata", results });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
  }
  return await webSearch(supabase, `${query} noticias recientes ${argentinaNow()}`, deadline);
}

async function scrapeUrl(
  supabase: ReturnType<typeof getAdminClient>,
  rawUrl: unknown,
  deadline: number,
): Promise<string> {
  const url = publicHttpUrl(rawUrl);
  if (!url) return JSON.stringify({ error: "invalid_public_url" });
  for (const provider of ["firecrawl", "jina", "scraperapi", "scrapingbee", "scrape_do"]) {
    const key = await pickApiKey(supabase, "scraping", provider);
    if (!key) continue;
    const request = provider === "firecrawl"
      ? {
        url: PROVIDER_ENDPOINTS.firecrawlScrape,
        init: {
          method: "POST",
          headers: { "Authorization": `Bearer ${key.api_key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
        },
      }
      : provider === "jina" ? {
        url: `${PROVIDER_ENDPOINTS.jinaReader}${url}`,
        init: { method: "GET", headers: { "Authorization": `Bearer ${key.api_key}`, "Accept": "text/markdown" } },
      } : provider === "scraperapi" ? {
        url: `${PROVIDER_ENDPOINTS.scraperApi}?${new URLSearchParams({ api_key: key.api_key, url, render: "false" })}`,
        init: { method: "GET", headers: { "Accept": "text/html,text/plain" } },
      } : provider === "scrapingbee" ? {
        url: `${PROVIDER_ENDPOINTS.scrapingBee}?${new URLSearchParams({ api_key: key.api_key, url, render_js: "false" })}`,
        init: { method: "GET", headers: { "Accept": "text/html,text/plain" } },
      } : {
        url: `${PROVIDER_ENDPOINTS.scrapeDo}?${new URLSearchParams({ token: key.api_key, url, render: "false" })}`,
        init: { method: "GET", headers: { "Accept": "text/html,text/plain" } },
      };
    try {
      const response = await fetchWithDeadline(request.url, request.init, deadline, 1800);
      const text = await response.text();
      if (!response.ok) {
        await reportApiKey(supabase, key.key_id, false, response.status);
        continue;
      }
      await reportApiKey(supabase, key.key_id, true, response.status);
      if (provider === "firecrawl") {
        try {
          const parsed = JSON.parse(text);
          return JSON.stringify({ provider, url, content: String(parsed?.data?.markdown ?? parsed?.markdown ?? "").slice(0, 4500) });
        } catch {
          return JSON.stringify({ provider, url, content: text.slice(0, 4500) });
        }
      }
      const content = provider === "jina"
        ? text
        : text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ");
      return JSON.stringify({ provider, url, content: content.slice(0, 4500) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
  }
  return JSON.stringify({ error: "scrape_unavailable", message: "No fue posible leer la URL a tiempo." });
}

async function executeAgentTool(
  supabase: ReturnType<typeof getAdminClient>,
  name: string,
  rawArguments: string,
  deadline: number,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(rawArguments || "{}"); } catch { return JSON.stringify({ error: "invalid_tool_arguments" }); }
  if (name === "web_search") {
    const query = typeof args.query === "string" ? args.query.trim().slice(0, 500) : "";
    return query ? await webSearch(supabase, query, deadline) : JSON.stringify({ error: "query_required" });
  }
  if (name === "scrape_url") return await scrapeUrl(supabase, args.url, deadline);
  if (name === "crypto_price") return await cryptoPrice(supabase, args.coin, args.currency, deadline);
  if (name === "stock_quote") return await stockQuote(supabase, args.symbol, deadline);
  if (name === "latest_news") return await latestNews(supabase, args.query, deadline);
  return JSON.stringify({ error: "unknown_tool" });
}

async function answerWithGroq(
  supabase: ReturnType<typeof getAdminClient>,
  envelope: AlexaEnvelope,
  question: string,
  startedAt: number,
): Promise<Response> {
  const deadline = startedAt + APP_CONFIG.requestBudgetMs;
  const attributes = envelope.session?.attributes ?? {};
  const previousQuestion = typeof attributes.last_question === "string"
    ? attributes.last_question.slice(0, 600)
    : "";
  const previousAnswer = typeof attributes.last_answer === "string"
    ? attributes.last_answer.slice(0, 1200)
    : "";
  const conversationalContext = previousQuestion && previousAnswer
    ? [
      { role: "user", content: previousQuestion },
      { role: "assistant", content: previousAnswer },
    ]
    : [];

  const { data: routes, error: routeError } = await supabase.rpc("pick_llm_route", {
    p_provider: APP_CONFIG.llmProvider,
  });
  if (routeError) throw new Error(`route_pick_failed:${routeError.message}`);
  const route = (routes?.[0] ?? null) as LlmRoute | null;
  if (!route) throw new Error("no_groq_key_available");
  if (route.model.trim() !== APP_CONFIG.llmModel) throw new Error("unexpected_llm_model");

  const providerStartedAt = Date.now();
  const systemMessage: ChatMessage = {
    role: "system",
    content: `Sos un asistente de voz útil dentro de Alexa. Fecha y hora actual en Argentina: ${argentinaNow()}. Respondé en español natural, de forma directa y breve, normalmente en dos a cuatro oraciones. No uses Markdown, tablas ni URLs. Usá el turno anterior para resolver referencias como 'él', 'eso' o 'por qué ocurrió'. Para criptomonedas usá crypto_price. Para acciones usá stock_quote. Para noticias recientes y deportes usá latest_news. Para otros hechos actuales o verificables usá web_search. Usá scrape_url solamente cuando el usuario haya indicado una URL concreta. Podés usar como máximo una herramienta por turno. No inventes cotizaciones, resultados ni noticias si una herramienta falla.`,
  };
  const messages: ChatMessage[] = [
    systemMessage,
    ...conversationalContext,
    { role: "user", content: question },
  ];

  const callGroq = async (
    callMessages: ChatMessage[],
    toolChoice: "auto" | "none",
    capMs: number,
    maxTokens: number,
  ) => {
    const response = await fetchWithDeadline(route.base_url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${route.api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: APP_CONFIG.llmModel,
        messages: callMessages,
        tools: AGENT_TOOLS,
        tool_choice: toolChoice,
        temperature: 1,
        reasoning_effort: "low",
        reasoning_format: "hidden",
        max_completion_tokens: maxTokens,
        stream: false,
      }),
    }, deadline, capMs);
    if (!response.ok) {
      const providerError = voiceSafe((await response.text()).slice(0, 800));
      await reportApiKey(supabase, route.key_id, false, response.status);
      throw new Error(`groq_http_${response.status}:${providerError || "unknown"}`);
    }
    return await response.json();
  };

  const firstCompletion = await callGroq(messages, "auto", 3200, 220);
  const firstMessage = firstCompletion?.choices?.[0]?.message as ChatMessage | undefined;
  const toolCalls = Array.isArray(firstMessage?.tool_calls) ? firstMessage.tool_calls as Array<Record<string, unknown>> : [];
  let toolName: string | null = null;
  let finalMessage = firstMessage;

  if (toolCalls.length > 0) {
    const toolCall = toolCalls[0];
    const fn = (toolCall.function ?? {}) as Record<string, unknown>;
    toolName = typeof fn.name === "string" ? fn.name : "unknown";
    const toolResult = await executeAgentTool(
      supabase,
      toolName,
      typeof fn.arguments === "string" ? fn.arguments : "{}",
      deadline,
    );
    const secondCompletion = await callGroq([
      ...messages,
      firstMessage ?? { role: "assistant", content: null, tool_calls: [toolCall] },
      {
        role: "tool",
        tool_call_id: String(toolCall.id ?? "tool_call"),
        name: toolName,
        content: toolResult,
      },
    ], "none", 2600, 220);
    finalMessage = secondCompletion?.choices?.[0]?.message as ChatMessage | undefined;
  }

  const answer = voiceSafe(typeof finalMessage?.content === "string" ? finalMessage.content : "");
  if (!answer) throw new Error("empty_groq_response");
  await reportApiKey(supabase, route.key_id, true, 200);

  await supabase.from("execution_logs").insert({
    request_id: envelope.request?.requestId,
    request_type: "IntentRequest",
    provider: APP_CONFIG.llmProvider,
    model: APP_CONFIG.llmModel,
    status: "succeeded",
    latency_ms: Date.now() - startedAt,
    metadata: {
      provider_latency_ms: Date.now() - providerStartedAt,
      tool_name: toolName,
      tool_used: toolName !== null,
    },
  });

  return alexaResponse(`${answer} ¿Algo más?`, false, {
    last_question: question.slice(0, 600),
    last_answer: answer.slice(0, 1200),
  });
}

function assertAllowedCertificateUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const normalizedPath = decodeURIComponent(url.pathname).replace(/\/+/g, "/");
  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "s3.amazonaws.com"
    || (url.port !== "" && url.port !== "443")
    || !normalizedPath.startsWith("/echo.api/")
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new Error("invalid_certificate_url");
  }
  return url;
}

async function getCertificatePem(url: URL): Promise<string> {
  const cached = certCache.get(url.href);
  if (cached && cached.expiresAt > Date.now()) return cached.pem;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error("certificate_fetch_failed");
    const pem = await response.text();
    if (pem.length > 64_000 || !pem.includes("BEGIN CERTIFICATE")) {
      throw new Error("invalid_certificate_body");
    }
    certCache.set(url.href, { pem, expiresAt: Date.now() + CERT_CACHE_TTL_MS });
    return pem;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyCertificateAndSignature(
  pemChain: string,
  rawBody: string,
  signature: string,
): Promise<void> {
  const blocks = pemChain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks?.length) throw new Error("certificate_missing");

  const certificates = blocks.map((pem) => new X509Certificate(pem));
  const leaf = certificates[0];
  const now = Date.now();
  if (now < Date.parse(leaf.validFrom) || now > Date.parse(leaf.validTo)) {
    throw new Error("certificate_expired");
  }
  const dnsNames = (leaf.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.toUpperCase().startsWith("DNS:"))
    .map((entry) => entry.slice(4).trim().replace(/^"|"$/g, "").toLowerCase());
  const commonNames = leaf.subject
    .split(/\n|,\s*/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.startsWith("cn="))
    .map((entry) => entry.slice(3));
  const sanMatches = dnsNames.includes("echo-api.amazon.com");
  const cnFallbackMatches = dnsNames.length === 0 && commonNames.includes("echo-api.amazon.com");
  if (!sanMatches && !cnFallbackMatches) {
    throw new Error("invalid_certificate_subject");
  }

  const webCryptoCertificates = blocks.map((pem) => new WebCryptoX509Certificate(pem));
  for (let index = 0; index < webCryptoCertificates.length - 1; index++) {
    const valid = await webCryptoCertificates[index].verify({
      publicKey: webCryptoCertificates[index + 1].publicKey,
    });
    if (!valid) throw new Error("invalid_certificate_chain");
  }

  const verifier = createVerify("RSA-SHA1");
  verifier.update(rawBody, "utf8");
  verifier.end();
  if (!verifier.verify(leaf.publicKey, signature, "base64")) {
    throw new Error("invalid_alexa_signature");
  }
}

function verifyTimestamp(envelope: AlexaEnvelope): void {
  const timestamp = envelope.request?.timestamp;
  const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > TIMESTAMP_TOLERANCE_MS) {
    throw new Error("stale_request");
  }
}

async function verifyAlexaRequest(
  envelope: AlexaEnvelope,
  rawBody: string,
  req: Request,
): Promise<void> {
  const signature = req.headers.get("signature");
  const certUrl = req.headers.get("signaturecertchainurl");
  if (!signature || !certUrl) throw new Error("missing_alexa_signature");

  const allowedCertUrl = assertAllowedCertificateUrl(certUrl);
  const certificatePem = await getCertificatePem(allowedCertUrl);
  await verifyCertificateAndSignature(certificatePem, rawBody, signature);
  verifyTimestamp(envelope);

  const expectedSkillId = requiredEnv("ALEXA_SKILL_ID");

  const receivedSkillId = envelope.session?.application?.applicationId
    ?? envelope.context?.System?.application?.applicationId;
  if (!receivedSkillId || receivedSkillId !== expectedSkillId) {
    throw new Error("wrong_skill_id");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed");

  const startedAt = Date.now();
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > 256_000) {
    return jsonError(413, "payload_too_large");
  }

  let envelope: AlexaEnvelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "invalid_json");
  }

  try {
    await verifyAlexaRequest(envelope, rawBody, req);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_alexa_request";
    console.warn("Alexa request rejected", { code });
    try {
      const debugClient = getAdminClient();
      await debugClient.from("execution_logs").insert({
        request_id: envelope.request?.requestId ?? null,
        request_type: envelope.request?.type ?? null,
        status: "failed",
        latency_ms: Date.now() - startedAt,
        error_code: "alexa_verification_failed",
        error_detail: code.slice(0, 500),
      });
    } catch (logError) {
      console.error("Could not persist Alexa rejection", {
        message: logError instanceof Error ? logError.message : String(logError),
      });
    }
    return jsonError(401, code);
  }

  const requestId = envelope.request?.requestId;
  const requestTimestamp = envelope.request?.timestamp;
  if (!requestId || !requestTimestamp) return jsonError(400, "missing_request_identity");

  const supabase = getAdminClient();
  const { data: accepted, error: replayError } = await supabase.rpc("register_alexa_request", {
    p_request_id: requestId,
    p_request_timestamp: requestTimestamp,
  });
  if (replayError) {
    console.error("Replay registration failed", { message: replayError.message });
    return jsonError(500, "request_registration_failed");
  }
  if (accepted !== true) return jsonError(409, "replayed_request");

  const requestType = envelope.request?.type;
  console.info("Accepted Alexa request", {
    requestType,
    intentName: envelope.request?.intent?.name ?? null,
    latencyMs: Date.now() - startedAt,
  });
  if (requestType === "LaunchRequest") {
    return alexaResponse("Hola, acá estoy. ¿Qué necesitás?");
  }
  if (requestType === "SessionEndedRequest") {
    return new Response(JSON.stringify({ version: "1.0", response: {} }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  if (requestType === "IntentRequest") {
    const intentName = envelope.request?.intent?.name;
    if (
      intentName === "AMAZON.StopIntent"
      || intentName === "AMAZON.CancelIntent"
      || intentName === "AMAZON.NoIntent"
    ) {
      return alexaResponse("Hasta luego.", true);
    }
    if (intentName === "AMAZON.HelpIntent") {
      return alexaResponse("Podés hacerme una pregunta. Por ejemplo, preguntá qué puedo hacer.");
    }
    const question = questionFromIntent(envelope);
    if (question) {
      try {
        return await answerWithGroq(supabase, envelope, question, startedAt);
      } catch (error) {
        const code = error instanceof DOMException && error.name === "AbortError"
          ? "groq_timeout"
          : error instanceof Error ? error.message : "llm_failed";
        console.error("Alexa LLM request failed", { code });
        await supabase.from("execution_logs").insert({
          request_id: requestId,
          request_type: requestType,
          provider: APP_CONFIG.llmProvider,
          model: APP_CONFIG.llmModel,
          status: code === "groq_timeout" ? "timed_out" : "failed",
          latency_ms: Date.now() - startedAt,
          error_code: code.slice(0, 100),
        });
        const speech = code === "groq_timeout"
          ? "No pude responder a tiempo. ¿Querés intentar otra vez?"
          : "Tuve un problema al consultar la inteligencia artificial. ¿Querés intentar otra vez?";
        return alexaResponse(speech);
      }
    }
    return alexaResponse("No llegué a entenderte. Probá haciendo una pregunta de otra manera.");
  }

  console.info("Unsupported Alexa request", {
    requestType,
    latencyMs: Date.now() - startedAt,
  });
  return jsonError(400, "unsupported_request_type");
});
