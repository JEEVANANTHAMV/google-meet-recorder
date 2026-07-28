// schedules.js — Schedule registry for the Google Meet Recorder server.
//
// The ERP (BETA-CRM-BASE-GCP) registers each class occurrence here when a class schedule is
// created/updated, and removes them when a schedule is deleted. The registry powers three things:
//
//   1. /api/schedules/lookup  — the extension asks "is this meeting code scheduled (domain-bound)?"
//      so it can auto-prompt the assigned faculty to record and skip the external-access-key gate.
//   2. Missed-recording watchdog — if a scheduled occurrence starts and no recording data arrives
//      within the grace window, we email the faculty (cc admins).
//   3. Linking a finished recording session back to the right occurrence when we notify the backend.
//
// One "occurrence" == one class on one date. Recurring schedules register N occurrences (one per
// date), each carrying its own start/end time. The Google Meet code (e.g. "abc-defg-hij") is shared
// across all occurrences of a schedule because they reuse the same meeting link.
//
// Persistence reuses the pluggable storage backend (GCS in prod, local disk in dev) via a single
// JSON index object so the registry survives restarts.

const REGISTRY_MEETING = '_registry';
const REGISTRY_SESSION = 'schedules';
const REGISTRY_FILE = 'index.json';

// Occurrence identity: prefer the ERP's splitScheduleId (globally unique per occurrence); fall back
// to meetingId + date so ad-hoc registrations without a split id still de-duplicate cleanly.
function occKey(o) {
  if (o.splitScheduleId != null && o.splitScheduleId !== '') return `split:${o.splitScheduleId}`;
  return `meet:${o.meetingId}@${(o.startAt || '').slice(0, 10)}`;
}

