# Provider reference

| Capability | Primary | Fallback |
| --- | --- | --- |
| LLM | Groq | Configurable through the database |
| Web search | Tavily | Exa |
| Recent news | NewsData | Tavily/Exa search |
| Cryptocurrency prices | CoinGecko | None |
| Stock quotes | Finnhub | Alpha Vantage |
| URL extraction | Firecrawl | Jina, ScraperAPI, ScrapingBee, Scrape.do |

All public HTTP base URLs used directly by the Edge Function live in `config.ts`. LLM endpoints live in `key_manager.llm_providers` because each selected route returns its configured URL.

Provider credentials are never included in source control. Add them directly to `key_manager.api_keys` through a secure administrative channel.
