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

// In-memory cache structures to guarantee non-throwing zero-fail operation on read-only serverless runtimes
const inMemoryScans: Record<string, any> = {};
const inMemoryIncidents: DbIncidentReport[] = [];
const inMemoryUnits: Record<string, DbUnitRecord> = {};
const inMemoryUnitEvents: DbUnitEvent[] = [];
const inMemoryIndexerState: Record<string, any> = {};
const inMemorySeals: Record<string, DbSealRecord> = {};

/**
 * Determine a safe, writable directory.
 * On serverless platforms (Vercel, AWS Lambda, Netlify), process.cwd() is read-only.
 * /tmp is the only guaranteed writable directory in serverless containers.
 */
function getWritableDataDir(): string {
  if (
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.cwd().startsWith("/var/task")
  ) {
    return path.join("/tmp", ".pharmatree-data");
  }
  return path.join(process.cwd(), ".data");
}

let cachedDataDir: string | null = null;

function ensureDataDir(): string {
  if (cachedDataDir) {
    try {
      if (!fs.existsSync(cachedDataDir)) {
        fs.mkdirSync(cachedDataDir, { recursive: true });
      }
      return cachedDataDir;
    } catch {
      // Re-detect below
    }
  }

  const primary = getWritableDataDir();
  try {
    if (!fs.existsSync(primary)) {
      fs.mkdirSync(primary, { recursive: true });
    }
    cachedDataDir = primary;
    return primary;
  } catch {
    // If primary failed (e.g. process.cwd() is read-only in production), fallback to /tmp
    try {
      const tmpDir = path.join("/tmp", ".pharmatree-data");
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      cachedDataDir = tmpDir;
      return tmpDir;
    } catch {
      cachedDataDir = primary;
      return primary;
    }
  }
}

function safeReadJson<T>(filename: string, fallback: T): T {
  try {
    const dir = ensureDataDir();
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // Non-fatal read error; return fallback
  }
  return fallback;
}

