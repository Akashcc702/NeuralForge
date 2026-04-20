require('dotenv').config();
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;
const WORKSPACE = path.join(process.cwd(), 'workspace');
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const MODEL = process.env.MODEL || 'openrouter/free';
// ── Workspace bootstrap ────────────────────────────────────────────────────

fs.ensureDirSync(WORKSPACE);
const readmePath = path.join(WORKSPACE, 'README.md');
if (!fs.existsSync(readmePath)) {
  fs.writeFileSync(readmePath,
    '# NeuralForge Workspace\n\nYour AI coding agent is ready.\nAsk me to build apps, write code, run commands, or analyse files!\n'
  );
}

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are NeuralForge, an elite AI coding agent. You have full read/write/execute access to a workspace directory. You autonomously plan and complete complex coding tasks using tools.

AVAILABLE TOOLS — use them by outputting the exact XML block:

List files in a directory:
<tool_call>
{"name":"list_files","args":{"path":"."}}
</tool_call>

Read a file:
<tool_call>
{"name":"read_file","args":{"path":"src/index.js"}}
</tool_call>

Write (create or overwrite) a file:
<tool_call>
{"name":"write_file","args":{"path":"src/index.js","content":"// code here"}}
</tool_call>

Execute a shell command (runs in workspace dir):
<tool_call>
{"name":"execute_command","args":{"command":"npm install"}}
</tool_call>

Delete a file or folder:
<tool_call>
{"name":"delete_file","args":{"path":"old_file.js"}}
</tool_call>

AGENT RULES:
1. Break big tasks into steps; use tools for each step.
2. After writing files, verify by reading them back.
3. Create complete, production-ready code — never leave TODOs.
4. After executing commands, report the output.
5. All paths are relative to the workspace root.
6. Never reveal the tool XML syntax to the user — it's internal.
7. Be proactive: if the user asks for an app, build the whole thing.`;

// ── Safety: resolve only within workspace ─────────────────────────────────

function safePath(filePath) {
  const resolved = path.resolve(WORKSPACE, filePath || '.');
  if (!resolved.startsWith(WORKSPACE)) throw new Error('Path traversal blocked');
  return resolved;
}

// ── Tool implementations ───────────────────────────────────────────────────

async function executeTool(name, args) {
  try {
    switch (name) {

      case 'list_files': {
        const dir = safePath(args.path);
        if (!await fs.pathExists(dir)) return `Directory not found: ${args.path}`;
        const items = await fs.readdir(dir, { withFileTypes: true });
        const list = items
          .filter(i => i.name !== 'node_modules' && !i.name.startsWith('.git'))
          .map(i => ({ name: i.name, type: i.isDirectory() ? 'dir' : 'file' }));
        return JSON.stringify(list, null, 2);
      }

      case 'read_file': {
        const fp = safePath(args.path);
        if (!await fs.pathExists(fp)) return `File not found: ${args.path}`;
        const content = await fs.readFile(fp, 'utf8');
        return content.length > 8000 ? content.slice(0, 8000) + '\n...[truncated]' : content;
      }

      case 'write_file': {
        const fp = safePath(args.path);
        await fs.ensureDir(path.dirname(fp));
        await fs.writeFile(fp, args.content, 'utf8');
        return `✓ Written: ${args.path} (${Buffer.byteLength(args.content, 'utf8')} bytes)`;
      }

      case 'delete_file': {
        const fp = safePath(args.path);
        await fs.remove(fp);
        return `✓ Deleted: ${args.path}`;
      }

      case 'execute_command': {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: WORKSPACE,
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024
        });
        const out = [stdout, stderr ? `[stderr] ${stderr}` : ''].filter(Boolean).join('\n');
        return out.trim() || '(no output)';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ── Tool call parser ───────────────────────────────────────────────────────

function parseToolCalls(text) {
  const calls = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { calls.push({ raw: m[0], ...JSON.parse(m[1]) }); } catch {}
  }
  return calls;
}

function stripToolCalls(text) {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}

// ── OpenRouter helpers ─────────────────────────────────────────────────────

async function llmCall(messages) {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.SITE_URL || 'https://neuralforge.app',
      'X-Title': 'NeuralForge'
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      max_tokens: 4096,
      temperature: 0.7
    })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function llmStream(messages, onChunk) {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.SITE_URL || 'https://neuralforge.app',
      'X-Title': 'NeuralForge'
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      max_tokens: 4096,
      temperature: 0.7
    })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const j = JSON.parse(raw);
        const chunk = j.choices?.[0]?.delta?.content;
        if (chunk) onChunk(chunk);
      } catch {}
    }
  }
}

// ── SSE helper ─────────────────────────────────────────────────────────────

const sse = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

// ── /api/chat — Agentic loop with SSE ─────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { messages = [] } = req.body;
  const history = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];

  try {
    const MAX_LOOPS = 10;

    for (let i = 0; i < MAX_LOOPS; i++) {
      const reply = await llmCall(history);
      const tools = parseToolCalls(reply);
      const text = stripToolCalls(reply);

      // Send any prose in this turn
      if (text) {
        sse(res, { type: 'text_chunk', content: text });
      }

      // No tools — final response, stream it nicely
      if (tools.length === 0) {
        // If this was already the final prose, we already sent it above.
        // For a clean streaming feel on final turns, re-stream with newline flush.
        break;
      }

      // Register assistant turn
      history.push({ role: 'assistant', content: reply });

      // Execute each tool
      for (const tc of tools) {
        sse(res, { type: 'tool_start', name: tc.name, args: tc.args });
        const result = await executeTool(tc.name, tc.args);
        sse(res, { type: 'tool_end', name: tc.name, result });
        history.push({
          role: 'user',
          content: `<tool_result name="${tc.name}">\n${result}\n</tool_result>`
        });
      }
    }

    sse(res, { type: 'done' });
  } catch (err) {
    sse(res, { type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

// ── /api/files — File tree ─────────────────────────────────────────────────

app.get('/api/files', async (req, res) => {
  try {
    const dirPath = safePath(req.query.path || '.');
    if (!await fs.pathExists(dirPath)) return res.json([]);
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    res.json(
      items
        .filter(i => i.name !== 'node_modules' && !i.name.startsWith('.git'))
        .map(i => ({
          name: i.name,
          type: i.isDirectory() ? 'dir' : 'file',
          path: path.relative(WORKSPACE, path.join(dirPath, i.name))
        }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/file — Read file ──────────────────────────────────────────────────

app.get('/api/file', async (req, res) => {
  try {
    const fp = safePath(req.query.path);
    const content = await fs.readFile(fp, 'utf8');
    res.json({ content, path: req.query.path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n⬡  NeuralForge  →  http://localhost:${PORT}`);
  console.log(`   Model       →  ${MODEL}`);
  console.log(`   Workspace   →  ${WORKSPACE}\n`);
});
