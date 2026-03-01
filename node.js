/**
 * ╔═══════════════════════════════════════════╗
 * ║       AETHON — Single File Server         ║
 * ║  Node.js + Express — All-in-one           ║
 * ╚═══════════════════════════════════════════╝
 *
 * SETUP:
 *   1. npm install express cors dotenv openai @anthropic-ai/sdk @google/generative-ai ws uuid
 *   2. Set environment variables (or create .env):
 *      OPENAI_API_KEY=sk-...
 *      ANTHROPIC_API_KEY=sk-ant-...
 *      GEMINI_API_KEY=AIza...
 *   3. node AETHON-server.js
 *   4. Open http://localhost:3001
 */

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuid } from 'uuid';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env manually if exists
try {
  const envPath = '.env';
  if (existsSync(envPath)) {
    readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [k, ...v] = line.split('=');
      if (k && v.length) process.env[k.trim()] = v.join('=').trim();
    });
  }
} catch(e) {}

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────
// AI ROUTER
// ─────────────────────────────────────────────
async function* streamChat({ provider, model, messages, systemPrompt, temperature = 0.7 }) {
  if (provider === 'openai') {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const msgs = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push(...messages);
    const stream = await client.chat.completions.create({ model, messages: msgs, temperature, stream: true });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) yield text;
    }
  } else if (provider === 'anthropic') {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const stream = await client.messages.stream({ model, max_tokens: 8096, system: systemPrompt, messages, temperature });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') yield chunk.delta.text;
    }
  } else if (provider === 'gemini') {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const genModel = genAI.getGenerativeModel({ model, generationConfig: { temperature }, systemInstruction: systemPrompt });
    const history = messages.slice(0, -1).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const chat = genModel.startChat({ history });
    const result = await chat.sendMessageStream(messages[messages.length - 1].content);
    for await (const chunk of result.stream) { const t = chunk.text(); if (t) yield t; }
  } else {
    throw new Error('Unknown provider: ' + provider);
  }
}

async function chat(payload) {
  let result = '';
  for await (const chunk of streamChat(payload)) result += chunk;
  return result;
}

// ─────────────────────────────────────────────
// AGENTS
// ─────────────────────────────────────────────
const AGENT_SYSTEM = `You are AETHON, an advanced AI agent. Be helpful, precise, and insightful.`;

class Agent {
  constructor(cfg) {
    this.id = uuid();
    this.name = cfg.name || 'Agent';
    this.description = cfg.description || '';
    this.provider = cfg.provider || process.env.DEFAULT_PROVIDER || 'gemini';
    this.model = cfg.model || 'gemini-1.5-flash';
    this.systemPrompt = cfg.systemPrompt || AGENT_SYSTEM;
    this.status = 'idle';
    this.memory = [];
    this.stats = { messages: 0 };
    this.createdAt = new Date().toISOString();
  }
  async run(msg, onChunk) {
    this.status = 'running';
    this.memory.push({ role: 'user', content: msg });
    let response = '';
    try {
      for await (const chunk of streamChat({ provider: this.provider, model: this.model, messages: this.memory, systemPrompt: this.systemPrompt })) {
        response += chunk;
        onChunk?.(chunk);
      }
      this.memory.push({ role: 'assistant', content: response });
      this.stats.messages++;
      this.status = 'idle';
      return response;
    } catch(e) { this.status = 'error'; throw e; }
  }
  toJSON() {
    return { id: this.id, name: this.name, description: this.description, provider: this.provider, model: this.model, status: this.status, memoryLength: this.memory.length, createdAt: this.createdAt, stats: this.stats };
  }
}

