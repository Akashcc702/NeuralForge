require('dotenv').config();
const express  = require('express');
const fs       = require('fs-extra');
const path     = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app  = express();
const PORT = process.env.PORT || 3001;
const WORKSPACE      = path.join(process.cwd(), 'workspace');
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const MODEL = process.env.MODEL || 'openrouter/free';

// ── Bootstrap workspace ────────────────────────────────────────────────────
fs.ensureDirSync(WORKSPACE);
const bootHtml = path.join(WORKSPACE, 'index.html');
if (!fs.existsSync(bootHtml)) {
  fs.writeFileSync(bootHtml, `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My App</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
    font-family: system-ui, sans-serif; color: #fff;
  }
  .card {
    text-align: center; padding: 48px 56px;
    background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12);
    border-radius: 20px; backdrop-filter: blur(12px);
    box-shadow: 0 32px 80px rgba(0,0,0,.4);
  }
  h1 { font-size: 2.4rem; font-weight: 800; margin-bottom: 12px; }
  h1 span { background: linear-gradient(90deg,#a78bfa,#60a5fa); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  p  { color: rgba(255,255,255,.55); font-size: 1rem; margin-bottom: 28px; }
  .badge {
    display: inline-block; padding: 8px 20px;
    background: linear-gradient(90deg,#6366f1,#8b5cf6);
    border-radius: 99px; font-size: .85rem; font-weight: 600;
    box-shadow: 0 4px 20px rgba(99,102,241,.4);
  }
</style>
</head>
<body>
  <div class="card">
    <h1>⚡ <span>VibeCraft</span></h1>
    <p>Your AI just booted the workspace.<br>Ask it to build something amazing!</p>
    <span class="badge">Ready to build →</span>
  </div>
</body>
</html>`);
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// ── Serve NeuralForge UI ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── LIVE PREVIEW: serve workspace files at /preview/* ─────────────────────
app.use('/preview', express.static(WORKSPACE));
// Fallback: root /preview → index.html
app.get('/preview', (_req, res) => res.sendFile(path.join(WORKSPACE, 'index.html')));

// ── Safety path ────────────────────────────────────────────────────────────
function safePath(p) {
  const resolved = path.resolve(WORKSPACE, p || '.');
  if (!resolved.startsWith(WORKSPACE)) throw new Error('Path traversal blocked');
  return resolved;
}

// ── Tool implementations ───────────────────────────────────────────────────
async function executeTool(name, args) {
  try {
    switch (name) {
      case 'list_files': {
        const dir = safePath(args.path);
        if (!await fs.pathExists(dir)) return `Not found: ${args.path}`;
        const items = await fs.readdir(dir, { withFileTypes: true });
        return JSON.stringify(
          items.filter(i => i.name !== 'node_modules' && !i.name.startsWith('.'))
               .map(i => ({ name: i.name, type: i.isDirectory() ? 'dir' : 'file' })), null, 2
        );
      }
      case 'read_file': {
        const fp = safePath(args.path);
        if (!await fs.pathExists(fp)) return `Not found: ${args.path}`;
        const c = await fs.readFile(fp, 'utf8');
        return c.length > 8000 ? c.slice(0, 8000) + '\n...[truncated]' : c;
      }
      case 'write_file': {
        const fp = safePath(args.path);
        await fs.ensureDir(path.dirname(fp));
        await fs.writeFile(fp, args.content, 'utf8');
        return `✓ Written: ${args.path}`;
      }
      case 'delete_file': {
        await fs.remove(safePath(args.path));
        return `✓ Deleted: ${args.path}`;
      }
      case 'execute_command': {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: WORKSPACE, timeout: 30000, maxBuffer: 2 * 1024 * 1024
        });
        return ([stdout, stderr ? `[stderr] ${stderr}` : ''].filter(Boolean).join('\n')).trim() || '(no output)';
      }
      default: return `Unknown tool: ${name}`;
    }
  } catch (e) { return `Error: ${e.message}`; }
}

