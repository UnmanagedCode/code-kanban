import express from 'express';
import * as mcp from './mcp.js';

// Thin HTTP layer. Today it exposes only the health probe and the MCP tool-call
// bridge the conductor forwards to. The future web GUI adds its own routes here
// over the same board.js service.
export function buildRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  r.get('/health', (req, res) => res.json({ ok: true }));

  // MCP bridge for code-conductor: {tool, arguments, caller} in, {result}|{error}
  // out. Tool-level outcomes (unknown tool, refusals) are normal results, not
  // transport failures — see docs/protocol.md.
  r.post('/mcp', async (req, res) => {
    const { status, body } = await mcp.handle(req.body);
    res.status(status).json(body);
  });

  // Malformed JSON body -> 400 {error}, not Express's default HTML page.
  r.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: 'invalid request body' });
    }
    next(err);
  });

  return r;
}