class AgentManager {
  constructor() {
    this.agents = new Map();
    [
      { name: 'Commander', description: 'Primary orchestration agent', provider: 'gemini', model: 'gemini-1.5-flash' },
      { name: 'Analyst', description: 'Deep analysis & research agent', provider: 'gemini', model: 'gemini-1.5-pro' },
      { name: 'Coder', description: 'Code generation & debugging', systemPrompt: 'You are an expert software engineer. Write clean, well-commented code.' },
    ].forEach(cfg => { const a = new Agent(cfg); this.agents.set(a.id, a); });
  }
  create(cfg) { const a = new Agent(cfg); this.agents.set(a.id, a); return a; }
  get(id) { return this.agents.get(id); }
  list() { return Array.from(this.agents.values()).map(a => a.toJSON()); }
  delete(id) { return this.agents.delete(id); }
  stats() {
    const a = Array.from(this.agents.values());
    return { total: a.length, running: a.filter(x => x.status === 'running').length, idle: a.filter(x => x.status === 'idle').length };
  }
}

const agentManager = new AgentManager();

// ─────────────────────────────────────────────
// TOOLS
// ─────────────────────────────────────────────
const TOOLS = [
  { id: 'web_search', name: 'Web Search', description: 'Search the internet', category: 'search', enabled: true },
  { id: 'code_exec', name: 'Code Executor', description: 'Execute code snippets', category: 'compute', enabled: true },
  { id: 'file_read', name: 'File Reader', description: 'Read and analyze files', category: 'filesystem', enabled: true },
  { id: 'calculator', name: 'Calculator', description: 'Math and computation', category: 'utility', enabled: true },
  { id: 'summarizer', name: 'Summarizer', description: 'Summarize long content', category: 'ai', enabled: true },
];

// ─────────────────────────────────────────────
// TASKS
// ─────────────────────────────────────────────
const tasks = new Map();

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health
app.get('/health', (req, res) => res.json({ status: 'online', version: '1.0.0', timestamp: new Date().toISOString(), agents: agentManager.stats() }));

// Models
const MODEL_REGISTRY = {
  openai: { name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'gpt-4o-mini', name: 'GPT-4o Mini' }, { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }] },
  anthropic: { name: 'Anthropic', models: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }, { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }, { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' }] },
  gemini: { name: 'Google Gemini', models: [{ id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' }, { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' }] },
};
app.get('/api/models', (req, res) => res.json(MODEL_REGISTRY));
app.get('/api/models/all', (req, res) => {
  const all = Object.entries(MODEL_REGISTRY).flatMap(([p, info]) => info.models.map(m => ({ ...m, provider: p })));
  res.json(all);
});

