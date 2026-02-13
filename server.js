import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { Resend } from "resend";

dotenv.config();

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 4311;
const ROOT = path.resolve(".");
const DATA_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "tasks.json");
let memoryStore = { tasks: [], warRoom: { messages: [] } };

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

app.use(express.json());
app.use(express.static(path.join(ROOT, "public")));

let INDEX_HTML = "<h1>Mission Control MVP</h1>";
try {
  INDEX_HTML = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
} catch {}

function ensureStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify(memoryStore, null, 2));
  } catch {}
}

function normalizeStore(raw) {
  return {
    tasks: Array.isArray(raw?.tasks) ? raw.tasks : [],
    warRoom: {
      messages: Array.isArray(raw?.warRoom?.messages) ? raw.warRoom.messages : [],
    },
  };
}

function readStore() {
  try {
    ensureStore();
    if (fs.existsSync(STORE_FILE)) return normalizeStore(JSON.parse(fs.readFileSync(STORE_FILE, "utf8")));
  } catch {}
  return normalizeStore(memoryStore);
}

function writeStore(data) {
  memoryStore = normalizeStore(data);
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(memoryStore, null, 2));
  } catch {}
}

async function runJson(command, args = []) {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function demoOverview() {
  return {
    agents: [
      { id: "main", model: "openai-codex/gpt-5.3-codex" },
      { id: "codex", model: "openai-codex/gpt-5.3-codex" },
      { id: "research", model: "google-antigravity/claude-opus-4-5-thinking" },
      { id: "quote", model: "openai-codex/gpt-5.3-codex" },
      { id: "invoice", model: "openai-codex/gpt-5.3-codex" },
      { id: "integration", model: "openai-codex/gpt-5.3-codex" }
    ],
    sessionsByAgent: { main: [], codex: [], research: [], quote: [], invoice: [], integration: [] },
  };
}

function sessionStoreFromAgentDir(agentDir) {
  return path.join(path.dirname(agentDir), "sessions", "sessions.json");
}

async function getAgents() {
  return runJson("openclaw", ["agents", "list", "--json"]);
}

async function getSessionsByAgent(agents) {
  const out = {};
  await Promise.all(
    agents.map(async (agent) => {
      try {
        const store = sessionStoreFromAgentDir(agent.agentDir);
        const sessions = await runJson("openclaw", ["sessions", "--json", "--store", store]);
        out[agent.id] = sessions.sessions || [];
      } catch {
        out[agent.id] = [];
      }
    })
  );
  return out;
}

function extractMentions(text, allowedAgents) {
  const m = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  const ids = [...new Set(m.map((x) => x.slice(1).toLowerCase()))];
  return ids.filter((id) => allowedAgents.includes(id));
}

async function askAgent(agentId, message, timeout = "180") {
  return runJson("openclaw", ["agent", "--agent", agentId, "--message", message, "--json", "--timeout", timeout]);
}

async function appendSheetRow(sheetName, values) {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH
    ? path.join(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_PATH)
    : null;
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!spreadsheetId) return { ok: false, reason: "missing_spreadsheet" };

  try {
    let auth;
    if (keyJson) {
      const credentials = JSON.parse(keyJson);
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
    } else if (keyPath && fs.existsSync(keyPath)) {
      auth = new google.auth.GoogleAuth({
        keyFile: keyPath,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
    } else {
      return { ok: false, reason: "missing_google_credentials" };
    }

    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

app.get("/", (_req, res) => res.type("html").send(INDEX_HTML));

app.get("/api/overview", async (_req, res) => {
  try {
    const store = readStore();
    let agents;
    let sessionsByAgent;
    try {
      agents = await getAgents();
      sessionsByAgent = await getSessionsByAgent(agents);
    } catch {
      const demo = demoOverview();
      agents = demo.agents;
      sessionsByAgent = demo.sessionsByAgent;
    }

    res.json({
      agents,
      sessionsByAgent,
      tasks: store.tasks.sort((a, b) => b.createdAt - a.createdAt),
      warRoom: { messages: store.warRoom.messages.slice(-120) },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/tasks", async (req, res) => {
  const { title, agentId, details } = req.body || {};
  if (!title || !agentId) return res.status(400).json({ error: "title and agentId are required" });

  const store = readStore();
  const task = {
    id: `task_${Date.now()}`,
    title,
    details: details || "",
    agentId,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    logs: [{ at: Date.now(), text: `Task queued for ${agentId}` }],
  };
  store.tasks.push(task);
  writeStore(store);

  await appendSheetRow("tasks", [
    new Date(task.createdAt).toISOString(),
    task.id,
    task.title,
    task.agentId,
    task.status,
    task.details,
  ]);

  res.json(task);
});

app.post("/api/tasks/:id/dispatch", async (req, res) => {
  const store = readStore();
  const task = store.tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });

  task.status = "in_progress";
  task.updatedAt = Date.now();
  task.logs.push({ at: Date.now(), text: "Dispatching to agent..." });
  writeStore(store);

  try {
    const prompt = [
      `You are assigned task: ${task.title}`,
      task.details ? `Details: ${task.details}` : "",
      "Return: (1) brief plan, (2) execution result, (3) next steps.",
    ].filter(Boolean).join("\n");

    const result = await askAgent(task.agentId, prompt, "300");
    task.status = "done";
    task.updatedAt = Date.now();
    task.result = result;
    task.logs.push({ at: Date.now(), text: "Task completed" });
    writeStore(store);
    res.json(task);
  } catch (err) {
    task.status = "failed";
    task.updatedAt = Date.now();
    task.error = String(err);
    task.logs.push({ at: Date.now(), text: `Task failed: ${String(err)}` });
    writeStore(store);
    res.status(500).json({ error: String(err), task });
  }
});

app.get("/api/war-room", (_req, res) => {
  const store = readStore();
  res.json({ messages: store.warRoom.messages.slice(-120) });
});

app.post("/api/war-room/message", async (req, res) => {
  const { author = "orchestrator", text = "" } = req.body || {};
  if (!text.trim()) return res.status(400).json({ error: "text is required" });

  const store = readStore();
  const userMsg = { id: `msg_${Date.now()}`, at: Date.now(), author, text: text.trim() };
  store.warRoom.messages.push(userMsg);

  let agentIds = ["main", "codex", "research", "quote", "invoice", "integration"];
  try {
    const agents = await getAgents();
    agentIds = agents.map((a) => a.id);
  } catch {}

  const mentions = extractMentions(text, agentIds);
  const targets = mentions.length ? mentions : ["research", "codex", "quote", "invoice", "integration"];

  for (const target of targets.slice(0, 5)) {
    try {
      const prompt = [
        `War room thread message from ${author}:`,
        text,
        "Reply with concise input. If no value to add, reply exactly: REPLY_SKIP",
      ].join("\n");
      const result = await askAgent(target, prompt, "120");
      const replyText = result?.reply ?? result?.text ?? JSON.stringify(result).slice(0, 800);
      if (String(replyText).trim() !== "REPLY_SKIP") {
        store.warRoom.messages.push({
          id: `msg_${Date.now()}_${target}`,
          at: Date.now(),
          author: target,
          text: String(replyText).slice(0, 2000),
          parentId: userMsg.id,
        });
      }
    } catch {
      const fallbackByAgent = {
        quote: "Suggested quote logic: base fee + urgency surcharge + after-hours multiplier + travel band. Show assumptions clearly.",
        invoice: "Suggested invoice flow: issue instantly after booking confirmation, send payment link, auto-remind at +24h and +72h.",
        integration: "Integration note: persist event with idempotency key, then fan-out to Sheets/DB/Email with retry queue.",
        research: "Market input: prioritize missed-call recovery and fast booking confirmation as primary ROI hooks.",
        codex: "Build input: keep handlers stateless, validate payloads with schemas, and log structured events for replay.",
        main: "Orchestrator input: assign by intent (booking/quote/invoice/support) and escalate uncertain requests to human.",
      };
      store.warRoom.messages.push({
        id: `msg_${Date.now()}_${target}_fallback`,
        at: Date.now(),
        author: target,
        text: fallbackByAgent[target] || "No additional input.",
        parentId: userMsg.id,
      });
    }
  }

  writeStore(store);
  res.json({ ok: true, message: userMsg, thread: store.warRoom.messages.slice(-120) });
});

app.get('/api/integrations/status', async (_req, res) => {
  const googleKeyPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH
    ? path.join(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_PATH)
    : null;
  const googleReady = !!((googleKeyPath && fs.existsSync(googleKeyPath)) || process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  let supabaseOk = false;
  if (supabase) {
    try {
      const { error } = await supabase.from('bookings').select('id', { head: true, count: 'exact' });
      supabaseOk = !error;
    } catch {}
  }

  res.json({
    supabase: { configured: !!supabase, ok: supabaseOk },
    resend: { configured: !!resend },
    googleServiceAccount: { configured: googleReady },
    needs: {
      spreadsheetId: !process.env.SPREADSHEET_ID,
      calendarId: !process.env.GOOGLE_CALENDAR_ID,
      fromEmail: !process.env.RESEND_FROM_EMAIL,
    },
  });
});

app.post('/api/quotes/create', async (req, res) => {
  const { customer_name, service_type, notes = '', base_price = 0, callout_fee = 0 } = req.body || {};
  if (!customer_name || !service_type) return res.status(400).json({ error: 'customer_name and service_type required' });

  const quote = {
    id: `Q-${Date.now()}`,
    customer_name,
    service_type,
    notes,
    line_items: [
      { label: 'Base service', amount: Number(base_price) || 0 },
      { label: 'Callout fee', amount: Number(callout_fee) || 0 },
    ],
  };
  quote.total = quote.line_items.reduce((s, x) => s + x.amount, 0);

  if (supabase) {
    try {
      await supabase.from('quotes').insert([{ ...quote, created_at: new Date().toISOString() }]);
    } catch {}
  }

  await appendSheetRow("quotes", [
    new Date().toISOString(),
    quote.id,
    quote.customer_name,
    quote.service_type,
    quote.total,
    quote.notes,
  ]);

  res.json({ ok: true, quote });
});

app.post('/api/invoices/create', async (req, res) => {
  const { customer_name, email, quote_id, amount } = req.body || {};
  if (!customer_name || !amount) return res.status(400).json({ error: 'customer_name and amount required' });

  const invoice = {
    id: `INV-${Date.now()}`,
    customer_name,
    email: email || null,
    quote_id: quote_id || null,
    amount: Number(amount),
    status: 'issued',
    issued_at: new Date().toISOString(),
  };

  if (supabase) {
    try {
      await supabase.from('invoices').insert([invoice]);
    } catch {}
  }

  if (resend && email && process.env.RESEND_FROM_EMAIL) {
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL,
        to: email,
        subject: `Invoice ${invoice.id}`,
        html: `<p>Hello ${customer_name}, your invoice amount is <b>${invoice.amount}</b>.</p>`,
      });
      invoice.email_sent = true;
    } catch {
      invoice.email_sent = false;
    }
  }

  await appendSheetRow("invoices", [
    new Date().toISOString(),
    invoice.id,
    invoice.customer_name,
    invoice.amount,
    invoice.status,
    invoice.email || "",
  ]);

  res.json({ ok: true, invoice });
});

ensureStore();
export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Mission Control MVP running on http://localhost:${PORT}`);
  });
}
