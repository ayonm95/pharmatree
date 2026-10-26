import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Pool } from "@neondatabase/serverless";

// Try loading neon serverless driver if DATABASE_URL is set
let neonPool: Pool | null = null;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (DATABASE_URL) {
  try {
    neonPool = new Pool({ connectionString: DATABASE_URL });
  } catch (err) {
    console.warn("[Database] Neon driver not available, falling back to local file storage:", err);
  }
}

// Local fallback file paths
const DATA_DIR = path.join(process.cwd(), ".data");
const SCANS_FILE = path.join(DATA_DIR, "scans.json");
const INCIDENTS_FILE = path.join(DATA_DIR, "incidents.json");
const UNITS_FILE = path.join(DATA_DIR, "units.json");
const UNIT_EVENTS_FILE = path.join(DATA_DIR, "unit_events.json");
const INDEXER_STATE_FILE = path.join(DATA_DIR, "indexer_state.json");
const SEALS_FILE = path.join(DATA_DIR, "seals.json");

// Ensure local directory exists
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export interface DbScanRecord {
  unitId: string;
  scanCount: number;
  firstScanTime: number; // Unix timestamp in seconds
  lastScanTime: number;
  isFirstScan: boolean;
}

export interface DbIncidentReport {
  incidentId: string;
  unitId: string;
  rawPayload: string;
  tierFailed: number;
  reason: string;
  message: string;
  vendorAddress?: string;
  terminalId?: string;
  coordinates?: { latitude: number; longitude: number };
  notes?: string;
  status: "QUARANTINED" | "RESOLVED" | "UNDER_REVIEW";
  timestamp: number;
  isoDate: string;
}

