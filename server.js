/**
 * ============================================================
 *  MY CLAUDE MCP CONNECTOR — single file edition
 *  Includes: Calculator, Text, DateTime, Weather, NEWS
 * ============================================================
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { z } from "zod";

const PORT = process.env.PORT ?? 3000;
const sessions = new Map();

// ──────────────────────────────────────────────────────────────
//  RSS PARSER (no extra dependencies needed)
// ──────────────────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemBlocks = xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g);
  for (const block of itemBlocks) {
    const raw = block[1];
    const get = (tag) =>
      raw.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`))?.[1]
        ?.replace(/<[^>]+>/g, "")
        ?.trim() ?? "";
    items.push({
      title:       get("title"),
      description: get("description"),
      link:        get("link") || raw.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || "",
      pubDate:     get("pubDate"),
    });
  }
  return items;
}

// ──────────────────────────────────────────────────────────────
//  NEWS SOURCES  (RSS feeds — free, no API key)
// ──────────────────────────────────────────────────────────────
const NEWS_SOURCES = {
  bbc: {
    name: "BBC News",
    feeds: {
      top:         "https://feeds.bbci.co.uk/news/rss.xml",
      world:       "https://feeds.bbci.co.uk/news/world/rss.xml",
      technology:  "https://feeds.bbci.co.uk/news/technology/rss.xml",
      science:     "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
      business:    "https://feeds.bbci.co.uk/news/business/rss.xml",
      health:      "https://feeds.bbci.co.uk/news/health/rss.xml",
      sport:       "https://feeds.bbci.co.uk/sport/rss.xml",
      entertainment:"https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
    },
  },
  aljazeera: {
    name: "Al Jazeera",
    feeds: {
      top:         "https://www.aljazeera.com/xml/rss/all.xml",
      world:       "https://www.aljazeera.com/xml/rss/all.xml",
      technology:  "https://www.aljazeera.com/xml/rss/all.xml",
      business:    "https://www.aljazeera.com/xml/rss/all.xml",
      sport:       "https://www.aljazeera.com/xml/rss/all.xml",
    },
  },
  timesofindia: {
    name: "Times of India",
    feeds: {
      top:         "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
      world:       "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms",
      technology:  "https://timesofindia.indiatimes.com/rssfeeds/66949542.cms",
      science:     "https://timesofindia.indiatimes.com/rssfeeds/913168846.cms",
      business:    "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms",
      health:      "https://timesofindia.indiatimes.com/rssfeeds/3908999.cms",
      sport:       "https://timesofindia.indiatimes.com/rssfeeds/4719148.cms",
      entertainment:"https://timesofindia.indiatimes.com/rssfeeds/1081479906.cms",
      india:       "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms",
    },
  },
  mathrubhumi: {
    name: "Mathrubhumi",
    feeds: {
      top:         "https://english.mathrubhumi.com/rss",
      kerala:      "https://english.mathrubhumi.com/news/kerala/rss",
      india:       "https://english.mathrubhumi.com/news/india/rss",
      world:       "https://english.mathrubhumi.com/news/world/rss",
      technology:  "https://english.mathrubhumi.com/technology/rss",
      sport:       "https://english.mathrubhumi.com/sports/rss",
      health:      "https://english.mathrubhumi.com/health/rss",
      business:    "https://english.mathrubhumi.com/money/rss",
      entertainment:"https://english.mathrubhumi.com/movies/rss",
    },
  },
};

async function fetchFeed(url, count = 8) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseRSS(xml).slice(0, count);
}

function matchesInterests(item, interests) {
  if (!interests?.length) return true;
  const text = `${item.title} ${item.description}`.toLowerCase();
  return interests.some(kw => text.includes(kw.toLowerCase()));
}

function formatArticle(item, index) {
  const lines = [`${index}. ${item.title}`];
  if (item.description) lines.push(`   ${item.description.slice(0, 180)}${item.description.length > 180 ? "…" : ""}`);
  if (item.pubDate)     lines.push(`   📅 ${item.pubDate}`);
  if (item.link)        lines.push(`   🔗 ${item.link}`);
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────
//  CREATE SERVER & REGISTER ALL TOOLS
// ──────────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: "my-claude-connector", version: "1.0.0" });

  // ══════════════════════════════════════════════════════════
  //  NEWS TOOLS
  // ══════════════════════════════════════════════════════════

  // Tool 1 — fetch news from one or all sources
  server.tool(
    "get_news",
    "Fetch top headlines from BBC, Al Jazeera, Times of India, and/or Mathrubhumi. Filter by topic (technology, world, business, sport, health, science, entertainment, india, kerala) and optionally by interest keywords.",
    {
      sources: z
        .array(z.enum(["bbc", "aljazeera", "timesofindia", "mathrubhumi"]))
        .default(["bbc", "aljazeera", "timesofindia", "mathrubhumi"])
        .describe("Which news sources to fetch from"),
      topic: z
        .enum(["top","world","technology","science","business","health","sport","entertainment","india","kerala"])
        .default("top")
        .describe("News category/topic"),
      interests: z
        .array(z.string())
        .default([])
        .describe('Optional keywords to filter articles, e.g. ["AI", "cricket", "climate"]'),
      count: z
        .number().int().min(1).max(10).default(5)
        .describe("Number of articles per source"),
    },
    { readOnlyHint: true },
    async ({ sources, topic, interests, count }) => {
      const results = [];

      for (const sourceKey of sources) {
        const source = NEWS_SOURCES[sourceKey];
        const feedUrl = source.feeds[topic] ?? source.feeds.top;

        try {
          const articles = await fetchFeed(feedUrl, 20);
          const filtered = articles
            .filter(a => matchesInterests(a, interests))
            .slice(0, count);

          if (filtered.length === 0) {
            results.push(`📰 ${source.name}\n   No articles matched your interests for topic "${topic}".`);
          } else {
            const lines = [`📰 ${source.name} — ${topic.toUpperCase()}`, "─".repeat(50)];
            filtered.forEach((a, i) => lines.push(formatArticle(a, i + 1)));
            results.push(lines.join("\n"));
          }
        } catch (err) {
          results.push(`📰 ${source.name}\n   ⚠️ Could not fetch: ${err.message}`);
        }
      }

      return { content: [{ type: "text", text: results.join("\n\n") }] };
    }
  );

  // Tool 2 — my personalised news digest
  server.tool(
    "my_news_digest",
    "Get a personalised news digest from BBC, Al Jazeera, Times of India, and Mathrubhumi based on saved interest topics. Returns a summary across all 4 sources in one shot.",
    {
      interests: z
        .array(z.string())
        .describe('Your interest keywords, e.g. ["AI", "cricket", "Kerala", "climate", "finance", "politics"]'),
      count: z
        .number().int().min(1).max(8).default(4)
        .describe("Max articles per source"),
    },
    { readOnlyHint: true },
    async ({ interests, count }) => {
      const allSources = ["bbc", "aljazeera", "timesofindia", "mathrubhumi"];
      const results = [`🗞️ YOUR PERSONALISED NEWS DIGEST`, `Keywords: ${interests.join(", ")}`, `${"═".repeat(55)}`];

      for (const sourceKey of allSources) {
        const source = NEWS_SOURCES[sourceKey];
        const feedUrl = source.feeds.top;

        try {
          const articles = await fetchFeed(feedUrl, 30);
          const filtered = articles
            .filter(a => matchesInterests(a, interests))
            .slice(0, count);

          results.push(`\n📰 ${source.name}`);
          results.push("─".repeat(40));

          if (filtered.length === 0) {
            results.push("   No matching articles found.");
          } else {
            filtered.forEach((a, i) => results.push(formatArticle(a, i + 1)));
          }
        } catch (err) {
          results.push(`   ⚠️ Could not fetch: ${err.message}`);
        }
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    }
  );

  // Tool 3 — list available topics per source
  server.tool(
    "list_news_topics",
    "List all available news topics/categories for each news source (BBC, Al Jazeera, Times of India, Mathrubhumi).",
    {},
    { readOnlyHint: true },
    async () => {
      const lines = ["📋 Available topics per news source", "─".repeat(40)];
      for (const [key, src] of Object.entries(NEWS_SOURCES)) {
        lines.push(`\n${src.name} (${key}):`);
        Object.keys(src.feeds).forEach(t => lines.push(`  • ${t}`));
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── CALCULATOR ─────────────────────────────────────────────

  server.tool("calculate","Perform basic arithmetic: add, subtract, multiply, or divide two numbers.",{operation:z.enum(["add","subtract","multiply","divide"]).describe("The operation"),a:z.number().describe("First number"),b:z.number().describe("Second number")},{readOnlyHint:true},async({operation,a,b})=>{if(operation==="divide"&&b===0)return{content:[{type:"text",text:"Error: division by zero"}],isError:true};const ops={add:a+b,subtract:a-b,multiply:a*b,divide:a/b};return{content:[{type:"text",text:`${a} ${operation} ${b} = ${ops[operation]}`}]};});

  server.tool("percentage",'Calculate percentages. Mode "of" → find X% of Y. Mode "is_what_percent" → what % is X of Y.',{mode:z.enum(["of","is_what_percent"]).describe("Which percentage calculation"),x:z.number().describe("First value"),y:z.number().describe("Second value")},{readOnlyHint:true},async({mode,x,y})=>{if(mode==="of")return{content:[{type:"text",text:`${x}% of ${y} = ${(x/100)*y}`}]};if(y===0)return{content:[{type:"text",text:"Error: denominator is zero"}],isError:true};return{content:[{type:"text",text:`${x} is ${((x/y)*100).toFixed(4)}% of ${y}`}]};});

  // ── TEXT TOOLS ─────────────────────────────────────────────

  server.tool("text_stats","Get word count, character count, sentence count, and reading time for any text.",{text:z.string().min(1).describe("The text to analyse")},{readOnlyHint:true},async({text})=>{const words=text.trim().split(/\s+/).filter(Boolean).length;const sentences=(text.match(/[.!?]+/g)??[]).length;return{content:[{type:"text",text:[`Words:         ${words}`,`Characters:    ${text.length}`,`Sentences:     ${sentences}`,`Reading time:  ~${Math.ceil(words/200)} min`].join("\n")}]};});

  server.tool("transform_text","Transform text: uppercase, lowercase, titlecase, reverse, or trim extra spaces.",{text:z.string().min(1).describe("Text to transform"),transform:z.enum(["uppercase","lowercase","titlecase","reverse","trim"])},{readOnlyHint:true},async({text,transform})=>{const result={uppercase:()=>text.toUpperCase(),lowercase:()=>text.toLowerCase(),titlecase:()=>text.replace(/\b\w/g,c=>c.toUpperCase()),reverse:()=>text.split("").reverse().join(""),trim:()=>text.replace(/\s+/g," ").trim()}[transform]();return{content:[{type:"text",text:result}]};});

  // ── DATE & TIME ────────────────────────────────────────────

  server.tool("get_current_time",'Get the current date and time in any timezone, e.g. "America/New_York" or "Asia/Tokyo".',{timezone:z.string().default("UTC").describe("IANA timezone string"),format:z.enum(["human","iso","date_only","time_only"]).default("human")},{readOnlyHint:true},async({timezone,format})=>{try{const opts={timeZone:timezone};const now=new Date();const text={human:now.toLocaleString("en-US",opts),iso:now.toISOString(),date_only:now.toLocaleDateString("en-US",{...opts,dateStyle:"full"}),time_only:now.toLocaleTimeString("en-US",opts)}[format];return{content:[{type:"text",text:`🕐 ${text} (${timezone})`}]};}catch{return{content:[{type:"text",text:`Invalid timezone: "${timezone}"`}],isError:true};}});

  server.tool("date_difference","Find the number of days, weeks, or months between two dates (YYYY-MM-DD).",{from:z.string().describe("Start date YYYY-MM-DD"),to:z.string().describe("End date YYYY-MM-DD"),unit:z.enum(["days","weeks","months"]).default("days")},{readOnlyHint:true},async({from,to,unit})=>{const d1=new Date(from),d2=new Date(to);if(isNaN(d1)||isNaN(d2))return{content:[{type:"text",text:"Invalid date. Use YYYY-MM-DD."}],isError:true};const days=Math.floor(Math.abs(d2-d1)/86400000);const result={days:`${days} days`,weeks:`${(days/7).toFixed(1)} weeks`,months:`${(days/30.44).toFixed(1)} months`}[unit];return{content:[{type:"text",text:`${result} between ${from} and ${to}`}]};});

  // ── WEATHER ────────────────────────────────────────────────

  const WMO={0:"☀️ Clear",1:"🌤 Mainly clear",2:"⛅ Partly cloudy",3:"☁️ Overcast",45:"🌫 Fog",48:"🌫 Icy fog",51:"🌦 Light drizzle",53:"🌦 Drizzle",55:"🌧 Heavy drizzle",61:"🌧 Light rain",63:"🌧 Rain",65:"🌧 Heavy rain",71:"🌨 Light snow",73:"❄️ Snow",75:"❄️ Heavy snow",80:"🌦 Showers",81:"🌧 Heavy showers",82:"⛈ Violent showers",95:"⛈ Thunderstorm",96:"⛈ Thunderstorm+hail",99:"⛈ Severe thunderstorm"};

  async function geocode(city){const r=await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);const d=await r.json();if(!d.results?.length)throw new Error(`City not found: "${city}"`);return d.results[0];}

  server.tool("get_weather","Get current weather for any city in the world. Free, no API key required.",{city:z.string().min(1).describe('City name e.g. "London", "Tokyo"'),units:z.enum(["celsius","fahrenheit"]).default("celsius")},{readOnlyHint:true},async({city,units})=>{try{const loc=await geocode(city);const sym=units==="fahrenheit"?"°F":"°C";const r=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weathercode&temperature_unit=${units}&wind_speed_unit=kmh`);const d=await r.json();const c=d.current;return{content:[{type:"text",text:[`🌍 ${loc.name}, ${loc.country}`,`Condition:   ${WMO[c.weathercode]??c.weathercode}`,`Temperature: ${c.temperature_2m}${sym} (feels ${c.apparent_temperature}${sym})`,`Humidity:    ${c.relative_humidity_2m}%`,`Wind:        ${c.wind_speed_10m} km/h`].join("\n")}]};}catch(e){return{content:[{type:"text",text:`Error: ${e.message}`}],isError:true};}});

  server.tool("get_forecast","Get a 7-day weather forecast for any city. Free, no API key required.",{city:z.string().min(1).describe("City name"),units:z.enum(["celsius","fahrenheit"]).default("celsius")},{readOnlyHint:true},async({city,units})=>{try{const loc=await geocode(city);const sym=units==="fahrenheit"?"°F":"°C";const r=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&temperature_unit=${units}&timezone=auto`);const d=await r.json();const rows=d.daily.time.map((date,i)=>`${date}  ${WMO[d.daily.weathercode[i]]??d.daily.weathercode[i]}  ${d.daily.temperature_2m_min[i]}–${d.daily.temperature_2m_max[i]}${sym}  💧${d.daily.precipitation_sum[i]}mm`);return{content:[{type:"text",text:[`📅 7-Day Forecast: ${loc.name}, ${loc.country}`,"─".repeat(55),...rows].join("\n")}]};}catch(e){return{content:[{type:"text",text:`Error: ${e.message}`}],isError:true};}});

  // ══════════════════════════════════════════════════════════
  //  👇 ADD YOUR OWN TOOL HERE
  // ══════════════════════════════════════════════════════════
  //
  // server.tool(
  //   "my_tool_name",
  //   "Describe what this tool does so Claude knows when to use it.",
  //   { input: z.string().describe("What this input is for") },
  //   { readOnlyHint: true },
  //   async ({ input }) => {
  //     return { content: [{ type: "text", text: `Result: ${input}` }] };
  //   }
  // );

  return server;
}

// ──────────────────────────────────────────────────────────────
//  EXPRESS + STREAMABLE HTTP TRANSPORT
// ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.json({ status: "running", endpoint: "/mcp" }));

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;
  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId);
  } else {
    const id = randomUUID();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: (sid) => sessions.set(sid, transport),
    });
    transport.onclose = () => sessions.delete(transport.sessionId);
    await createMcpServer().connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const t = sessions.get(req.headers["mcp-session-id"]);
  if (!t) return res.status(400).json({ error: "Invalid session" });
  await t.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const t = sessions.get(req.headers["mcp-session-id"]);
  if (t) { await t.handleRequest(req, res); sessions.delete(t.sessionId); }
  else res.status(404).json({ error: "Session not found" });
});

app.listen(PORT, () => console.log(`✅ MCP Connector running on port ${PORT}\n   Endpoint: /mcp`));
