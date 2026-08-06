// Plan-link grammar: the typed, always-relative pointer a card's `plan`
// frontmatter scalar holds. NEVER the plan text — the body lives in a file that
// ordinary Read/Write/Edit owns.
//
//   board:<rel>  -> <kanbanRoot>/projects/<project>/plans/<rel>
//   repo:<rel>   -> <PROJECTS_ROOT>/<project>/<rel>   (the BASE checkout, never a
//                   worktree — which is why a repo: link only resolves once the
//                   plan is merged)
//   <rel>        -> bare, means board:
//
// Pure: no fs here. Grammar + containment only; board.js owns stat-ing the file
// and every refusal shape (see resolvePlanForSet there).

import path from 'node:path';
import { plansDir, projectRepoDir } from './paths.js';

// Case-insensitive by construction (the scheme is lowercased before lookup), so
// a Windows drive letter (`C:\x`) is a LOUD unknown-scheme refusal rather than a
// bizarre relative filename.
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;

const BASE_DIR = { board: plansDir, repo: projectRepoDir };

function bad(reason) { return { error: { code: 'INVALID_STATE', reason } }; }

// The base dir a scheme's relative path resolves under.
export function planBaseDir(project, scheme) {
  return BASE_DIR[scheme](project);
}

// The ONE containment guard (shape copied from code-conductor's
// handlers.ts: resolve, then path.relative, reject `..`/absolute). board.js
// re-runs it against realpath'd paths to close the symlink hole; nothing else
// should hand-roll a traversal check.
export function isContained(base, resolved) {
  const rel = path.relative(path.resolve(base), path.resolve(resolved));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// parsePlanLink(link) -> {scheme, rel} | {error:{code, reason}}
export function parsePlanLink(link) {
  if (typeof link !== 'string') return bad('plan link must be a string');
  // A frontmatter value is ONE verbatim line (taskfile.serialize) — an embedded
  // newline would inject a spurious key, the same hazard sanitizeCommit guards.
  if (/[\n\r]/.test(link)) return bad('plan link must not contain a newline');
  // Frontmatter parsing trims on read, so an untrimmed value would not
  // round-trip; trim before parsing. Internal spaces are fine.
  const trimmed = link.trim();
  if (!trimmed) return bad('plan link is empty (use `plan: null` to clear)');

  let scheme = 'board';
  let rel = trimmed;
  const m = SCHEME_RE.exec(trimmed);
  if (m) {
    scheme = m[1].toLowerCase();
    if (!(scheme in BASE_DIR)) {
      return bad(`unknown plan link scheme "${m[1]}:" — use board:, repo:, or a bare relative path`);
    }
    rel = trimmed.slice(m[0].length);
  }
  if (!rel.trim()) return bad('plan link is empty (use `plan: null` to clear)');
  if (path.isAbsolute(rel)) return bad('plan link must be relative (absolute paths break cross-instance sync)');
  return { scheme, rel };
}

// resolvePlanLink(project, link)
//   -> {link:'<scheme>:<rel>', scheme, rel, path:<abs>} | {error:{code, reason}}
// `link` is the NORMALISED form (a bare path gains its explicit `board:`), which
// is what gets stored so every consumer reads one shape.
export function resolvePlanLink(project, link) {
  const parsed = parsePlanLink(link);
  if (parsed.error) return parsed;
  const { scheme, rel } = parsed;
  const base = planBaseDir(project, scheme);
  const abs = path.resolve(base, rel);
  if (!isContained(base, abs)) {
    return bad('plan link must stay inside its base directory (no ../ traversal)');
  }
  return { link: `${scheme}:${rel}`, scheme, rel, path: abs };
}