function toEpoch(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

function createScheduleRegistry(storage, config, logger) {
  // occKey -> occurrence
  const registry = new Map();
  let saveTimer = null;
  let dirty = false;

  function normalize(raw) {
    if (!raw || !raw.meetingId) return null;
    return {
      scheduleId: raw.scheduleId != null ? String(raw.scheduleId) : null,
      splitScheduleId: raw.splitScheduleId != null ? String(raw.splitScheduleId) : null,
      meetingId: String(raw.meetingId),
      meetingLink: raw.meetingLink || null,
      batchName: raw.batchName || null,
      facultyName: raw.facultyName || null,
      facultyEmail: raw.facultyEmail || null,
      adminEmails: Array.isArray(raw.adminEmails)
        ? raw.adminEmails.filter(Boolean)
        : (raw.adminEmails ? String(raw.adminEmails).split(',').map(s => s.trim()).filter(Boolean) : []),
      startAt: raw.startAt || null,
      endAt: raw.endAt || null,
      autoRecord: raw.autoRecord !== false,
      domain: raw.domain || null,
      // watchdog / linking state (preserved across upserts unless explicitly reset)
      recordedSessionId: raw.recordedSessionId || null,
      recordedAt: raw.recordedAt || null,
      missedEmailSentAt: raw.missedEmailSentAt || null,
      registeredAt: raw.registeredAt || new Date().toISOString()
    };
  }

  async function persistNow() {
    dirty = false;
    try {
      await storage.writeJSON(REGISTRY_MEETING, REGISTRY_SESSION, REGISTRY_FILE, {
        version: 1,
        updatedAt: new Date().toISOString(),
        occurrences: Array.from(registry.values())
      });
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to persist schedule registry');
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (dirty) await persistNow();
    }, 1500);
  }

  return {
    async init() {
      try {
        const data = await storage.readJSON(REGISTRY_MEETING, REGISTRY_SESSION, REGISTRY_FILE);
        const list = (data && Array.isArray(data.occurrences)) ? data.occurrences : [];
        for (const o of list) {
          const n = normalize(o);
          if (n) registry.set(occKey(n), n);
        }
        logger.info({ occurrences: registry.size }, 'Schedule registry loaded');
      } catch (err) {
        logger.warn({ err: err.message }, 'Could not load schedule registry (starting empty)');
      }
    },

    // Add or update occurrences. Preserves watchdog state (recorded/emailed) when an occurrence is
    // re-registered (e.g. the ERP re-syncs the same class), unless the meeting time actually moved.
    upsertMany(rawList) {
      const out = [];
      for (const raw of (rawList || [])) {
        const n = normalize(raw);
        if (!n) continue;
        const key = occKey(n);
        const prev = registry.get(key);
        if (prev) {
          const timeMoved = prev.startAt !== n.startAt;
          n.recordedSessionId = timeMoved ? null : prev.recordedSessionId;
          n.recordedAt = timeMoved ? null : prev.recordedAt;
          n.missedEmailSentAt = timeMoved ? null : prev.missedEmailSentAt;
          n.registeredAt = prev.registeredAt;
        }
        registry.set(key, n);
        out.push(n);
      }
      if (out.length) scheduleSave();
      return out;
    },

    upsert(raw) {
      return this.upsertMany([raw])[0] || null;
    },

    removeBySchedule(scheduleId) {
      const sid = String(scheduleId);
      let removed = 0;
      for (const [key, o] of registry) {
        if (o.scheduleId === sid) { registry.delete(key); removed++; }
      }
      if (removed) scheduleSave();
      return removed;
    },

    removeBySplit(splitScheduleId) {
      const removed = registry.delete(`split:${String(splitScheduleId)}`);
      if (removed) scheduleSave();
      return removed ? 1 : 0;
    },

    removeByMeeting(meetingId) {
      const mid = String(meetingId);
      let removed = 0;
      for (const [key, o] of registry) {
        if (o.meetingId === mid) { registry.delete(key); removed++; }
      }
      if (removed) scheduleSave();
      return removed;
    },

    // Any registered occurrence for this meeting code?
    isBound(meetingId) {
      const mid = String(meetingId);
      for (const o of registry.values()) if (o.meetingId === mid) return true;
      return false;
    },

    // The occurrence most relevant "right now" for a meeting code: the one whose [start,end] window
    // currently contains now, else the nearest upcoming/most-recent one. Used by the extension to
    // decide whether to auto-prompt recording.
    lookup(meetingId) {
      const mid = String(meetingId);
      const matches = Array.from(registry.values()).filter(o => o.meetingId === mid);
      if (!matches.length) return null;
      const now = Date.now();
      const inWindow = matches.find(o => {
        const s = toEpoch(o.startAt), e = toEpoch(o.endAt);
        if (Number.isNaN(s)) return false;
        const start = s - 15 * 60 * 1000;             // allow joining 15 min early
        const end = Number.isNaN(e) ? s + 6 * 3600 * 1000 : e + 30 * 60 * 1000;
        return now >= start && now <= end;
      });
      if (inWindow) return inWindow;
      // Otherwise pick the occurrence with the smallest time distance to now.
      return matches.slice().sort((a, b) =>
        Math.abs(toEpoch(a.startAt) - now) - Math.abs(toEpoch(b.startAt) - now))[0];
    },

    // Link a finished recording session to the occurrence on the same date (so the watchdog knows the
    // class WAS recorded, and so backend notifications can carry the splitScheduleId).
    markRecorded(meetingId, sessionId, startedAtIso) {
      const mid = String(meetingId);
      const startMs = toEpoch(startedAtIso) || Date.now();
      let best = null, bestDist = Infinity;
      for (const o of registry.values()) {
        if (o.meetingId !== mid) continue;
        const s = toEpoch(o.startAt);
        const dist = Number.isNaN(s) ? Infinity : Math.abs(s - startMs);
        if (dist < bestDist) { bestDist = dist; best = o; }
      }
      // Only bind if the session started within a reasonable window of the occurrence (~12h).
      if (best && bestDist <= 12 * 3600 * 1000) {
        best.recordedSessionId = sessionId;
        best.recordedAt = new Date().toISOString();
        scheduleSave();
        return best;
      }
      return null;
    },

    // Occurrences that started more than `graceMinutes` ago, are not yet recorded, and haven't been
    // emailed about — the watchdog emails these once. `windowMinutes` bounds how long AFTER start we
    // still alert (prevents next-day false alarms); `cutoverIso` (optional) skips occurrences that
    // started before the extension cutover (those were recorded by the old notetaker, so the recorder
    // registry never marked them recorded and they would otherwise all false-fire).
    dueForMissedEmail(graceMinutes, windowMinutes, cutoverIso) {
      const now = Date.now();
      const graceMs = graceMinutes * 60 * 1000;
      const windowMs = (Number.isFinite(windowMinutes) ? windowMinutes : 120) * 60 * 1000;
      const cutoverMs = cutoverIso ? toEpoch(cutoverIso) : NaN;
      const due = [];
      for (const o of registry.values()) {
        if (o.recordedSessionId || o.missedEmailSentAt) continue;
        if (!o.facultyEmail) continue;
        const s = toEpoch(o.startAt);
        if (Number.isNaN(s)) continue;
        // Cutover floor: ignore anything that started before the extension went live.
        if (!Number.isNaN(cutoverMs) && s < cutoverMs) continue;
        // Alert only inside [start + grace, start + window]. A short window means a class that is
        // long over (e.g. yesterday's) is never treated as "still missing".
        if (now >= s + graceMs && now <= s + windowMs) due.push(o);
      }
      return due;
    },

    markMissedEmailed(occ) {
      const o = registry.get(occKey(occ));
      if (o) { o.missedEmailSentAt = new Date().toISOString(); scheduleSave(); }
    },

    all() {
      return Array.from(registry.values());
    },

    async flush() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (dirty) await persistNow();
    }
  };
}

module.exports = { createScheduleRegistry, occKey, REGISTRY_MEETING };
