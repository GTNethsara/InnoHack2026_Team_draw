import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { MongoClient, type Collection } from 'mongodb';
import {
  hashRegistrationCode,
  maskRegistrationCode,
  maskStudentId,
  pickUniformGroup,
  verifyRegistrationCode,
} from './auth';
import type {
  AdminSnapshot,
  AuditLogEntry,
  DrawHistoryEntry,
  EventSettings,
  GroupId,
  GroupRecord,
  JoinQueueResult,
  PublicArenaStatus,
  QueueEntry,
  SpinResult,
  TeamLeaderSnapshot,
  TeamRecord,
} from '../src/types/portal';

const DATA_DIR = path.resolve(process.cwd(), 'server', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const INITIAL_STORE_PATH = path.join(DATA_DIR, 'initial-store.json');
const MONGO_STATE_ID = 'innohack-primary-state';
const GROUP_IDS: GroupId[] = ['GROUP_A', 'GROUP_B', 'GROUP_C'];
const MAX_GROUP_CAPACITY = 10;
const TOTAL_REGISTERED_TEAMS = 30;

interface StoredCredential {
  teamId: string;
  studentId: string;
  salt: string;
  registrationCodeHash: string;
}

interface DatabaseSchema {
  teamCredentials: Record<string, StoredCredential>;
  teams: Record<string, TeamRecord>;
  drawQueue: Record<string, QueueEntry>;
  groups: Record<GroupId, GroupRecord>;
  drawHistory: DrawHistoryEntry[];
  eventSettings: EventSettings;
  auditLogs: AuditLogEntry[];
}

export class PortalError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.chain;
    this.chain = prev.then(() => nextLock);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildFreshDatabase(): DatabaseSchema {
  const seedPath = fs.existsSync(INITIAL_STORE_PATH) ? INITIAL_STORE_PATH : STORE_PATH;
  if (!fs.existsSync(seedPath)) {
    throw new Error('Initial state JSON is missing. Restore server/data/store.json or run the documented MongoDB migration.');
  }
  const parsed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as DatabaseSchema;
  if (!parsed.teams || Object.keys(parsed.teams).length !== TOTAL_REGISTERED_TEAMS ||
      !parsed.teamCredentials || Object.keys(parsed.teamCredentials).length !== TOTAL_REGISTERED_TEAMS ||
      !parsed.groups || !parsed.eventSettings) {
    throw new Error('Initial state integrity check failed. Expected 30 teams and 30 credential hashes.');
  }
  return JSON.parse(JSON.stringify(parsed)) as DatabaseSchema;
}

type PortalStateDocument = {
  _id: string;
  state: DatabaseSchema;
  updatedAt: Date;
};

class ServerAuthoritativeStore {
  private db: DatabaseSchema;
  private mutex = new AsyncMutex();
  private mongoClient: MongoClient | null = null;
  private mongoCollection: Collection<PortalStateDocument> | null = null;  private pendingWrite: Promise<void> = Promise.resolve();
  private persistenceError: unknown = null;
  public events = new EventEmitter();

  constructor() {
    this.events.setMaxListeners(200);
    this.db = this.loadOrInitialize();
  }

  /** Connect to MongoDB and hydrate the authoritative state before accepting requests. */
  async initialize(): Promise<void> {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('MONGODB_URI is required in production.');
      }
      console.warn('[INNOHACK] MONGODB_URI is not set; using local JSON storage for development only.');
      return;
    }

    this.mongoClient = new MongoClient(uri, {
      serverSelectionTimeoutMS: 15000,
      maxPoolSize: 10,
    });
    await this.mongoClient.connect();
    const databaseName = process.env.MONGODB_DATABASE || 'innohack';
    this.mongoCollection = this.mongoClient
      .db(databaseName)
      .collection<PortalStateDocument>('portalState');

    const stored = await this.mongoCollection.findOne({ _id: MONGO_STATE_ID });
    if (stored?.state) {
      this.db = stored.state;
      console.log(`[INNOHACK] MongoDB state loaded from ${databaseName}.portalState`);
      return;
    }

    if (process.env.NODE_ENV === 'production') {
      throw new Error('MongoDB is connected but no migrated portal state exists. Run npm run migrate:mongodb before deploying.');
    }

    // Development convenience: migrate the existing local JSON file on first connection.
    await this.persist();
    await this.flush();
    console.log('[INNOHACK] Initial local state copied to MongoDB.');
  }

  /** Wait until all queued database writes have completed. */
  async flush(): Promise<void> {
    await this.pendingWrite;
    if (this.persistenceError) {
      throw new Error('MongoDB persistence failed. Check the backend logs and database connection.');
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.mongoClient?.close();
  }

  private loadOrInitialize(): DatabaseSchema {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (process.env.NODE_ENV === 'production') {
      // Production state must be hydrated from MongoDB in initialize(); never create local JSON state.
      return {} as DatabaseSchema;
    }

    if (fs.existsSync(STORE_PATH)) {
      try {
        const raw = fs.readFileSync(STORE_PATH, 'utf8');
        const parsed = JSON.parse(raw) as DatabaseSchema;
        if (
          parsed && parsed.teams && Object.keys(parsed.teams).length === TOTAL_REGISTERED_TEAMS &&
          parsed.teamCredentials && parsed.groups && parsed.eventSettings
        ) {
          if (!fs.existsSync(INITIAL_STORE_PATH)) {
            fs.writeFileSync(INITIAL_STORE_PATH, JSON.stringify(parsed, null, 2), 'utf8');
          }
          return parsed;
        }
      } catch {
        // A malformed local state is not silently replaced; use the immutable seed snapshot below.
      }
    }

    const fresh = buildFreshDatabase();
    this.persist(fresh);
    return fresh;
  }

  private persist(data: DatabaseSchema = this.db): void {
    // Local JSON remains a development fallback only. Production writes go to MongoDB.
    if (process.env.NODE_ENV !== 'production' && !this.mongoCollection) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmpPath = `${STORE_PATH}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, STORE_PATH);
      return;
    }

    if (!this.mongoCollection) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('MongoDB is not initialized; refusing to persist important data locally.');
      }
      return;
    }

    const snapshot = JSON.parse(JSON.stringify(data)) as DatabaseSchema;
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        await this.mongoCollection!.replaceOne(
          { _id: MONGO_STATE_ID },
          { state: snapshot, updatedAt: new Date() },
          { upsert: true },
        );
        this.persistenceError = null;
      })
      .catch((error: unknown) => {
        this.persistenceError = error;
        console.error('[INNOHACK] MongoDB write failed:', error);
        throw error;
      });
  }

  private appendAudit(action: string, actor: string, teamId: string | null, details: string): void {
    this.db.auditLogs.unshift({
      logId: `LOG_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      action,
      actor,
      teamId,
      details,
      timestamp: nowIso(),
    });
    if (this.db.auditLogs.length > 500) {
      this.db.auditLogs.length = 500;
    }
  }

  private broadcastUpdate(reason: string): void {
    this.events.emit('state-changed', { reason, timestamp: nowIso() });
  }

  // --------------------------------------------------------------------------
  // PUBLIC STATUS (Non-sensitive telemetry for Login Page)
  // --------------------------------------------------------------------------
  getPublicStatus(): PublicArenaStatus {
    const activeQueueCount = Object.values(this.db.drawQueue).filter(
      (q) => q.status === 'ACTIVE' || q.status === 'WAITING'
    ).length;

    return {
      eventStatus: this.db.eventSettings.eventStatus,
      queuePaused: this.db.eventSettings.queuePaused,
      totalTeams: this.db.eventSettings.totalTeams,
      completedDraws: this.db.eventSettings.completedDraws,
      activeQueueCount,
      groups: GROUP_IDS.map((gid) => ({
        groupId: gid,
        groupName: this.db.groups[gid].groupName,
        teamCount: this.db.groups[gid].teamCount,
        maxCapacity: this.db.groups[gid].maxCapacity,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // AUTHENTICATION: DUAL CREDENTIAL VALIDATION (Student ID + Registration Code)
  // --------------------------------------------------------------------------
  async authenticateTeamLeader(studentId: string, registrationCode: string): Promise<TeamRecord> {
    const cleanStudentId = studentId.trim();
    const cleanCode = registrationCode.trim().toUpperCase();

    if (!cleanStudentId || !cleanCode) {
      throw new PortalError(
        400,
        'MISSING_CREDENTIALS',
        'Both Student ID Number and Unique Registration Code are required.'
      );
    }

    return this.mutex.runExclusive(() => {
      const cred = Object.values(this.db.teamCredentials).find(
        (c) => c.studentId === cleanStudentId
      );

      if (!cred) {
        this.appendAudit(
          'LOGIN_FAILED',
          cleanStudentId,
          null,
          'Unrecognized Student ID attempted login.'
        );
        this.persist();
        throw new PortalError(
          401,
          'INVALID_CREDENTIALS',
          'Invalid credentials. Please verify your Student ID Number and Registration Code.'
        );
      }

      const valid = verifyRegistrationCode(
        cleanStudentId,
        cleanCode,
        cred.salt,
        cred.registrationCodeHash
      );

      if (!valid) {
        this.appendAudit(
          'LOGIN_FAILED',
          cleanStudentId,
          cred.teamId,
          'Mismatched Registration Code submitted for registered Student ID.'
        );
        this.persist();
        throw new PortalError(
          401,
          'INVALID_CREDENTIALS',
          'Invalid credentials. Student ID and Registration Code must match the same registered team.'
        );
      }

      const ts = nowIso();
      const team = this.db.teams[cred.teamId];
      team.authenticationStatus = 'AUTHENTICATED';
      team.lastLoginAt = ts;
      team.lastSeenAt = ts;

      if (team.activeQueueEntryId && this.db.drawQueue[team.activeQueueEntryId]) {
        this.db.drawQueue[team.activeQueueEntryId].lastHeartbeatAt = ts;
      }

      this.appendAudit(
        'TEAM_LOGIN',
        team.studentId,
        team.teamId,
        'Authenticated team leader entered the portal.'
      );
      this.persist();
      this.broadcastUpdate('team-login');
      return { ...team };
    });
  }

  // --------------------------------------------------------------------------
  // SNAPSHOTS (Strictly Scoped By Role)
  // --------------------------------------------------------------------------
  getTeamLeaderSnapshot(teamId: string): TeamLeaderSnapshot {
    const team = this.db.teams[teamId];
    if (!team) {
      throw new PortalError(404, 'TEAM_NOT_FOUND', 'Team record not found.');
    }

    const activeQueue = Object.values(this.db.drawQueue)
      .filter((q) => q.status === 'ACTIVE' || q.status === 'WAITING')
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      .map((q) => ({
        ...q,
        studentId: q.teamId === teamId ? team.studentId : undefined,
      }));

    const recentDraws = [...this.db.drawHistory]
      .sort((a, b) => b.drawOrder - a.drawOrder)
      .slice(0, 12)
      .map((d) => ({
        ...d,
        studentId: d.teamId === teamId ? d.studentId : undefined,
      }));

    return {
      team: { ...team },
      activeQueue,
      groups: GROUP_IDS.map((gid) => ({
        ...this.db.groups[gid],
        teamIds: [...this.db.groups[gid].teamIds],
      })),
      eventSettings: { ...this.db.eventSettings },
      recentDraws,
      serverTime: nowIso(),
    };
  }

  getAdminSnapshot(): AdminSnapshot {
    const teams = Object.values(this.db.teams).sort((a, b) =>
      a.teamId.localeCompare(b.teamId)
    );
    const queueEntries = Object.values(this.db.drawQueue)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      .map((q) => ({
        ...q,
        studentId: this.db.teams[q.teamId]?.studentId,
      }));

    return {
      teams: teams.map((t) => ({ ...t })),
      queueEntries,
      groups: GROUP_IDS.map((gid) => ({
        ...this.db.groups[gid],
        teamIds: [...this.db.groups[gid].teamIds],
      })),
      drawHistory: [...this.db.drawHistory].sort((a, b) => a.drawOrder - b.drawOrder),
      eventSettings: { ...this.db.eventSettings },
      auditLogs: [...this.db.auditLogs],
      serverTime: nowIso(),
    };
  }

  // --------------------------------------------------------------------------
  // ATOMIC FIFO QUEUE ADMISSION (Server-Authoritative Sequence Numbers)
  // --------------------------------------------------------------------------
  async joinDrawQueue(teamId: string): Promise<JoinQueueResult> {
    return this.mutex.runExclusive(() => {
      const team = this.db.teams[teamId];
      if (!team) {
        throw new PortalError(404, 'TEAM_NOT_FOUND', 'Team record not found.');
      }

      const settings = this.db.eventSettings;
      if (settings.eventStatus === 'COMPLETED' || settings.completedDraws >= TOTAL_REGISTERED_TEAMS) {
        throw new PortalError(
          409,
          'EVENT_COMPLETED',
          'All 30 teams have already completed their group allocations.'
        );
      }

      if (settings.queuePaused) {
        throw new PortalError(
          423,
          'QUEUE_PAUSED',
          'New queue admissions are currently paused by the Hackathon Organizers.'
        );
      }

      if (team.drawCompleted) {
        throw new PortalError(
          409,
          'DRAW_ALREADY_COMPLETED',
          `Your squad has already completed its draw (${team.assignedGroupName}).`
        );
      }

      const existingEntry = Object.values(this.db.drawQueue).find(
        (q) => q.teamId === teamId && (q.status === 'WAITING' || q.status === 'ACTIVE')
      );

      if (existingEntry || team.queueStatus === 'WAITING' || team.queueStatus === 'ACTIVE') {
        throw new PortalError(
          409,
          'ALREADY_IN_QUEUE',
          'You are already in the live FIFO queue. Duplicate queue entries are blocked.'
        );
      }

      const ts = nowIso();
      const nextSequence = settings.lastQueueSequence + 1;
      const becomesActive = settings.currentActiveTeamId === null;
      const status: 'ACTIVE' | 'WAITING' = becomesActive ? 'ACTIVE' : 'WAITING';
      const queueEntryId = `Q${String(nextSequence).padStart(4, '0')}_${teamId}`;

      const entry: QueueEntry = {
        queueEntryId,
        teamId,
        teamName: team.teamName,
        maskedStudentId: maskStudentId(team.studentId),
        sequenceNumber: nextSequence,
        status,
        joinedAt: ts,
        activatedAt: becomesActive ? ts : null,
        completedAt: null,
        lastHeartbeatAt: ts,
      };

      this.db.drawQueue[queueEntryId] = entry;
      team.queueStatus = status;
      team.queueNumber = nextSequence;
      team.activeQueueEntryId = queueEntryId;
      team.lastSeenAt = ts;

      settings.lastQueueSequence = nextSequence;
      if (becomesActive) {
        settings.currentActiveTeamId = teamId;
      }
      settings.queueStatus = 'ACTIVE';

      this.appendAudit(
        'QUEUE_JOINED',
        team.studentId,
        teamId,
        `Joined global FIFO queue at sequence #${nextSequence} (${status}).`
      );
      this.persist();
      this.broadcastUpdate('queue-joined');

      return { queueEntryId, sequenceNumber: nextSequence, status };
    });
  }

  // --------------------------------------------------------------------------
  // ATOMIC SERVER-AUTHORITATIVE SPIN & UNIFORM GROUP ALLOCATION (10/10/10)
  // --------------------------------------------------------------------------
  async executeSpin(teamId: string): Promise<SpinResult> {
    return this.mutex.runExclusive(() => {
      const team = this.db.teams[teamId];
      if (!team) {
        throw new PortalError(404, 'TEAM_NOT_FOUND', 'Team record not found.');
      }

      const settings = this.db.eventSettings;

      if (team.drawCompleted) {
        throw new PortalError(
          409,
          'DRAW_ALREADY_COMPLETED',
          'Repeated spins are strictly prohibited. Your allocation is permanently locked.'
        );
      }

      if (settings.currentActiveTeamId !== teamId || team.queueStatus !== 'ACTIVE') {
        throw new PortalError(
          403,
          'NOT_YOUR_TURN',
          'Only the position #1 ACTIVE team leader in the FIFO queue can start the spin.'
        );
      }

      const eligibleGroups = GROUP_IDS.map((gid) => this.db.groups[gid]).filter(
        (g) => g.teamCount < g.maxCapacity
      );

      if (eligibleGroups.length === 0) {
        throw new PortalError(
          409,
          'ALL_GROUPS_FULL',
          'All groups have reached their 10-team maximum capacity.'
        );
      }

      // Cryptographically uniform random pick among remaining eligible groups
      const chosenGroup = pickUniformGroup(eligibleGroups);
      const ts = nowIso();
      const drawOrder = settings.completedDraws + 1;
      const activeEntry = team.activeQueueEntryId
        ? this.db.drawQueue[team.activeQueueEntryId]
        : null;
      const sequenceNumber = team.queueNumber ?? activeEntry?.sequenceNumber ?? drawOrder;
      const drawId = `DRAW_${String(drawOrder).padStart(2, '0')}_${teamId}`;

      // 1. Update chosen group capacity
      chosenGroup.teamIds.push(teamId);
      chosenGroup.teamCount = chosenGroup.teamIds.length;

      // 2. Permanently lock team allocation
      team.assignedGroup = chosenGroup.groupId;
      team.assignedGroupName = chosenGroup.groupName;
      team.drawCompleted = true;
      team.drawOrder = drawOrder;
      team.queueStatus = 'COMPLETED';
      team.activeQueueEntryId = null;
      team.allocatedAt = ts;
      team.lastSeenAt = ts;

      // 3. Complete queue entry
      if (activeEntry) {
        activeEntry.status = 'COMPLETED';
        activeEntry.completedAt = ts;
        activeEntry.assignedGroup = chosenGroup.groupId;
      }

      // 4. Append immutable drawHistory record
      this.db.drawHistory.push({
        drawId,
        teamId,
        teamName: team.teamName,
        studentId: team.studentId,
        maskedStudentId: maskStudentId(team.studentId),
        maskedRegistrationCode: team.maskedRegistrationCode,
        sequenceNumber,
        drawOrder,
        assignedGroup: chosenGroup.groupId,
        assignedGroupName: chosenGroup.groupName,
        timestamp: ts,
        status: 'CONFIRMED',
      });

      // 5. Automatically advance FIFO queue to next lowest sequenceNumber WAITING team
      const nextWaiting = Object.values(this.db.drawQueue)
        .filter((q) => q.status === 'WAITING')
        .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];

      if (nextWaiting) {
        nextWaiting.status = 'ACTIVE';
        nextWaiting.activatedAt = ts;
        const nextTeam = this.db.teams[nextWaiting.teamId];
        if (nextTeam) {
          nextTeam.queueStatus = 'ACTIVE';
        }
        settings.currentActiveTeamId = nextWaiting.teamId;
      } else {
        settings.currentActiveTeamId = null;
      }

      // 6. Update global event settings
      settings.completedDraws = drawOrder;
      const allDone = drawOrder >= TOTAL_REGISTERED_TEAMS;
      settings.eventStatus = allDone ? 'COMPLETED' : 'LIVE';
      settings.queueStatus = allDone
        ? 'COMPLETED'
        : settings.currentActiveTeamId
        ? 'ACTIVE'
        : 'IDLE';

      this.appendAudit(
        'DRAW_COMPLETED',
        team.studentId,
        teamId,
        `Draw #${drawOrder} locked -> ${chosenGroup.groupName} (${chosenGroup.teamCount}/10). Eligible pool: [${eligibleGroups
          .map((g) => g.groupName)
          .join(', ')}]. Next active: ${settings.currentActiveTeamId ?? 'NONE'}.`
      );
      this.persist();
      this.broadcastUpdate('draw-completed');

      return {
        drawId,
        teamId,
        assignedGroup: chosenGroup.groupId,
        assignedGroupName: chosenGroup.groupName,
        drawOrder,
        sequenceNumber,
        allocatedAt: ts,
      };
    });
  }

  // --------------------------------------------------------------------------
  // PRESENCE HEARTBEAT (Preserves Queue Place on Disconnect; Alerts Admin)
  // --------------------------------------------------------------------------
  async recordHeartbeat(teamId: string): Promise<{ ok: true; timestamp: string }> {
    return this.mutex.runExclusive(() => {
      const team = this.db.teams[teamId];
      if (!team) {
        throw new PortalError(404, 'TEAM_NOT_FOUND', 'Team not found.');
      }
      const ts = nowIso();
      team.lastSeenAt = ts;
      if (team.activeQueueEntryId && this.db.drawQueue[team.activeQueueEntryId]) {
        this.db.drawQueue[team.activeQueueEntryId].lastHeartbeatAt = ts;
      }
      // Lightweight persistence without noisy broadcasts unless needed
      this.persist();
      return { ok: true, timestamp: ts };
    });
  }

  // --------------------------------------------------------------------------
  // ADMIN CONTROLS (Audited, Safe, Non-Duplicating)
  // --------------------------------------------------------------------------
  async adminToggleQueuePause(paused: boolean, reason: string): Promise<{ queuePaused: boolean }> {
    return this.mutex.runExclusive(() => {
      const ts = nowIso();
      this.db.eventSettings.queuePaused = paused;
      this.db.eventSettings.queuePausedAt = paused ? ts : null;
      this.appendAudit(
        paused ? 'QUEUE_PAUSED' : 'QUEUE_RESUMED',
        'ADMIN',
        null,
        reason.trim() ||
          (paused
            ? 'Organizer paused new FIFO queue admissions.'
            : 'Organizer resumed FIFO queue admissions.')
      );
      this.persist();
      this.broadcastUpdate('queue-pause-toggled');
      return { queuePaused: paused };
    });
  }

  async adminResolveAbandoned(
    targetTeamId: string,
    action: 'MOVE_TO_BACK' | 'RELEASE_TO_IDLE',
    reason: string
  ): Promise<{ resolvedTeamId: string; action: string; nextActiveTeamId: string | null }> {
    if (!reason.trim()) {
      throw new PortalError(400, 'REASON_REQUIRED', 'An audit reason is required for admin queue actions.');
    }

    return this.mutex.runExclusive(() => {
      const settings = this.db.eventSettings;
      const team = this.db.teams[targetTeamId];
      if (!team) {
        throw new PortalError(404, 'TEAM_NOT_FOUND', 'Target team not found.');
      }
      if (team.drawCompleted) {
        throw new PortalError(
          409,
          'DRAW_LOCKED',
          'Cannot resolve queue for a team that has already completed its draw.'
        );
      }
      if (settings.currentActiveTeamId !== targetTeamId || team.queueStatus !== 'ACTIVE') {
        throw new PortalError(
          409,
          'NOT_ACTIVE',
          'Target team is not the currently active spinner.'
        );
      }

      const nextWaiting = Object.values(this.db.drawQueue)
        .filter((q) => q.status === 'WAITING')
        .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];

      if (action === 'MOVE_TO_BACK' && !nextWaiting) {
        throw new PortalError(
          409,
          'NO_WAITING_TEAMS',
          'No other teams are waiting in queue. Use "Release from Active Queue" instead.'
        );
      }

      const ts = nowIso();
      if (team.activeQueueEntryId && this.db.drawQueue[team.activeQueueEntryId]) {
        this.db.drawQueue[team.activeQueueEntryId].status =
          action === 'MOVE_TO_BACK' ? 'REQUEUED' : 'ABANDONED_RELEASED';
        this.db.drawQueue[team.activeQueueEntryId].completedAt = ts;
      }

      if (action === 'MOVE_TO_BACK') {
        settings.lastQueueSequence += 1;
        const newSeq = settings.lastQueueSequence;
        const newEntryId = `Q${String(newSeq).padStart(4, '0')}_${targetTeamId}`;
        this.db.drawQueue[newEntryId] = {
          queueEntryId: newEntryId,
          teamId: targetTeamId,
          teamName: team.teamName,
          maskedStudentId: maskStudentId(team.studentId),
          sequenceNumber: newSeq,
          status: 'WAITING',
          joinedAt: ts,
          activatedAt: null,
          completedAt: null,
          lastHeartbeatAt: team.lastSeenAt,
        };
        team.queueStatus = 'WAITING';
        team.queueNumber = newSeq;
        team.activeQueueEntryId = newEntryId;
      } else {
        team.queueStatus = 'NOT_JOINED';
        team.queueNumber = null;
        team.activeQueueEntryId = null;
      }

      if (nextWaiting) {
        nextWaiting.status = 'ACTIVE';
        nextWaiting.activatedAt = ts;
        const nextTeam = this.db.teams[nextWaiting.teamId];
        if (nextTeam) nextTeam.queueStatus = 'ACTIVE';
        settings.currentActiveTeamId = nextWaiting.teamId;
        settings.queueStatus = 'ACTIVE';
      } else {
        settings.currentActiveTeamId = null;
        settings.queueStatus = 'IDLE';
      }

      this.appendAudit(
        `ADMIN_ABANDONED_${action}`,
        'ADMIN',
        targetTeamId,
        `Reason: ${reason.trim()}. Next active: ${settings.currentActiveTeamId ?? 'NONE'}.`
      );
      this.persist();
      this.broadcastUpdate('admin-resolved-abandoned');

      return {
        resolvedTeamId: targetTeamId,
        action,
        nextActiveTeamId: settings.currentActiveTeamId,
      };
    });
  }

  async adminControlledReassign(
    teamId: string,
    targetGroupId: GroupId,
    reason: string
  ): Promise<{ teamId: string; oldGroupId: GroupId; newGroupId: GroupId }> {
    if (!reason.trim()) {
      throw new PortalError(400, 'REASON_REQUIRED', 'An audit reason is required for group reassignment.');
    }
    if (!GROUP_IDS.includes(targetGroupId)) {
      throw new PortalError(400, 'INVALID_GROUP', 'Invalid target group.');
    }

    return this.mutex.runExclusive(() => {
      const team = this.db.teams[teamId];
      if (!team) throw new PortalError(404, 'TEAM_NOT_FOUND', 'Team not found.');
      if (!team.drawCompleted || !team.assignedGroup) {
        throw new PortalError(409, 'NOT_DRAWN', 'Only completed allocations can be reassigned.');
      }
      const oldGroupId = team.assignedGroup;
      if (oldGroupId === targetGroupId) {
        throw new PortalError(409, 'SAME_GROUP', 'Team is already assigned to that group.');
      }

      const oldGroup = this.db.groups[oldGroupId];
      const newGroup = this.db.groups[targetGroupId];

      if (newGroup.teamCount >= newGroup.maxCapacity) {
        throw new PortalError(
          409,
          'TARGET_GROUP_FULL',
          `${newGroup.groupName} is already at maximum capacity (10/10).`
        );
      }

      oldGroup.teamIds = oldGroup.teamIds.filter((id) => id !== teamId);
      oldGroup.teamCount = oldGroup.teamIds.length;
      newGroup.teamIds.push(teamId);
      newGroup.teamCount = newGroup.teamIds.length;

      team.assignedGroup = targetGroupId;
      team.assignedGroupName = newGroup.groupName;

      // Update draw history display record while keeping original drawOrder & audit record
      const hist = this.db.drawHistory.find((h) => h.teamId === teamId);
      if (hist) {
        hist.assignedGroup = targetGroupId;
        hist.assignedGroupName = newGroup.groupName;
      }

      this.appendAudit(
        'ADMIN_CONTROLLED_REASSIGN',
        'ADMIN',
        teamId,
        `Reassigned ${teamId} from ${oldGroup.groupName} to ${newGroup.groupName}. Reason: ${reason.trim()}`
      );
      this.persist();
      this.broadcastUpdate('admin-reassign');

      return { teamId, oldGroupId, newGroupId: targetGroupId };
    });
  }

  // Test/Sandbox reset utility (Admin-only, explicitly guarded by confirmation flag)
  async adminResetForTesting(confirmPhrase: string): Promise<{ reset: true }> {
    if (confirmPhrase !== 'RESET-INNOHACK-SANDBOX') {
      throw new PortalError(400, 'INVALID_CONFIRM', 'Confirmation phrase mismatch.');
    }
    return this.mutex.runExclusive(() => {
      this.db = buildFreshDatabase();
      this.persist();
      this.broadcastUpdate('sandbox-reset');
      return { reset: true };
    });
  }
}

export const store = new ServerAuthoritativeStore();
