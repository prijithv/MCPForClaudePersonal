/**
 * ============================================================
 *  MY CLAUDE MCP CONNECTOR v3.0
 *  Say "My News" → get your full personalised briefing
 *  Say "My News" again same day → only NEW articles shown
 * ============================================================
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { z } from "zod";

const PORT = process.env.PORT ?? 3000;
const sessions = new Map();

// ── "New since last read" tracker ───────────────────────────
const seenToday = new Map(); // date → Set of titles

function today() { return new Date().toISOString().slice(0, 10); }

function markSeen(titles) {
  const d = today();
  if (!seenToday.has(d)) seenToday.set(d, new Set());
  titles.forEach(t => seenToday.get(d).add(t));
  for (const k of seenToday.keys()) if (k !== d) seenToday.delete(k);
}

function isNew(title) { return !seenToday.get(today())?.has(title); }

// ── RSS parser ───────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  for (const block of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)) {
    const raw = block[1];
    const get = tag =>
      raw.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`))?.[1]
        ?.replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "").trim() ?? "";
    const link = raw.match(/<link>(.*?)<\/link>/)?.[1]?.trim()
      || raw.match(/href="([^"]+)"/)?.[1]?.trim() || "";
    const t = get("title");
    if (t) items.push({ title: t, description: get("description"), link, pubDate: get("pubDate") });
  }
  return items;
}

// ── Fetch RSS ────────────────────────────────────────────────
async function rss(url, n = 5) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MyNewsBot/1.0)" },
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) return [];
    return parseRSS(await r.text()).slice(0, n);
  } catch { return []; }
}

// ── Google News RSS (free, no API key) ──────────────────────
function gnews(q, n = 4) {
  return rss(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`, n);
}

// ── Format one article ───────────────────────────────────────
function art(item, firstRead) {
  const badge = (!firstRead && isNew(item.title)) ? "🆕 " : "";
  const gist  = (item.description || "").slice(0, 160);
  return [
    `  ${badge}▸ ${item.title}`,
    gist ? `    ${gist}${item.description?.length > 160 ? "…" : ""}` : null,
    item.link ? `    🔗 ${item.link}` : null,
  ].filter(Boolean).join("\n");
}

// ── Section header ────────────────────────────────────────────
function sec(emoji, title) {
  return `\n${"━".repeat(52)}\n${emoji}  ${title.toUpperCase()}\n${"━".repeat(52)}`;
}

// ── Sub-section label ─────────────────────────────────────────
const sub = (emoji, label) => `\n${emoji} ${label}`;

// ─────────────────────────────────────────────────────────────
//  MCP SERVER
// ─────────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: "my-claude-connector", version: "3.0.0" });

  // ═══════════════════════════════════════════════════════════
  //  MY NEWS  ←  just say "My News" in Claude
  // ═══════════════════════════════════════════════════════════
  server.tool(
    "my_news",
    `Personalised news briefing. Covers:
     TOP NEWS: Mathrubhumi Malayalam, Times of India, Al Jazeera, BBC
     SPORTS: Cricket, EPL/Football, F1 (seasonal), Wimbledon (seasonal), Olympics (seasonal)
     BUSINESS: AI/Tech, ServiceNow, HR/Workforce, Mergers & Acquisitions
     INVESTMENT: Stock markets, Crypto (Bitcoin/Ethereum), Top investment trends
     PROFESSIONAL: HBR, McKinsey, WSJ, Key figures (Modi/Trump/CEOs), MEA business insights
     TRENDS: Global, India, Kerala, UK, Dubai/UAE
     On same day repeat: shows only NEW articles since last read (marked 🆕).`,
    {
      filter: z
        .enum(["all", "top", "sports", "business", "investment", "professional", "trends"])
        .default("all")
        .describe('Section to show. Default "all" for full briefing. Use others to zoom in.'),
    },
    { readOnlyHint: true },
    async ({ filter }) => {
      const now       = new Date();
      const firstRead = !seenToday.has(today());
      const dateStr   = now.toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Kolkata" });
      const timeStr   = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
      const month     = now.getMonth() + 1;

      const out   = [];
      const seen  = [];

      const push = (items, label) => {
        if (!items.length) return;
        out.push(label);
        items.forEach(i => { out.push(art(i, firstRead)); seen.push(i.title); });
      };

      // ── Header ─────────────────────────────────────────────
      out.push(`🗞️  MY NEWS BRIEFING`);
      out.push(`📅  ${dateStr}  •  🕐 ${timeStr} IST`);
      out.push(firstRead
        ? `📖  Full briefing`
        : `🔄  Showing 🆕 NEW articles since your last read today`);

      // ══════════════════════════════════════════════════════
      //  TOP NEWS
      // ══════════════════════════════════════════════════════
      if (filter === "all" || filter === "top") {
        out.push(sec("📌", "Top News"));

        // Fetch all 4 sources in parallel
        const [mb, toi, aj, bbc] = await Promise.all([
          rss("https://www.mathrubhumi.com/rss", 5),
          rss("https://timesofindia.indiatimes.com/rssfeedstopstories.cms", 5),
          rss("https://www.aljazeera.com/xml/rss/all.xml", 5),
          rss("https://feeds.bbci.co.uk/news/rss.xml", 5),
        ]);

        push(mb,  sub("🔴", "MATHRUBHUMI  (links open in Malayalam)"));
        push(toi, sub("📰", "TIMES OF INDIA"));
        push(aj,  sub("🌍", "AL JAZEERA"));
        push(bbc, sub("🇬🇧", "BBC NEWS"));
      }

      // ══════════════════════════════════════════════════════
      //  SPORTS
      // ══════════════════════════════════════════════════════
      if (filter === "all" || filter === "sports") {
        out.push(sec("🏆", "Sports"));

        const sportFeeds = [
          rss("https://feeds.bbci.co.uk/sport/cricket/rss.xml", 4),
          rss("https://feeds.bbci.co.uk/sport/football/rss.xml", 4),
        ];

        // Seasonal feeds
        if (month >= 3 && month <= 11) sportFeeds.push(rss("https://feeds.bbci.co.uk/sport/formula1/rss.xml", 3));
        if (month === 6 || month === 7) sportFeeds.push(gnews("Wimbledon 2026", 3));
        // Olympics: check year — next Summer 2028, Winter 2026 (Feb)
        if (month <= 3) sportFeeds.push(gnews("Olympics 2026", 3));

        const [cricket, football, ...seasonal] = await Promise.all(sportFeeds);

        push(cricket,  sub("🏏", "CRICKET"));
        push(football, sub("⚽", "FOOTBALL / EPL"));

        let si = 0;
        if (month >= 3 && month <= 11 && seasonal[si]) { push(seasonal[si], sub("🏎️", "FORMULA 1")); si++; }
        if ((month === 6 || month === 7) && seasonal[si]) { push(seasonal[si], sub("🎾", "WIMBLEDON")); si++; }
        if (month <= 3 && seasonal[si]) { push(seasonal[si], sub("🥇", "OLYMPICS")); si++; }
      }

      // ══════════════════════════════════════════════════════
      //  BUSINESS & TECH
      // ══════════════════════════════════════════════════════
      if (filter === "all" || filter === "business") {
        out.push(sec("💼", "Business & Tech"));

        const [ai, snow, hr, ma] = await Promise.all([
          gnews("artificial intelligence AI enterprise 2026", 4),
          gnews("ServiceNow", 3),
          gnews("human resources workforce future of work 2026", 3),
          gnews("merger acquisition deal billion 2026", 3),
        ]);

        push(ai,   sub("🤖", "AI & TECHNOLOGY"));
        push(snow, sub("🔧", "SERVICENOW"));
        push(hr,   sub("👥", "HUMAN RESOURCES"));
        push(ma,   sub("🤝", "MERGERS & ACQUISITIONS"));
      }

      // ══════════════════════════════════════════════════════
      //  INVESTMENT
      // ══════════════════════════════════════════════════════
      if (filter === "all" || filter === "investment") {
        out.push(sec("📈", "Investment"));

        const [stocks, crypto, trends] = await Promise.all([
          gnews("stock market Sensex Nifty S&P trend 2026", 3),
          gnews("bitcoin ethereum crypto 2026", 3),
          gnews("investment venture capital IPO startup funding 2026", 3),
        ]);

        push(stocks, sub("📊", "STOCK MARKETS"));
        push(crypto, sub("₿",  "CRYPTO"));
        push(trends, sub("💡", "TOP INVESTMENT TRENDS"));
      }

      // ══════════════════════════════════════════════════════
      //  PROFESSIONAL INSIGHTS
      // ══════════════════════════════════════════════════════
      if (filter === "all" || filter === "professional") {
        out.push(sec("🎓", "Professional Insights"));

        const [hbr, mckinsey, wsj, leaders, mea] = await Promise.all([
          rss("https://feeds.hbr.org/harvardbusiness", 3),
          gnews("McKinsey Global Institute insight report", 3),
          gnews("Wall Street Journal WSJ business strategy", 3),
          gnews("Modi Trump CEO chairman statement speech business 2026", 3),
          gnews("Middle East Africa MEA India business investment trade 2026", 3),
        ]);

        push(hbr,      sub("📚", "HARVARD BUSINESS REVIEW"));
        push(mckinsey, sub("🏢", "McKINSEY"));
        push(wsj,      sub("📰", "WALL STREET JOURNAL"));
        push(leaders,  sub("🗣️",  "KEY FIGURES & LEADERS"));
        push(mea,      sub("🌍", "MEA BUSINESS (India–Middle East–Africa)"));
      }

      // ══════════════════════════════════════════════════════
      //  INTERESTING TRENDS
      // ══════════════════════════════════════════════════════
      if (filter === "all" || filter === "trends") {
        out.push(sec("🌐", "Interesting Trends"));

        const [global, india, kerala, uk, dubai] = await Promise.all([
          gnews("global trend innovation 2026", 3),
          rss("https://timesofindia.indiatimes.com/rssfeeds/296589292.cms", 3),
          gnews("Kerala news 2026", 3),
          rss("https://feeds.bbci.co.uk/news/uk/rss.xml", 3),
          gnews("Dubai UAE news business 2026", 3),
        ]);

        push(global, sub("🌏", "GLOBAL"));
        push(india,  sub("🇮🇳", "INDIA"));
        push(kerala, sub("🌴", "KERALA"));
        push(uk,     sub("🇬🇧", "UK"));
        push(dubai,  sub("🏙️",  "DUBAI / UAE"));
      }

      // ── Footer ─────────────────────────────────────────────
      out.push(`\n${"━".repeat(52)}`);
      out.push(`📖 ${seen.length} articles  •  💬 Try: "My News sports"  |  "My News business"  |  "My News investment"`);

      markSeen(seen);
      return { content: [{ type: "text", text: out.join("\n") }] };
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  WEATHER (kept from before)
  // ═══════════════════════════════════════════════════════════
  const WMO = { 0:"☀️ Clear",1:"🌤 Mainly clear",2:"⛅ Partly cloudy",3:"☁️ Overcast",45:"🌫 Fog",48:"🌫 Icy fog",51:"🌦 Light drizzle",53:"🌦 Drizzle",55:"🌧 Heavy drizzle",61:"🌧 Light rain",63:"🌧 Rain",65:"🌧 Heavy rain",71:"🌨 Light snow",73:"❄️ Snow",75:"❄️ Heavy snow",80:"🌦 Showers",81:"🌧 Heavy showers",82:"⛈ Violent showers",95:"⛈ Thunderstorm",96:"⛈ Thunderstorm+hail",99:"⛈ Severe thunderstorm" };
  async function geocode(city) { const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`); const d = await r.json(); if (!d.results?.length) throw new Error(`City not found: "${city}"`); return d.results[0]; }

  server.tool("get_weather","Get current weather for any city.",{city:z.string().min(1).describe("City name"),units:z.enum(["celsius","fahrenheit"]).default("celsius")},{readOnlyHint:true},async({city,units})=>{try{const loc=await geocode(city);const sym=units==="fahrenheit"?"°F":"°C";const r=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weathercode&temperature_unit=${units}&wind_speed_unit=kmh`);const d=await r.json();const c=d.current;return{content:[{type:"text",text:[`🌍 ${loc.name}, ${loc.country}`,`Condition:   ${WMO[c.weathercode]??c.weathercode}`,`Temperature: ${c.temperature_2m}${sym} (feels ${c.apparent_temperature}${sym})`,`Humidity:    ${c.relative_humidity_2m}%`,`Wind:        ${c.wind_speed_10m} km/h`].join("\n")}]};}catch(e){return{content:[{type:"text",text:`Error: ${e.message}`}],isError:true};}});

  server.tool("get_forecast","Get 7-day weather forecast for any city.",{city:z.string().min(1).describe("City name"),units:z.enum(["celsius","fahrenheit"]).default("celsius")},{readOnlyHint:true},async({city,units})=>{try{const loc=await geocode(city);const sym=units==="fahrenheit"?"°F":"°C";const r=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&temperature_unit=${units}&timezone=auto`);const d=await r.json();const rows=d.daily.time.map((date,i)=>`${date}  ${WMO[d.daily.weathercode[i]]??d.daily.weathercode[i]}  ${d.daily.temperature_2m_min[i]}–${d.daily.temperature_2m_max[i]}${sym}  💧${d.daily.precipitation_sum[i]}mm`);return{content:[{type:"text",text:[`📅 7-Day Forecast: ${loc.name}, ${loc.country}`,"─".repeat(55),...rows].join("\n")}]};}catch(e){return{content:[{type:"text",text:`Error: ${e.message}`}],isError:true};}});

  // ═══════════════════════════════════════════════════════════
  //  CALCULATOR (kept from before)
  // ═══════════════════════════════════════════════════════════
  server.tool("calculate","Perform basic arithmetic.",{operation:z.enum(["add","subtract","multiply","divide"]),a:z.number(),b:z.number()},{readOnlyHint:true},async({operation,a,b})=>{if(operation==="divide"&&b===0)return{content:[{type:"text",text:"Error: division by zero"}],isError:true};const ops={add:a+b,subtract:a-b,multiply:a*b,divide:a/b};return{content:[{type:"text",text:`${a} ${operation} ${b} = ${ops[operation]}`}]};});

  // ══════════════════════════════════════════════════════════
  //  👇 ADD YOUR OWN TOOLS BELOW
  // ══════════════════════════════════════════════════════════

  return server;
}

// ─────────────────────────────────────────────────────────────
//  EXPRESS + STREAMABLE HTTP TRANSPORT
// ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.get("/", (_req, res) => res.json({ status: "running", endpoint: "/mcp", version: "3.0.0" }));

app.post("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  let transport;
  if (sid && sessions.has(sid)) {
    transport = sessions.get(sid);
  } else {
    const id = randomUUID();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: s => sessions.set(s, transport),
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

app.listen(PORT, () => console.log(`✅  My News Connector v3.0 on port ${PORT}`));
