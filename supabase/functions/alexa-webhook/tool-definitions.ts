export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Busca información actual o verificable en internet. Usala para fechas, precios y hechos recientes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Consulta concreta, con fechas absolutas cuando corresponda." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scrape_url",
      description: "Extrae el contenido principal de una URL pública indicada explícitamente por el usuario.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "URL HTTP o HTTPS completa." } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "crypto_price",
      description: "Consulta precio actual y variación de una criptomoneda.",
      parameters: {
        type: "object",
        properties: {
          coin: { type: "string", description: "Nombre o símbolo, por ejemplo bitcoin, ethereum o BTC." },
          currency: { type: "string", enum: ["usd", "ars"], description: "Moneda de cotización." },
        },
        required: ["coin"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stock_quote",
      description: "Consulta la cotización actual de una acción mediante su ticker bursátil.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Ticker, por ejemplo AAPL, MSFT, TSLA o F." },
        },
        required: ["symbol"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "latest_news",
      description: "Busca noticias recientes, resultados deportivos o próximos partidos.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Tema concreto, con fecha absoluta cuando corresponda." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
] as const;
