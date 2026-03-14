#!/usr/bin/env node
/**
 * HearthNet Live Git Visualizer
 * 
 * Watches the groundplane-state git repo and pushes commit updates
 * to the browser via SSE. Built for live demo recording.
 * 
 * Usage: node visualizer/server.js
 * Then open http://localhost:3456
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = parseInt(process.env.VIS_PORT || '3456');
const REPO_PATH = process.env.GROUNDPLANE_REPO || path.join(__dirname, '..', 'groundplane-state');
const POLL_INTERVAL_MS = 200; // Fallback poll interval (fs.watch is primary)

// --- Git helpers ---
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, {
      cwd: REPO_PATH,
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
  } catch (e) {
    return null;
  }
}

function getAllCommits() {
  const raw = git('log --all --format="%H|%h|%an|%ae|%at|%s" --reverse');
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const [hash, short, author, email, timestamp, ...subjectParts] = line.split('|');
    const subject = subjectParts.join('|');
    return {
      hash,
      short,
      author,
      email,
      timestamp: parseInt(timestamp) * 1000,
      subject,
      agent: extractAgent(author, subject),
      type: extractType(subject),
    };
  });
}

function getCommitDiff(hash) {
  return git(`show --stat --format="" ${hash}`) || '';
}

function getCommitBody(hash) {
  return git(`show --format="%b" -s ${hash}`) || '';
}

function extractAgent(author, subject) {
  // The git author IS the agent who originated the action (set in commit --author)
  const authorLower = author.toLowerCase();
  if (authorLower.includes('user')) return 'user';
  if (authorLower.includes('dewey') || authorLower.includes('librarian')) return 'dewey';
  if (authorLower.includes('jeeves')) return 'jeeves';
  if (authorLower.includes('rupert')) return 'rupert';
  if (authorLower.includes('darcy')) return 'darcy';
  // Percy not in HearthNet demo scope

  // Fallback: extract sender from [type] sender → receiver pattern
  const match = subject.match(/^\[.*?\]\s+(\w+)\s*→/);
  if (match) {
    const sender = match[1].toLowerCase();
    if (sender === 'user') return 'user';
    if (sender === 'rupert') return 'rupert';
    if (sender === 'jeeves') return 'jeeves';
    if (sender === 'dewey') return 'dewey';
    if (sender === 'darcy') return 'darcy';
    if (sender === 'percy') return 'percy';
  }
  return 'system';
}

function extractType(subject) {
  const match = subject.match(/^\[(\w+)\]/);
  if (match) return match[1].toLowerCase();
  if (subject.startsWith('lease:')) return 'lease';
  if (subject.includes('CONFLICT')) return 'conflict';
  if (subject.includes('STALE') || subject.includes('REJECTED')) return 'rejection';
  if (subject.includes('resolution') || subject.includes('RESOLVED')) return 'resolution';
  return 'event';
}

// --- SSE ---
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}

// --- Polling for new commits ---
let lastKnownHead = null;
let knownCommitCount = 0;

function pollForChanges() {
  const head = git('rev-parse HEAD');
  if (!head) return;

  if (head !== lastKnownHead) {
    const commits = getAllCommits();
    if (commits.length > knownCommitCount) {
      // Send only new commits
      const newCommits = commits.slice(knownCommitCount);
      for (const commit of newCommits) {
        const s = commit.subject.toLowerCase();
        if (s.includes('percy') || s.includes('camera recording')) continue;
        broadcastSSE('commit', commit);
      }
      knownCommitCount = commits.length;
    }
    lastKnownHead = head;
    // Use filtered count so badge matches visible commits
    const visibleCount = commits.filter(c => {
      const s = c.subject.toLowerCase();
      return !s.includes('percy') && !s.includes('camera recording');
    }).length;
    broadcastSSE('head', { hash: head, total: visibleCount });
  }
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/events') {
    // SSE endpoint
    if (sseClients.size >= 50) {
      res.writeHead(503);
      res.end('Too many connections');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.pathname === '/api/commits') {
    const commits = getAllCommits().filter(c => {
      // Filter out Percy-related commits (not in demo scope)
      const s = c.subject.toLowerCase();
      return !s.includes('percy') && !s.includes('camera recording');
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(commits));
    return;
  }

  // Static snapshot for Vercel/artifact export
  if (url.pathname === '/api/snapshot') {
    const commits = getAllCommits();
    const snapshot = {
      project: 'HearthNet',
      exported_at: new Date().toISOString(),
      head: git('rev-parse HEAD'),
      total: commits.length,
      commits,
    };
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="hearthnet-trace.json"',
    });
    res.end(JSON.stringify(snapshot, null, 2));
    return;
  }

  if (url.pathname === '/api/diff' && url.searchParams.get('hash')) {
    const hash = url.searchParams.get('hash').replace(/[^a-f0-9]/g, '');
    if (!hash || hash.length < 4) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid hash' }));
      return;
    }
    const diff = getCommitDiff(hash);
    const body = getCommitBody(hash);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ diff, body }));
    return;
  }

  // Serve static files (with path traversal guard)
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const publicDir = path.join(__dirname, 'public');
  const fullPath = path.join(publicDir, filePath);
  
  if (!fullPath.startsWith(publicDir + path.sep) && fullPath !== publicDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(fullPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(fullPath);
  const contentTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };

  res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
  res.end(fs.readFileSync(fullPath));
});

// --- Start ---
const commits = getAllCommits();
knownCommitCount = commits.length;
lastKnownHead = git('rev-parse HEAD');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  HearthNet Visualizer`);
  console.log(`  ─────────────────────`);
  console.log(`  URL:    http://localhost:${PORT}`);
  console.log(`  Repo:   ${REPO_PATH}`);
  console.log(`  HEAD:   ${lastKnownHead?.slice(0, 8)}`);
  console.log(`  Commits: ${knownCommitCount}`);
  console.log(`  Polling: every ${POLL_INTERVAL_MS}ms\n`);
});

// Primary: fs.watch on .git directory for near-instant detection
const gitDir = path.join(REPO_PATH, '.git');
try {
  fs.watch(gitDir, { recursive: true }, (eventType, filename) => {
    // Only react to changes that indicate new commits
    if (filename && (filename.includes('HEAD') || filename.includes('refs') || filename.includes('objects'))) {
      // Small debounce — git writes multiple files per commit
      clearTimeout(pollForChanges._debounce);
      pollForChanges._debounce = setTimeout(pollForChanges, 50);
    }
  });
  console.log(`  Watch:   fs.watch on ${gitDir} (near-instant)`);
} catch (e) {
  console.log(`  Watch:   fs.watch failed (${e.message}), using polling only`);
}

// Fallback: poll every 200ms in case fs.watch misses something
setInterval(pollForChanges, POLL_INTERVAL_MS);

// SSE keepalive — flush dead connections
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(':keepalive\n\n'); } catch (e) { sseClients.delete(res); }
  }
}, 15000);