function safeWriteJson(filename: string, data: any): void {
  try {
    const dir = ensureDataDir();
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    // Non-fatal write failure (e.g. read-only filesystem); in-memory cache still holds state
    console.warn(`[Database] safeWriteJson notice for ${filename} (falling back to memory):`, err);
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

      CREATE TABLE IF NOT EXISTS client_seal_locks (
        lock_key VARCHAR(128) PRIMARY KEY,
        failed_attempts INTEGER NOT NULL DEFAULT 1,
        locked_until TIMESTAMP WITH TIME ZONE,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS vendor_daily_quotas (
        quota_key VARCHAR(128) PRIMARY KEY,
        vendor_address VARCHAR(42) NOT NULL,
        tx_count INTEGER NOT NULL DEFAULT 1,
        day_date DATE NOT NULL DEFAULT CURRENT_DATE,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    schemaInitialized = true;
  } catch (err) {
    console.error("[Database] Schema initialization failed:", err);
  }
}

/**
 * Hash client IP with an HMAC server secret to protect user privacy
 */
export function hashClientIp(ip: string): string {
  const secret = process.env.CLIENT_IP_SECRET || process.env.SEAL_PEPPER || "pharmatree-client-salt-v1";
  return crypto.createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
}

/**
 * Record a scan atomically using Postgres UPSERT or fallback to local disk/memory
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
      console.warn("[Database] Postgres query failed, falling back to local file/memory:", err);
    }
  }

  // Local fallback mode (guaranteed non-throwing)
  const diskScans = safeReadJson<Record<string, any>>("scans.json", {});
  const existing = inMemoryScans[unitId] || diskScans[unitId];

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

  inMemoryScans[unitId] = record;
  diskScans[unitId] = record;
  safeWriteJson("scans.json", diskScans);

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
      console.warn("[Database] Postgres query failed, falling back to local storage:", err);
    }
  }

  // Fallback (guaranteed non-throwing)
  if (inMemoryScans[unitId]) {
    return {
      unitId,
      scanCount: inMemoryScans[unitId].scanCount,
      firstScanTime: inMemoryScans[unitId].firstScanTime,
      lastScanTime: inMemoryScans[unitId].lastScanTime,
      isFirstScan: false,
    };
  }

  const diskScans = safeReadJson<Record<string, any>>("scans.json", {});
  const existing = diskScans[unitId];
  if (existing) {
    inMemoryScans[unitId] = existing;
    return {
      unitId,
      scanCount: existing.scanCount,
      firstScanTime: existing.firstScanTime,
      lastScanTime: existing.lastScanTime,
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
}

/**
 * Save an incident report permanently in Postgres or local disk/memory
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
      console.warn("[Database] Postgres incident save failed, falling back to disk/memory:", err);
    }
  }

  // Fallback
  inMemoryIncidents.unshift(report);
  const diskList = safeReadJson<DbIncidentReport[]>("incidents.json", []);
  diskList.unshift(report);
  safeWriteJson("incidents.json", diskList);
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
      console.warn("[Database] Postgres incident retrieval failed, falling back to disk/memory:", err);
    }
  }

  // Fallback
  const diskList = safeReadJson<DbIncidentReport[]>("incidents.json", []);
  const combined = [...inMemoryIncidents, ...diskList];
  const seen = new Set<string>();
  const deduped: DbIncidentReport[] = [];
  for (const item of combined) {
    if (!seen.has(item.incidentId)) {
      seen.add(item.incidentId);
      deduped.push(item);
    }
  }
  deduped.sort((a, b) => b.timestamp - a.timestamp);
  return deduped.slice(0, limit);
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
      console.warn("[Database] Postgres upsertUnitRecord failed, falling back to disk/memory:", err);
    }
  }

  // Local fallback
  inMemoryUnits[unit.unitId] = {
    ...unit,
    updatedAt: new Date().toISOString(),
  };
  const diskUnits = safeReadJson<Record<string, DbUnitRecord>>("units.json", {});
  diskUnits[unit.unitId] = inMemoryUnits[unit.unitId];
  safeWriteJson("units.json", diskUnits);
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
      console.warn("[Database] Postgres getUnitById failed, falling back to disk/memory:", err);
    }
  }

  // Fallback
  if (inMemoryUnits[unitId]) return inMemoryUnits[unitId];
  const diskUnits = safeReadJson<Record<string, DbUnitRecord>>("units.json", {});
  if (diskUnits[unitId]) {
    inMemoryUnits[unitId] = diskUnits[unitId];
    return diskUnits[unitId];
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
      console.warn("[Database] Postgres getUnitsPaginated failed, falling back to disk/memory:", err);
    }
  }

  // Fallback
  const diskUnits = safeReadJson<Record<string, DbUnitRecord>>("units.json", {});
  const mergedUnits = { ...diskUnits, ...inMemoryUnits };
  let allUnits = Object.values(mergedUnits).sort(
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
      console.warn("[Database] Postgres saveUnitEvent failed, falling back to disk/memory:", err);
    }
  }

  // Fallback
  inMemoryUnitEvents.push(event);
  const diskEvents = safeReadJson<DbUnitEvent[]>("unit_events.json", []);
  diskEvents.push(event);
  safeWriteJson("unit_events.json", diskEvents);
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
      console.warn("[Database] Postgres getUnitEvents failed, falling back to disk/memory:", err);
    }
  }

  // Fallback
  const diskEvents = safeReadJson<DbUnitEvent[]>("unit_events.json", []);
  const combined = [...inMemoryUnitEvents, ...diskEvents];
  return combined.filter((e) => e.unitId === unitId);
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
      console.warn("[Database] Postgres getLastIndexedBlock failed, falling back to disk/memory:", err);
    }
  }

  // Fallback
  if (inMemoryIndexerState.last_indexed_block) {
    return Number(inMemoryIndexerState.last_indexed_block);
  }
  const diskState = safeReadJson<Record<string, any>>("indexer_state.json", {});
  if (diskState.last_indexed_block) {
    inMemoryIndexerState.last_indexed_block = diskState.last_indexed_block;
    return Number(diskState.last_indexed_block);
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
      console.warn("[Database] Postgres setLastIndexedBlock failed, falling back to disk/memory:", err);
    }
  }

  // Fallback
  inMemoryIndexerState.last_indexed_block = blockNumber;
  const diskState = safeReadJson<Record<string, any>>("indexer_state.json", {});
  diskState.last_indexed_block = blockNumber;
  safeWriteJson("indexer_state.json", diskState);
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
      console.warn("[Database] Postgres getSealRecord failed, falling back to disk/memory:", err);
    }
  }

  // Fallback
  if (inMemorySeals[unitId]) return inMemorySeals[unitId];
  const diskSeals = safeReadJson<Record<string, DbSealRecord>>("seals.json", {});
  if (diskSeals[unitId]) {
    inMemorySeals[unitId] = diskSeals[unitId];
    return diskSeals[unitId];
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
      console.warn("[Database] Postgres upsertSealRecord failed, falling back to disk/memory:", err);
    }
  }

  // Fallback
  inMemorySeals[record.unitId] = record;
  const diskSeals = safeReadJson<Record<string, DbSealRecord>>("seals.json", {});
  diskSeals[record.unitId] = record;
  safeWriteJson("seals.json", diskSeals);
}

const inMemoryClientLocks: Record<string, { failedAttempts: number; lockedUntil?: string | null }> = {};
const inMemoryVendorDailyQuotas: Record<string, number> = {};

export function calculateSealBackoffMs(attempts: number): number {
  if (attempts < 3) return 0;
  if (attempts === 3) return 60 * 1000; // 1 min backoff
  if (attempts === 4) return 5 * 60 * 1000; // 5 min backoff
  return 60 * 60 * 1000; // 1 hour backoff (or 24h for >=5)
}

/**
 * Check if a client or unit is currently locked out (Durable Postgres + In-memory fallback)
 */
export async function getClientSealLock(
  unitId: string,
  clientIdentifier?: string
): Promise<{ locked: boolean; failedAttempts: number; lockedUntil?: string }> {
  if (clientIdentifier) {
    const key = `${unitId}:${clientIdentifier}`;

    if (neonPool) {
      await initDbSchema();
      try {
        const res = await neonPool.query(
          `SELECT failed_attempts, locked_until::TEXT FROM client_seal_locks WHERE lock_key = $1;`,
          [key]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          const lockedUntil = row.locked_until;
          if (lockedUntil && Date.now() < new Date(lockedUntil).getTime()) {
            return { locked: true, failedAttempts: Number(row.failed_attempts), lockedUntil };
          }
          return { locked: false, failedAttempts: Number(row.failed_attempts) };
        }
      } catch (err) {
        console.warn("[Database] Postgres getClientSealLock failed, using memory:", err);
      }
    }

    const rec = inMemoryClientLocks[key];
    if (rec && rec.lockedUntil) {
      const lockExpiry = new Date(rec.lockedUntil).getTime();
      if (Date.now() < lockExpiry) {
        return { locked: true, failedAttempts: rec.failedAttempts, lockedUntil: rec.lockedUntil };
      }
    }
    return { locked: false, failedAttempts: rec?.failedAttempts || 0 };
  }

  const seal = await getSealRecord(unitId);
  if (seal?.state === "LOCKED_REVIEW" && seal?.lockedUntil) {
    const lockExpiry = new Date(seal.lockedUntil).getTime();
    if (Date.now() < lockExpiry) {
      return { locked: true, failedAttempts: seal.failedAttempts, lockedUntil: seal.lockedUntil };
    }
  }
  return { locked: false, failedAttempts: seal?.failedAttempts || 0 };
}

/**
 * Record a failed seal attempt; partitioned on (unitId, clientIdentifier) to prevent public QR DoS
 */
export async function recordFailedSealAttempt(
  unitId: string,
  clientIdentifier?: string
): Promise<{ locked: boolean; failedAttempts: number; lockedUntil?: string }> {
  if (clientIdentifier) {
    const key = `${unitId}:${clientIdentifier}`;

    if (neonPool) {
      await initDbSchema();
      try {
        const cur = await neonPool.query(
          `SELECT failed_attempts FROM client_seal_locks WHERE lock_key = $1;`,
          [key]
        );
        const prevAttempts = cur.rows.length > 0 ? Number(cur.rows[0].failed_attempts) : 0;
        const newAttempts = prevAttempts + 1;
        const backoffMs = calculateSealBackoffMs(newAttempts);
        const locked = backoffMs > 0;
        const lockedUntil = locked ? new Date(Date.now() + backoffMs).toISOString() : null;

        await neonPool.query(
          `INSERT INTO client_seal_locks (lock_key, failed_attempts, locked_until, updated_at)
           VALUES ($1, $2, $3::TIMESTAMP WITH TIME ZONE, NOW())
           ON CONFLICT (lock_key) DO UPDATE SET
             failed_attempts = $2,
             locked_until = $3::TIMESTAMP WITH TIME ZONE,
             updated_at = NOW();`,
          [key, newAttempts, lockedUntil]
        );

        inMemoryClientLocks[key] = { failedAttempts: newAttempts, lockedUntil };
        return { locked, failedAttempts: newAttempts, lockedUntil: lockedUntil || undefined };
      } catch (err) {
        console.warn("[Database] Postgres recordFailedSealAttempt failed, using memory:", err);
      }
    }

    const prev = inMemoryClientLocks[key] || { failedAttempts: 0 };
    const newAttempts = prev.failedAttempts + 1;
    const backoffMs = calculateSealBackoffMs(newAttempts);
    const locked = backoffMs > 0;
    const lockedUntil = locked ? new Date(Date.now() + backoffMs).toISOString() : undefined;

    inMemoryClientLocks[key] = {
      failedAttempts: newAttempts,
      lockedUntil: lockedUntil || null,
    };

    return { locked, failedAttempts: newAttempts, lockedUntil };
  }

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
export async function resetSealLockDb(unitId: string, clientIdentifier?: string): Promise<void> {
  if (neonPool) {
    await initDbSchema();
    try {
      if (clientIdentifier) {
        await neonPool.query(`DELETE FROM client_seal_locks WHERE lock_key = $1;`, [`${unitId}:${clientIdentifier}`]);
      } else {
        await neonPool.query(`DELETE FROM client_seal_locks WHERE lock_key LIKE $1;`, [`${unitId}:%`]);
      }
    } catch (err) {
      console.warn("[Database] Postgres resetSealLockDb failed, using memory:", err);
    }
  }

  if (clientIdentifier) {
    delete inMemoryClientLocks[`${unitId}:${clientIdentifier}`];
  } else {
    for (const key of Object.keys(inMemoryClientLocks)) {
      if (key.startsWith(`${unitId}:`)) {
        delete inMemoryClientLocks[key];
      }
    }
  }

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

/**
 * Checks and increments the daily transaction/gas quota for an authenticated vendor wallet
 * Supported by Neon PostgreSQL table `vendor_daily_quotas` with atomic ON CONFLICT DO UPDATE
 */
export async function checkAndIncrementVendorQuotaDb(
  vendorAddress: string,
  limit = 50
): Promise<{ allowed: boolean; count: number; remaining: number }> {
  const cleanVendor = vendorAddress.toLowerCase();
  const dayKey = `vendor-daily:${cleanVendor}:${new Date().toISOString().slice(0, 10)}`;

  if (neonPool) {
    await initDbSchema();
    try {
      const res = await neonPool.query(
        `INSERT INTO vendor_daily_quotas (quota_key, vendor_address, tx_count, day_date, updated_at)
         VALUES ($1, $2, 1, CURRENT_DATE, NOW())
         ON CONFLICT (quota_key) DO UPDATE SET
           tx_count = vendor_daily_quotas.tx_count + 1,
           updated_at = NOW()
         RETURNING tx_count;`,
        [dayKey, cleanVendor]
      );
      const count = Number(res.rows[0].tx_count);
      return {
        allowed: count <= limit,
        count,
        remaining: Math.max(0, limit - count),
      };
    } catch (err) {
      console.warn("[Database] Postgres checkAndIncrementVendorQuotaDb failed, falling back:", err);
    }
  }

  const count = (inMemoryVendorDailyQuotas[dayKey] || 0) + 1;
  inMemoryVendorDailyQuotas[dayKey] = count;
  return {
    allowed: count <= limit,
    count,
    remaining: Math.max(0, limit - count),
  };
}
