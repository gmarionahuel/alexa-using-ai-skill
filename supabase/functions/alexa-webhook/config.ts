export const APP_CONFIG = {
  timezone: Deno.env.get("APP_TIMEZONE") ?? "America/Argentina/Buenos_Aires",
  locale: Deno.env.get("APP_LOCALE") ?? "es-AR",
  llmProvider: Deno.env.get("LLM_PROVIDER") ?? "groq",
  llmModel: Deno.env.get("LLM_MODEL") ?? "openai/gpt-oss-120b",
  requestBudgetMs: Number(Deno.env.get("REQUEST_BUDGET_MS") ?? "7200"),
  maxSpeechCharacters: Number(Deno.env.get("MAX_SPEECH_CHARACTERS") ?? "1800"),
} as const;

export const PROVIDER_ENDPOINTS = {
  tavilySearch: "https://api.tavily.com/search",
  exaSearch: "https://api.exa.ai/search",
  firecrawlScrape: "https://api.firecrawl.dev/v1/scrape",
  jinaReader: "https://r.jina.ai/",
  scraperApi: "https://api.scraperapi.com/",
  scrapingBee: "https://app.scrapingbee.com/api/v1/",
  scrapeDo: "https://api.scrape.do/",
  coinGecko: "https://api.coingecko.com/api/v3",
  finnhub: "https://finnhub.io/api/v1",
  alphaVantage: "https://www.alphavantage.co/query",
  newsData: "https://newsdata.io/api/1/latest",
} as const;

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing_environment_variable:${name}`);
  return value;
}