// ── Tool parsing ───────────────────────────────────────────────────────────
function parseToolCalls(text) {
  const calls = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { calls.push({ raw: m[0], ...JSON.parse(m[1]) }); } catch {}
  }
  return calls;
}
function stripToolCalls(t) { return t.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim(); }

// ── System prompt ──────────────────────────────────────────────────────────
const SYSTEM = `You are VibeCraft, an elite AI full-stack developer. You build complete, beautiful, production-ready web apps by writing HTML/CSS/JS files to the workspace. Users see a LIVE PREVIEW of the workspace instantly.

TOOLS — output these exact XML blocks when needed:

<tool_call>{"name":"write_file","args":{"path":"index.html","content":"..."}}</tool_call>
<tool_call>{"name":"read_file","args":{"path":"index.html"}}</tool_call>
<tool_call>{"name":"list_files","args":{"path":"."}}</tool_call>
<tool_call>{"name":"execute_command","args":{"command":"npm install"}}</tool_call>
<tool_call>{"name":"delete_file","args":{"path":"old.js"}}</tool_call>

RULES:
1. Always build complete, stunning, production-ready HTML/CSS/JS.
2. Write beautiful, modern UI — gradients, animations, glassmorphism, good typography.
3. Default to single-file HTML apps (inline CSS + JS) unless user asks for multiple files.
4. Make apps that look like they were designed by a senior designer.
5. After writing, tell the user their app is live in the preview.
6. Never show tool XML to the user.`;

// ── LLM call ───────────────────────────────────────────────────────────────
async function llmCall(messages) {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.SITE_URL || 'https://vibecraft.app',
      'X-Title': 'VibeCraft'
    },
    body: JSON.stringify({ model: MODEL, messages, stream: false, max_tokens: 4096, temperature: 0.7 })
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${await r.text()}`);
  return (await r.json()).choices[0].message.content;
}

const sse = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

// ── /api/chat ──────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { messages = [] } = req.body;
  const history = [{ role: 'system', content: SYSTEM }, ...messages];

  try {
    for (let i = 0; i < 10; i++) {
      const reply = await llmCall(history);
      const tools = parseToolCalls(reply);
      const text  = stripToolCalls(reply);
      if (text) sse(res, { type: 'text_chunk', content: text });
      if (!tools.length) break;
      history.push({ role: 'assistant', content: reply });
      for (const tc of tools) {
        sse(res, { type: 'tool_start', name: tc.name, args: tc.args });
        const result = await executeTool(tc.name, tc.args);
        sse(res, { type: 'tool_end', name: tc.name, args: tc.args, result });
        history.push({ role: 'user', content: `<tool_result name="${tc.name}">\n${result}\n</tool_result>` });
      }
    }
    sse(res, { type: 'done' });
  } catch (e) {
    sse(res, { type: 'error', message: e.message });
  } finally { res.end(); }
});

// ── /api/files ─────────────────────────────────────────────────────────────
app.get('/api/files', async (req, res) => {
  try {
    const dp = safePath(req.query.path || '.');
    if (!await fs.pathExists(dp)) return res.json([]);
    const items = await fs.readdir(dp, { withFileTypes: true });
    res.json(items.filter(i => i.name !== 'node_modules' && !i.name.startsWith('.'))
      .map(i => ({ name: i.name, type: i.isDirectory()?'dir':'file', path: path.relative(WORKSPACE, path.join(dp, i.name)) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /api/file ──────────────────────────────────────────────────────────────
app.get('/api/file', async (req, res) => {
  try {
    const fp = safePath(req.query.path);
    res.json({ content: await fs.readFile(fp, 'utf8'), path: req.query.path });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⚡  VibeCraft  →  http://localhost:${PORT}`);
  console.log(`   Preview    →  http://localhost:${PORT}/preview`);
  console.log(`   Model      →  ${MODEL}\n`);
});