// Initialize tables if connected to PostgreSQL
let schemaInitialized = false;
export async function initDbSchema(): Promise<void> {
  if (!neonPool || schemaInitialized) return;
  try {
    await neonPool.query(`
      CREATE TABLE IF NOT EXISTS scans (
        unit_id VARCHAR(64) PRIMARY KEY,
        scan_count INTEGER NOT NULL DEFAULT 1,
        first_scanned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        last_scanned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        source VARCHAR(64) DEFAULT 'web',
        ip_hash VARCHAR(64)
      );

      CREATE TABLE IF NOT EXISTS incidents (
        incident_id VARCHAR(64) PRIMARY KEY,
        unit_id VARCHAR(64) NOT NULL,
        raw_payload TEXT,
        tier_failed INTEGER NOT NULL,
        reason VARCHAR(64) NOT NULL,
        message TEXT,
        vendor_address VARCHAR(42),
        terminal_id VARCHAR(64),
        latitude NUMERIC(9,6),
        longitude NUMERIC(9,6),
        notes TEXT,
        status VARCHAR(32) DEFAULT 'QUARANTINED',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS seal_secrets (
        unit_id VARCHAR(64) PRIMARY KEY,
        verifier VARCHAR(128) NOT NULL,
        scheme INTEGER NOT NULL DEFAULT 1,
        state VARCHAR(32) DEFAULT 'SEALED',
        failed_attempts INTEGER DEFAULT 0,
        locked_until TIMESTAMP WITH TIME ZONE,
        consumed_at TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS units (
        unit_id VARCHAR(64) PRIMARY KEY,
        parent_id VARCHAR(64),
        root_id VARCHAR(64),
        level INTEGER,
        manufacturer VARCHAR(42),
        current_owner VARCHAR(42),
        pending_receiver VARCHAR(42),
        status INTEGER,
        quantity NUMERIC,
        metadata TEXT,
        gtin VARCHAR(14),
        lot VARCHAR(32),
        serial VARCHAR(32),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS unit_events (
        id SERIAL PRIMARY KEY,
        unit_id VARCHAR(64) NOT NULL,
        event_name VARCHAR(64) NOT NULL,
        from_address VARCHAR(42),
        to_address VARCHAR(42),
        block_number BIGINT NOT NULL,
        tx_hash VARCHAR(66) NOT NULL,
        timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS indexer_state (
        key VARCHAR(64) PRIMARY KEY,
        value VARCHAR(256) NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    schemaInitialized = true;
  } catch (err) {
    console.error("[Database] Schema initialization failed:", err);
  }
}

/**
 * Hash client IP with a daily/server salt to protect user privacy
 */
export function hashClientIp(ip: string): string {
  const salt = process.env.SEAL_PEPPER || "pharmatree-client-salt-v1";
  return crypto.createHash("sha256").update(`${ip}:${salt}`).digest("hex").slice(0, 16);
}

/**
 * Record a scan atomically using Postgres UPSERT or fallback to local disk
 */
export async function recordScanAtomic(
  unitId: string,
  ip = "127.0.0.1",
  source = "scanner"
): Promise<DbScanRecord> {
  const ipHash = hashClientIp(ip);
  const nowSec = Math.floor(Date.now() / 1000);

  if (neonPool) {
    await initDbSchema();
    try {
      const result = await neonPool.query(
        `INSERT INTO scans (unit_id, scan_count, first_scanned_at, last_scanned_at, source, ip_hash)
         VALUES ($1, 1, NOW(), NOW(), $2, $3)
         ON CONFLICT (unit_id) DO UPDATE SET
           scan_count = scans.scan_count + 1,
           last_scanned_at = NOW(),
           ip_hash = $3
         RETURNING scan_count,
                   EXTRACT(EPOCH FROM first_scanned_at)::BIGINT AS first_scan,
                   EXTRACT(EPOCH FROM last_scanned_at)::BIGINT AS last_scan;`,
        [unitId, source, ipHash]
      );
      const row = result.rows[0];
      const count = Number(row.scan_count);
      return {
        unitId,
        scanCount: count,
        firstScanTime: Number(row.first_scan),
        lastScanTime: Number(row.last_scan),
        isFirstScan: count === 1,
      };
    } catch (err) {
      console.warn("[Database] Postgres query failed, falling back to local file:", err);
    }
  }

  // Local fallback mode
  ensureDataDir();
  let scans: Record<string, any> = {};
  try {
    if (fs.existsSync(SCANS_FILE)) {
      scans = JSON.parse(fs.readFileSync(SCANS_FILE, "utf-8"));
    }
  } catch {
    scans = {};
  }

  const existing = scans[unitId];
  let record: any;
  if (existing) {
    record = {
      scanCount: existing.scanCount + 1,
      firstScanTime: existing.firstScanTime,
      lastScanTime: nowSec,
      source,
      ipHash,
    };
  } else {
    record = {
      scanCount: 1,
      firstScanTime: nowSec,
      lastScanTime: nowSec,
      source,
      ipHash,
    };
  }

  scans[unitId] = record;
  try {
    fs.writeFileSync(SCANS_FILE, JSON.stringify(scans, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not write scans to disk:", err);
  }

  return {
    unitId,
    scanCount: record.scanCount,
    firstScanTime: record.firstScanTime,
    lastScanTime: record.lastScanTime,
    isFirstScan: record.scanCount === 1,
  };
}

/**
 * Retrieve scan count record for a unit
 */
export async function getScanRecord(unitId: string): Promise<DbScanRecord> {
  if (neonPool) {
    await initDbSchema();
    try {
      const result = await neonPool.query(
        `SELECT scan_count,
                EXTRACT(EPOCH FROM first_scanned_at)::BIGINT AS first_scan,
                EXTRACT(EPOCH FROM last_scanned_at)::BIGINT AS last_scan
         FROM scans WHERE unit_id = $1`,
        [unitId]
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          unitId,
          scanCount: Number(row.scan_count),
          firstScanTime: Number(row.first_scan),
          lastScanTime: Number(row.last_scan),
          isFirstScan: false,
        };
      }
      return {
        unitId,
        scanCount: 0,
        firstScanTime: 0,
        lastScanTime: 0,
        isFirstScan: true,
      };
    } catch (err) {
      console.warn("[Database] Postgres query failed, falling back to local file:", err);
    }
  }

  // Fallback
  ensureDataDir();
  try {
    if (fs.existsSync(SCANS_FILE)) {
      const scans = JSON.parse(fs.readFileSync(SCANS_FILE, "utf-8"));
      const existing = scans[unitId];
      if (existing) {
        return {
          unitId,
          scanCount: existing.scanCount,
          firstScanTime: existing.firstScanTime,
          lastScanTime: existing.lastScanTime,
          isFirstScan: false,
        };
      }
    }
  } catch {
    // Ignore
  }

  return {
    unitId,
    scanCount: 0,
    firstScanTime: 0,
    lastScanTime: 0,
    isFirstScan: true,
  };
}

/**
 * Save an incident report permanently in Postgres or local disk
 */
export async function saveIncidentReport(report: DbIncidentReport): Promise<void> {
  if (neonPool) {
    await initDbSchema();
    try {
      await neonPool.query(
        `INSERT INTO incidents (
           incident_id, unit_id, raw_payload, tier_failed, reason, message,
           vendor_address, terminal_id, latitude, longitude, notes, status, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TO_TIMESTAMP($13))
         ON CONFLICT (incident_id) DO NOTHING;`,
        [
          report.incidentId,
          report.unitId,
          report.rawPayload,
          report.tierFailed,
          report.reason,
          report.message,
          report.vendorAddress || null,
          report.terminalId || null,
          report.coordinates?.latitude || null,
          report.coordinates?.longitude || null,
          report.notes || null,
          report.status,
          report.timestamp,
        ]
      );
      return;
    } catch (err) {
      console.warn("[Database] Postgres incident save failed, falling back to disk:", err);
    }
  }

  // Fallback
  ensureDataDir();
  let incidents: DbIncidentReport[] = [];
  try {
    if (fs.existsSync(INCIDENTS_FILE)) {
      incidents = JSON.parse(fs.readFileSync(INCIDENTS_FILE, "utf-8"));
    }
  } catch {
    incidents = [];
  }
  incidents.push(report);
  try {
    fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not save incidents to disk:", err);
  }
}

/**
 * Retrieve recent incidents
 */
export async function getIncidentsList(limit = 50): Promise<DbIncidentReport[]> {
  if (neonPool) {
    await initDbSchema();
    try {
      const res = await neonPool.query(
        `SELECT incident_id, unit_id, raw_payload, tier_failed, reason, message,
                vendor_address, terminal_id, latitude, longitude, notes, status,
                EXTRACT(EPOCH FROM created_at)::BIGINT AS timestamp,
                created_at::TEXT AS iso_date
         FROM incidents
         ORDER BY created_at DESC
         LIMIT $1;`,
        [limit]
      );
      return res.rows.map((row: any) => ({
        incidentId: row.incident_id,
        unitId: row.unit_id,
        rawPayload: row.raw_payload,
        tierFailed: Number(row.tier_failed),
        reason: row.reason,
        message: row.message,
        vendorAddress: row.vendor_address,
        terminalId: row.terminal_id,
        coordinates: row.latitude ? { latitude: Number(row.latitude), longitude: Number(row.longitude) } : undefined,
        notes: row.notes,
        status: row.status,
        timestamp: Number(row.timestamp),
        isoDate: row.iso_date,
      }));
    } catch (err) {
      console.warn("[Database] Postgres incident retrieval failed, falling back to disk:", err);
    }
  }

  // Fallback
  ensureDataDir();
  try {
    if (fs.existsSync(INCIDENTS_FILE)) {
      const list: DbIncidentReport[] = JSON.parse(fs.readFileSync(INCIDENTS_FILE, "utf-8"));
      list.sort((a, b) => b.timestamp - a.timestamp);
      return list.slice(0, limit);
    }
  } catch {
    // Ignore
  }
  return [];
}

export interface DbUnitRecord {
  unitId: string;
  parentId: string;
  rootId: string;
  level: number;
  manufacturer: string;
  currentOwner: string;
  pendingReceiver: string;
  status: number;
  quantity: string;
  metadata: string;
  gtin?: string;
  lot?: string;
  serial?: string;
  displayId?: string;
  updatedAt?: string;
}

export interface DbUnitEvent {
  id?: number;
  unitId: string;
  eventName: string;
  fromAddress?: string;
  toAddress?: string;
  blockNumber: number;
  txHash: string;
  timestamp: number;
}

/**
 * Upsert unit state in Postgres or local disk cache
 */
export async function upsertUnitRecord(unit: DbUnitRecord): Promise<void> {
  if (neonPool) {
    await initDbSchema();
    try {
      await neonPool.query(
        `INSERT INTO units (
           unit_id, parent_id, root_id, level, manufacturer, current_owner,
           pending_receiver, status, quantity, metadata, gtin, lot, serial, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (unit_id) DO UPDATE SET
           parent_id = $2,
           root_id = $3,
           level = $4,
           manufacturer = $5,
           current_owner = $6,
           pending_receiver = $7,
           status = $8,
           quantity = $9,
           metadata = $10,
           gtin = COALESCE($11, units.gtin),
           lot = COALESCE($12, units.lot),
           serial = COALESCE($13, units.serial),
           updated_at = NOW();`,
        [
          unit.unitId,
          unit.parentId,
          unit.rootId,
          unit.level,
          unit.manufacturer,
          unit.currentOwner,
          unit.pendingReceiver,
          unit.status,
          unit.quantity,
          unit.metadata,
          unit.gtin || null,
          unit.lot || null,
          unit.serial || null,
        ]
      );
      return;
    } catch (err) {
      console.warn("[Database] Postgres upsertUnitRecord failed, falling back to disk:", err);
    }
  }

  // Local fallback
  ensureDataDir();
  let unitsMap: Record<string, DbUnitRecord> = {};
  try {
    if (fs.existsSync(UNITS_FILE)) {
      unitsMap = JSON.parse(fs.readFileSync(UNITS_FILE, "utf-8"));
    }
  } catch {
    unitsMap = {};
  }
  unitsMap[unit.unitId] = {
    ...unit,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(UNITS_FILE, JSON.stringify(unitsMap, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not write units to disk:", err);
  }
}

/**
 * Fetch a unit by its on-chain ID
 */
export async function getUnitById(unitId: string): Promise<DbUnitRecord | null> {
  if (neonPool) {
    await initDbSchema();
    try {
      const res = await neonPool.query(
        `SELECT unit_id, parent_id, root_id, level, manufacturer, current_owner,
                pending_receiver, status, quantity::TEXT, metadata, gtin, lot, serial,
                updated_at::TEXT
         FROM units WHERE unit_id = $1`,
        [unitId]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          unitId: row.unit_id,
          parentId: row.parent_id,
          rootId: row.root_id,
          level: Number(row.level),
          manufacturer: row.manufacturer,
          currentOwner: row.current_owner,
          pendingReceiver: row.pending_receiver,
          status: Number(row.status),
          quantity: row.quantity,
          metadata: row.metadata,
          gtin: row.gtin || undefined,
          lot: row.lot || undefined,
          serial: row.serial || undefined,
          updatedAt: row.updated_at,
        };
      }
      return null;
    } catch (err) {
      console.warn("[Database] Postgres getUnitById failed, falling back to disk:", err);
    }
  }

  // Fallback
  ensureDataDir();
  try {
    if (fs.existsSync(UNITS_FILE)) {
      const unitsMap: Record<string, DbUnitRecord> = JSON.parse(fs.readFileSync(UNITS_FILE, "utf-8"));
      return unitsMap[unitId] || null;
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Paginated units retrieval with optional owner or status filters
 */
export async function getUnitsPaginated(filter: {
  limit?: number;
  cursor?: number;
  owner?: string;
  status?: number;
}): Promise<{ units: DbUnitRecord[]; nextCursor: number | null; total: number }> {
  const limit = Math.min(Math.max(filter.limit || 25, 1), 100);
  const cursor = filter.cursor || 0;

  if (neonPool) {
    await initDbSchema();
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      if (cursor > 0) {
        conditions.push(`unit_id::BIGINT > $${paramIdx++}`);
        params.push(cursor);
      }
      if (filter.owner) {
        conditions.push(`LOWER(current_owner) = LOWER($${paramIdx++})`);
        params.push(filter.owner);
      }
      if (filter.status !== undefined) {
        conditions.push(`status = $${paramIdx++}`);
        params.push(filter.status);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const totalRes = await neonPool.query(`SELECT COUNT(*) AS count FROM units ${whereClause}`, params);
      const total = Number(totalRes.rows[0].count);

      params.push(limit);
      const query = `
        SELECT unit_id, parent_id, root_id, level, manufacturer, current_owner,
               pending_receiver, status, quantity::TEXT, metadata, gtin, lot, serial,
               updated_at::TEXT
        FROM units
        ${whereClause}
        ORDER BY unit_id::BIGINT ASC
        LIMIT $${paramIdx};
      `;

      const res = await neonPool.query(query, params);
      const units: DbUnitRecord[] = res.rows.map((row: any) => ({
        unitId: row.unit_id,
        parentId: row.parent_id,
        rootId: row.root_id,
        level: Number(row.level),
        manufacturer: row.manufacturer,
        currentOwner: row.current_owner,
        pendingReceiver: row.pending_receiver,
        status: Number(row.status),
        quantity: row.quantity,
        metadata: row.metadata,
        gtin: row.gtin || undefined,
        lot: row.lot || undefined,
        serial: row.serial || undefined,
        updatedAt: row.updated_at,
      }));

      const lastUnit = units[units.length - 1];
      const nextCursor = units.length === limit && lastUnit ? Number(lastUnit.unitId) : null;

      return { units, nextCursor, total };
    } catch (err) {
      console.warn("[Database] Postgres getUnitsPaginated failed, falling back to disk:", err);
    }
  }

  // Fallback
  ensureDataDir();
  try {
    if (fs.existsSync(UNITS_FILE)) {
      const unitsMap: Record<string, DbUnitRecord> = JSON.parse(fs.readFileSync(UNITS_FILE, "utf-8"));
      let allUnits = Object.values(unitsMap).sort(
        (a, b) => Number(a.unitId) - Number(b.unitId)
      );

      if (cursor > 0) {
        allUnits = allUnits.filter((u) => Number(u.unitId) > cursor);
      }
      if (filter.owner) {
        const ownerLower = filter.owner.toLowerCase();
        allUnits = allUnits.filter((u) => u.currentOwner.toLowerCase() === ownerLower);
      }
      if (filter.status !== undefined) {
        allUnits = allUnits.filter((u) => u.status === filter.status);
      }

      const total = allUnits.length;
      const sliced = allUnits.slice(0, limit);
      const last = sliced[sliced.length - 1];
      const nextCursor = sliced.length === limit && last ? Number(last.unitId) : null;

      return { units: sliced, nextCursor, total };
    }
  } catch {
    // Ignore
  }

  return { units: [], nextCursor: null, total: 0 };
}

/**
 * Save a unit event
 */
export async function saveUnitEvent(event: DbUnitEvent): Promise<void> {
  if (neonPool) {
    await initDbSchema();
    try {
      await neonPool.query(
        `INSERT INTO unit_events (unit_id, event_name, from_address, to_address, block_number, tx_hash, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, TO_TIMESTAMP($7));`,
        [
          event.unitId,
          event.eventName,
          event.fromAddress || null,
          event.toAddress || null,
          event.blockNumber,
          event.txHash,
          event.timestamp,
        ]
      );
      return;
    } catch (err) {
      console.warn("[Database] Postgres saveUnitEvent failed, falling back to disk:", err);
    }
  }

  // Fallback
  ensureDataDir();
  let events: DbUnitEvent[] = [];
  try {
    if (fs.existsSync(UNIT_EVENTS_FILE)) {
      events = JSON.parse(fs.readFileSync(UNIT_EVENTS_FILE, "utf-8"));
    }
  } catch {
    events = [];
  }
  events.push(event);
  try {
    fs.writeFileSync(UNIT_EVENTS_FILE, JSON.stringify(events, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not save unit event to disk:", err);
  }
}

/**
 * Retrieve events for a unit
 */
export async function getUnitEvents(unitId: string): Promise<DbUnitEvent[]> {
  if (neonPool) {
    await initDbSchema();
    try {
      const res = await neonPool.query(
        `SELECT id, unit_id, event_name, from_address, to_address, block_number, tx_hash,
                EXTRACT(EPOCH FROM timestamp)::BIGINT AS timestamp
         FROM unit_events
         WHERE unit_id = $1
         ORDER BY block_number ASC, id ASC;`,
        [unitId]
      );
      return res.rows.map((r: any) => ({
        id: r.id,
        unitId: r.unit_id,
        eventName: r.event_name,
        fromAddress: r.from_address || undefined,
        toAddress: r.to_address || undefined,
        blockNumber: Number(r.block_number),
        txHash: r.tx_hash,
        timestamp: Number(r.timestamp),
      }));
    } catch (err) {
      console.warn("[Database] Postgres getUnitEvents failed, falling back to disk:", err);
    }
  }

  // Fallback
  ensureDataDir();
  try {
    if (fs.existsSync(UNIT_EVENTS_FILE)) {
      const events: DbUnitEvent[] = JSON.parse(fs.readFileSync(UNIT_EVENTS_FILE, "utf-8"));
      return events.filter((e) => e.unitId === unitId);
    }
  } catch {
    // Ignore
  }
  return [];
}

/**
 * Track last indexed block
 */
export async function getLastIndexedBlock(defaultBlock = 11995000): Promise<number> {
  if (neonPool) {
    await initDbSchema();
    try {
      const res = await neonPool.query(
        `SELECT value FROM indexer_state WHERE key = 'last_indexed_block';`
      );
      if (res.rows.length > 0) {
        return Number(res.rows[0].value);
      }
      return defaultBlock;
    } catch (err) {
      console.warn("[Database] Postgres getLastIndexedBlock failed, falling back to disk:", err);
    }
  }

  // Fallback
  ensureDataDir();
  try {
    if (fs.existsSync(INDEXER_STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(INDEXER_STATE_FILE, "utf-8"));
      if (state.last_indexed_block) {
        return Number(state.last_indexed_block);
      }
    }
  } catch {
    // Ignore
  }
  return defaultBlock;
}

export async function setLastIndexedBlock(blockNumber: number): Promise<void> {
  if (neonPool) {
    await initDbSchema();
    try {
      await neonPool.query(
        `INSERT INTO indexer_state (key, value, updated_at)
         VALUES ('last_indexed_block', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW();`,
        [String(blockNumber)]
      );
      return;
    } catch (err) {
      console.warn("[Database] Postgres setLastIndexedBlock failed, falling back to disk:", err);
    }
  }

  // Fallback
  ensureDataDir();
  try {
    let state: Record<string, any> = {};
    if (fs.existsSync(INDEXER_STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(INDEXER_STATE_FILE, "utf-8"));
    }
    state.last_indexed_block = blockNumber;
    fs.writeFileSync(INDEXER_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not save indexer state to disk:", err);
  }
}

export interface DbSealRecord {
  unitId: string;
  verifier: string;
  scheme: number; // 0 = legacy 4-digit PIN, 1 = Crockford Base32 12-char HMAC
  state: "SEALED" | "VERIFIED" | "LOCKED_REVIEW";
  failedAttempts: number;
  lockedUntil?: string | null;
  consumedAt?: string | null;
}

/**
 * Get scratch seal record
 */
export async function getSealRecord(unitId: string): Promise<DbSealRecord | null> {
  if (neonPool) {
    await initDbSchema();
    try {
      const res = await neonPool.query(
        `SELECT unit_id, verifier, scheme, state, failed_attempts,
                locked_until::TEXT, consumed_at::TEXT
         FROM seal_secrets WHERE unit_id = $1;`,
        [unitId]
      );
      if (res.rows.length > 0) {
        const r = res.rows[0];
        return {
          unitId: r.unit_id,
          verifier: r.verifier,
          scheme: Number(r.scheme),
          state: r.state,
          failedAttempts: Number(r.failed_attempts),
          lockedUntil: r.locked_until,
          consumedAt: r.consumed_at,
        };
      }
      return null;
    } catch (err) {
      console.warn("[Database] Postgres getSealRecord failed, falling back to disk:", err);
    }
  }

  // Fallback
  ensureDataDir();
  try {
    if (fs.existsSync(SEALS_FILE)) {
      const seals: Record<string, DbSealRecord> = JSON.parse(fs.readFileSync(SEALS_FILE, "utf-8"));
      return seals[unitId] || null;
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Upsert or register a scratch seal record
 */
export async function upsertSealRecord(record: DbSealRecord): Promise<void> {
  if (neonPool) {
    await initDbSchema();
    try {
      await neonPool.query(
        `INSERT INTO seal_secrets (unit_id, verifier, scheme, state, failed_attempts, locked_until, consumed_at)
         VALUES ($1, $2, $3, $4, $5, $6::TIMESTAMP WITH TIME ZONE, $7::TIMESTAMP WITH TIME ZONE)
         ON CONFLICT (unit_id) DO UPDATE SET
           verifier = $2,
           scheme = $3,
           state = $4,
           failed_attempts = $5,
           locked_until = $6::TIMESTAMP WITH TIME ZONE,
           consumed_at = $7::TIMESTAMP WITH TIME ZONE;`,
        [
          record.unitId,
          record.verifier,
          record.scheme,
          record.state,
          record.failedAttempts,
          record.lockedUntil || null,
          record.consumedAt || null,
        ]
      );
      return;
    } catch (err) {
      console.warn("[Database] Postgres upsertSealRecord failed, falling back to disk:", err);
    }
  }

  // Fallback
  ensureDataDir();
  let seals: Record<string, DbSealRecord> = {};
  try {
    if (fs.existsSync(SEALS_FILE)) {
      seals = JSON.parse(fs.readFileSync(SEALS_FILE, "utf-8"));
    }
  } catch {
    seals = {};
  }
  seals[record.unitId] = record;
  try {
    fs.writeFileSync(SEALS_FILE, JSON.stringify(seals, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not write seals to disk:", err);
  }
}

/**
 * Record a failed seal attempt; locks the seal for 24-hour cooldown if attempts >= 5
 */
export async function recordFailedSealAttempt(
  unitId: string
): Promise<{ locked: boolean; failedAttempts: number; lockedUntil?: string }> {
  let existing = await getSealRecord(unitId);
  if (!existing) {
    existing = {
      unitId,
      verifier: "",
      scheme: 1,
      state: "SEALED",
      failedAttempts: 0,
    };
  }

  const newAttempts = existing.failedAttempts + 1;
  const locked = newAttempts >= 5;
  const lockedUntil = locked
    ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    : existing.lockedUntil;

  const updated: DbSealRecord = {
    ...existing,
    failedAttempts: newAttempts,
    state: locked ? "LOCKED_REVIEW" : existing.state,
    lockedUntil,
  };

  await upsertSealRecord(updated);
  return { locked, failedAttempts: newAttempts, lockedUntil: lockedUntil || undefined };
}

/**
 * Mark a seal as successfully verified / consumed
 */
export async function markSealVerified(unitId: string): Promise<void> {
  let existing = await getSealRecord(unitId);
  const now = new Date().toISOString();
  if (!existing) {
    existing = {
      unitId,
      verifier: "",
      scheme: 1,
      state: "VERIFIED",
      failedAttempts: 0,
      consumedAt: now,
    };
  } else {
    existing = {
      ...existing,
      state: "VERIFIED",
      consumedAt: existing.consumedAt || now,
    };
  }

  await upsertSealRecord(existing);
}

/**
 * Reset seal lockout (authorized manufacturer or admin action)
 */
export async function resetSealLockDb(unitId: string): Promise<void> {
  const existing = await getSealRecord(unitId);
  if (existing) {
    await upsertSealRecord({
      ...existing,
      state: existing.consumedAt ? "VERIFIED" : "SEALED",
      failedAttempts: 0,
      lockedUntil: null,
    });
  }
}

