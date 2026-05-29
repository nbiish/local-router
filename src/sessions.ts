import fs from 'fs';
import path from 'path';

export type Session = {
  sessionId: string;
  clientName: string;
  startedAt: string;
  lastActivity: string;
  modelUsage: Record<string, number>;
  totalRequests: number;
};

export type SessionFeedback = {
  sessionId: string;
  clientName: string;
  rating: 'up' | 'down';
  ratedAt: string;
  modelsUsed: string[];
};

const SESSION_WINDOW_MS = 2 * 60 * 60 * 1000;

let sessions: Session[] = [];
let feedbackEntries: SessionFeedback[] = [];

function sessionFilePath(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || '/tmp',
    '.config', 'local-router', 'sessions.json'
  );
}

function feedbackFilePath(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || '/tmp',
    '.config', 'local-router', 'session-feedback.json'
  );
}

function ensureConfigDir(): void {
  const dir = path.dirname(sessionFilePath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function writeJsonSecure(filePath: string, data: unknown): void {
  ensureConfigDir();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function loadSessions(): void {
  try {
    const raw = fs.readFileSync(sessionFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    sessions = Array.isArray(parsed) ? parsed : [];
  } catch {
    sessions = [];
  }
}

export function saveSessions(): void {
  writeJsonSecure(sessionFilePath(), sessions);
}

export function loadFeedback(): void {
  try {
    const raw = fs.readFileSync(feedbackFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    feedbackEntries = Array.isArray(parsed) ? parsed : [];
  } catch {
    feedbackEntries = [];
  }
}

export function saveFeedback(): void {
  writeJsonSecure(feedbackFilePath(), feedbackEntries);
}

export function recordRequest(clientName: string, modelName: string): void {
  if (!clientName || !modelName) return;

  const now = new Date();
  const nowISO = now.toISOString();

  // Remove stale sessions (inactive beyond window)
  sessions = sessions.filter(
    (s) => now.getTime() - new Date(s.lastActivity).getTime() < SESSION_WINDOW_MS + 60 * 60 * 1000
  );

  // Find or create active session for this client
  let session = sessions.find(
    (s) =>
      s.clientName === clientName &&
      now.getTime() - new Date(s.lastActivity).getTime() < SESSION_WINDOW_MS
  );

  if (!session) {
    const sessionId = `sess-${clientName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session = {
      sessionId,
      clientName,
      startedAt: nowISO,
      lastActivity: nowISO,
      modelUsage: {},
      totalRequests: 0,
    };
    sessions.push(session);
  }

  session.lastActivity = nowISO;
  session.totalRequests += 1;
  session.modelUsage[modelName] = (session.modelUsage[modelName] || 0) + 1;

  // Limit to 200 most recent sessions
  if (sessions.length > 200) {
    sessions = sessions.slice(-200);
  }

  // Auto-save every 10 requests
  if (session.totalRequests % 10 === 0) {
    saveSessions();
  }
}

export function getSessions(): Session[] {
  const now = Date.now();
  // Filter to active (within window of last activity)
  return sessions
    .filter((s) => now - new Date(s.lastActivity).getTime() < SESSION_WINDOW_MS + 60 * 60 * 1000)
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
}

export function getSessionById(sessionId: string): Session | undefined {
  return sessions.find((s) => s.sessionId === sessionId);
}

export function recordFeedback(
  sessionId: string,
  rating: 'up' | 'down'
): { ok: boolean; error?: string } {
  const session = getSessionById(sessionId);
  if (!session) {
    return { ok: false, error: 'Session not found.' };
  }

  const modelsUsed = Object.keys(session.modelUsage);
  const entry: SessionFeedback = {
    sessionId,
    clientName: session.clientName,
    rating,
    ratedAt: new Date().toISOString(),
    modelsUsed,
  };

  feedbackEntries.push(entry);

  // Limit feedback to 500 entries
  if (feedbackEntries.length > 500) {
    feedbackEntries = feedbackEntries.slice(-500);
  }

  saveFeedback();
  return { ok: true };
}

export function getFeedbackForSession(sessionId: string): SessionFeedback | undefined {
  return feedbackEntries.find((f) => f.sessionId === sessionId);
}

export function getAllFeedback(): SessionFeedback[] {
  return [...feedbackEntries].reverse();
}

export function getSessionFeedback(): SessionFeedback[] {
  return getAllFeedback();
}