// Chat — streaming SSE
app.post('/api/chat/stream', async (req, res) => {
  const { provider = 'gemini', model = 'gemini-1.5-flash', messages, systemPrompt, temperature } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  try {
    for await (const chunk of streamChat({ provider, model, messages, systemPrompt, temperature })) {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
  } catch(e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  } finally { res.end(); }
});

// Chat — sync
app.post('/api/chat', async (req, res) => {
  const { provider = 'gemini', model = 'gemini-1.5-flash', messages, systemPrompt, temperature } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });
  try {
    const response = await chat({ provider, model, messages, systemPrompt, temperature });
    res.json({ response, provider, model });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Agents
app.get('/api/agents', (req, res) => res.json(agentManager.list()));
app.post('/api/agents', (req, res) => res.status(201).json(agentManager.create(req.body).toJSON()));
app.get('/api/agents/:id', (req, res) => {
  const a = agentManager.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json(a.toJSON());
});
app.delete('/api/agents/:id', (req, res) => {
  if (!agentManager.delete(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});
app.post('/api/agents/:id/run', async (req, res) => {
  const agent = agentManager.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Not found' });
  if (!req.body.message) return res.status(400).json({ error: 'message required' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  try {
    await agent.run(req.body.message, chunk => res.write(`data: ${JSON.stringify({ chunk })}\n\n`));
    res.write('data: [DONE]\n\n');
  } catch(e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  } finally { res.end(); }
});
app.post('/api/agents/:id/clear', (req, res) => {
  const a = agentManager.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  a.memory = [];
  res.json({ success: true });
});

// Tasks
app.get('/api/tasks', (req, res) => res.json(Array.from(tasks.values())));
app.post('/api/tasks', (req, res) => {
  const task = { id: uuid(), ...req.body, status: 'pending', createdAt: new Date().toISOString() };
  tasks.set(task.id, task);
  res.status(201).json(task);
});
app.patch('/api/tasks/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  Object.assign(t, req.body, { updatedAt: new Date().toISOString() });
  res.json(t);
});
app.delete('/api/tasks/:id', (req, res) => { tasks.delete(req.params.id); res.json({ success: true }); });

// Tools
app.get('/api/tools', (req, res) => res.json(TOOLS));
app.post('/api/tools/execute', async (req, res) => {
  const { toolId, params } = req.body;
  const tool = TOOLS.find(t => t.id === toolId);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  await new Promise(r => setTimeout(r, 200));
  res.json({ toolId, result: `[${tool.name}] executed: ${JSON.stringify(params)}`, timestamp: new Date().toISOString() });
});

// Terminal (safe)
const ALLOWED = new Set(['ls','pwd','echo','date','whoami','uname','cat','head','tail','wc','grep','node','npm','git','python3']);
app.get('/api/terminal/allowed', (req, res) => res.json({ commands: Array.from(ALLOWED) }));
app.post('/api/terminal/execute', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  const base = command.trim().split(/\s+/)[0];
  if (!ALLOWED.has(base)) return res.status(403).json({ error: `Command not allowed: ${base}` });
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 8000 });
    res.json({ stdout, stderr, exitCode: 0, command });
  } catch(e) {
    res.json({ stdout: '', stderr: e.message, exitCode: 1, command });
  }
});

// Serve AETHON.html at root
app.get('/', (req, res) => {
  const htmlPath = join(dirname(fileURLToPath(import.meta.url)), 'AETHON.html');
  if (existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send(`<html><body style="background:#070b12;color:#e2e8f0;font-family:monospace;padding:40px">
      <h1 style="color:#00d4ff">⚡ AETHON Backend Running</h1>
      <p>API is live at <a href="/health" style="color:#00d4ff">/health</a></p>
      <p style="color:#64748b">Place AETHON.html in the same folder to serve the UI.</p>
    </body></html>`);
  }
});

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, id } = msg;

    if (type === 'chat') {
      ws.send(JSON.stringify({ type: 'chat_start', id }));
      let full = '';
      try {
        for await (const chunk of streamChat(msg)) {
          full += chunk;
          ws.send(JSON.stringify({ type: 'chat_chunk', id, chunk }));
        }
        ws.send(JSON.stringify({ type: 'chat_end', id, fullText: full }));
      } catch(e) {
        ws.send(JSON.stringify({ type: 'chat_error', id, message: e.message }));
      }
    } else if (type === 'agent_run') {
      const agent = agentManager.get(msg.agentId);
      if (!agent) { ws.send(JSON.stringify({ type: 'error', message: 'Agent not found' })); return; }
      ws.send(JSON.stringify({ type: 'agent_start', id, agentId: msg.agentId }));
      try {
        await agent.run(msg.message, chunk => ws.send(JSON.stringify({ type: 'agent_chunk', id, agentId: msg.agentId, chunk })));
        ws.send(JSON.stringify({ type: 'agent_end', id, agentId: msg.agentId }));
      } catch(e) {
        ws.send(JSON.stringify({ type: 'agent_error', id, message: e.message }));
      }
    } else if (type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
    }
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n⚡ AETHON Server running!`);
  console.log(`🌐 UI:  http://localhost:${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api`);
  console.log(`🔌 WS:  ws://localhost:${PORT}/ws`);
  console.log(`\n🤖 Providers configured:`);
  console.log(`   ${process.env.OPENAI_API_KEY ? '✅' : '❌'} OpenAI`);
  console.log(`   ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌'} Anthropic`);
  console.log(`   ${process.env.GEMINI_API_KEY ? '✅' : '❌'} Gemini\n`);
});