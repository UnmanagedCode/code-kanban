import express from 'express';
import * as mcp from './mcp.js';
import * as board from './board.js';
import { STATES } from './paths.js';
import { ALLOWED_TRANSITIONS } from './board.js';
import { listProjects } from './projects.js';

// Thin HTTP layer. Exposes the health probe, the MCP tool-call bridge the
// conductor forwards to, and the web GUI's board routes. The GUI routes delegate
// 1:1 to board.js (the single writer / validator) and pass its {ok} envelope
// through unchanged — see docs/protocol.md.
//
// Envelope contract (matches the MCP bridge): a domain refusal
// {ok:false,code,reason} is a NORMAL result returned as HTTP 200, not a
// transport failure. Only malformed JSON (400) and unexpected throws (500)
// surface as {error} with a non-200 status.

// Attribution stamped on logbook lines for human GUI mutations. The GUI has no
// human identity, so 'gui' is the honest actor; board.js clears the card's
// `owner` field for any non-in-progress destination regardless of this arg, so
// passing it on every move only affects the move's log line (not a stuck owner).
const GUI_ACTOR = 'gui';

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

  // ---- web GUI routes ----

  // Project catalog for the selector. Same source validateProject uses; not
  // board state, so it does not go through board.js.
  r.get('/projects', async (req, res) => {
    try {
      res.json({ projects: await listProjects() });
    } catch (e) {
      res.status(502).json({ error: `project list unavailable: ${e.message}` });
    }
  });

  // Column list + legal transitions, from the single source of truth, so the
  // GUI renders only legal move targets (and still surfaces INVALID_STATE for
  // races). transitions is the Set serialized as an array of "from>to".
  r.get('/board/meta', (req, res) => {
    res.json({ states: STATES, transitions: [...ALLOWED_TRANSITIONS] });
  });

  // List a project's cards (optionally filtered). One call returns all; the GUI
  // groups by state client-side.
  r.get('/board/:project/tasks', async (req, res) => {
    const { state, epic } = req.query;
    res.json(await board.listTasks({ project: req.params.project, state, epic }));
  });

  // Full task incl. goal, acceptance, logbook (read-only in the GUI).
  r.get('/board/:project/tasks/:id', async (req, res) => {
    res.json(await board.readTask({ project: req.params.project, id: req.params.id }));
  });

  // File a new task into triage. acceptance is string[] -> checkboxes.
  r.post('/board/:project/tasks', async (req, res) => {
    const { title, goal, acceptance, epic, depends_on } = req.body ?? {};
    res.json(await board.fileTask({
      project: req.params.project, title, goal, acceptance, epic, depends_on,
      sessionId: GUI_ACTOR,
    }));
  });

  // Patch updatable fields (title, goal, epic, priority, depends_on). The body
  // IS the fields object; acceptance is not updatable (read-only in the GUI).
  r.patch('/board/:project/tasks/:id', async (req, res) => {
    res.json(await board.updateTask({
      project: req.params.project, id: req.params.id, fields: req.body ?? {},
    }));
  });

  // Move a card between columns. board.js enforces ALLOWED_TRANSITIONS and
  // returns INVALID_STATE on an illegal move; the GUI surfaces that reason.
  r.post('/board/:project/tasks/:id/move', async (req, res) => {
    const { to, owner } = req.body ?? {};
    res.json(await board.moveTask({
      project: req.params.project, id: req.params.id, to,
      owner: owner || GUI_ACTOR,
    }));
  });

  // Epics with per-state rollups.
  r.get('/board/:project/epics', async (req, res) => {
    res.json(await board.listEpics({ project: req.params.project }));
  });

  r.get('/board/:project/epics/:slug', async (req, res) => {
    res.json(await board.readEpic({ project: req.params.project, slug: req.params.slug }));
  });

  // Create or refresh an epic (upsert: preserves `created`, refreshes title/goal).
  r.post('/board/:project/epics', async (req, res) => {
    const { slug, title, goal } = req.body ?? {};
    res.json(await board.createEpic({
      project: req.params.project, slug, title, goal,
    }));
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