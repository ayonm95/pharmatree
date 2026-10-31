# PharmaTree Project Documentation
### Enterprise Technical Specification, Threat Model, Invariant Theorems & API Reference

> [!NOTE]
> **Testnet Prototype & Research Specification (Ethereum Sepolia)**  
> PharmaTree is an end-to-end pharmaceutical provenance platform demonstrating hybrid on-chain custody tracking, EIP-712 gasless meta-transactions, GS1 packaging standards, and tamper-evident physical seal verification.

---

## Table of Contents
1. [System Purpose & Domain Model](#1-system-purpose--domain-model)
2. [Repository & Monorepo Workspace Structure](#2-repository--monorepo-workspace-structure)
3. [System Architecture & Hybrid Trust Boundaries](#3-system-architecture--hybrid-trust-boundaries)
4. [Smart Contract State Machine & Mass Conservation](#4-smart-contract-state-machine--mass-conservation)
5. [Application Workflows & Custody Handshakes](#5-application-workflows--custody-handshakes)
6. [POS Dispensing Lifecycle, Signing & Reconciliation](#6-pos-dispensing-lifecycle-signing--reconciliation)
7. [5-Tier Anti-Counterfeiting Engine](#7-5-tier-anti-counterfeiting-engine)
8. [Dual-Scheme Tamper Seals (Physical 2FA)](#8-dual-scheme-tamper-seals-physical-2fa)
9. [GS1 Digital Link & Barcode Standardization](#9-gs1-digital-link--barcode-standardization)
10. [Multi-Tenant POS Authentication & Gas Throttling](#10-multi-tenant-pos-authentication--gas-throttling)
11. [Smart Contract Function & Event Reference](#11-smart-contract-function--event-reference)
12. [API Endpoint & Status Code Reference](#12-api-endpoint--status-code-reference)
13. [Environment Configuration & Secrets Management](#13-environment-configuration--secrets-management)
14. [Local Development & Deployment Workflows](#14-local-development--deployment-workflows)
15. [Automated Testing & Invariant Validation](#15-automated-testing--invariant-validation)
16. [Comprehensive Threat Model Matrix](#16-comprehensive-threat-model-matrix)
17. [Physical Reality Gap & Known Limitations](#17-physical-reality-gap--known-limitations)
18. [Author & License Notice](#18-author--license-notice)

---

## 1. System Purpose & Domain Model

PharmaTree is a hybrid blockchain-and-edge platform designed to track pharmaceutical provenance from genesis manufacturing through multi-tier distribution to final retail pharmacy dispensing.

The platform models the standard pharmaceutical packaging hierarchy:
$$\text{Container (Level 0)} \longrightarrow \text{Shipment (Level 1)} \longrightarrow \text{Batch (Level 2)} \longrightarrow \text{Box (Level 3)} \longrightarrow \text{Individual Item (Level 4)}$$

Every unit registered on-chain contains:
- `id`: Monotonically increasing sequential integer identifier ($1 \le \text{id} \le 2^{256}-1$).
- `parentId` / `rootId`: Lineage pointers tracking ancestor container or manufacturing batch.
- `level`: Package tier (`Container`, `Shipment`, `Batch`, `Box`, `IndividualItem`).
- `manufacturer`: Ethereum address of the certified genesis manufacturer.
- `currentOwner`: Ethereum address of the entity currently holding verifiable custody.
- `pendingReceiver`: Ethereum address of the designated recipient during an in-transit transfer.
- `status`: Lifecycle state (`Active = 0`, `PendingTransfer = 1`, `Sold = 2`, `Rejected = 3`).
- `quantity`: Exact discrete unit count (tablets, vials, or blister counts).
- `metadata`: Standardized description string with dynamic quantity synchronization.

---

## 2. Repository & Monorepo Workspace Structure

The repository is organized as a clean enterprise monorepo:

| Path | Responsibility |
| :--- | :--- |
| `backend/contracts/PharmaTree.sol` | Core smart contract: RBAC, hierarchy, ownership, two-party transfers, fractional sales, and ERC-2771 context |
| `backend/contracts/PharmaTreeForwarder.sol` | OpenZeppelin ERC2771Forwarder enabling gasless EIP-712 meta-transactions |
| `backend/scripts/` | Sepolia and local Hardhat deployment, role granting, and verification workflows |
| `backend/scripts/e2e-sepolia-validation.ts` | Live Sepolia smoke test validating 8 core invariants against pre-seeded testnet fixtures #1-#10 |
| `backend/test/PharmaTree.test.ts` | Chai/Mocha smart contract unit test suite with Hardhat snapshot fixtures (25 tests) |
| `backend/test/PosInvariants.test.ts` | Operational supply chain invariants, randomized property tests for $\Sigma Q$ conservation, and 5-tier evaluator (15 tests) |
| `backend/test/Gs1AndSeals.test.ts` | GS1 Digital Link standard, GTIN-14 Luhn Mod 10, DataMatrix, and dual-scheme cryptographic seal tests (16 tests) |
| `backend/test/Eip712Forwarder.test.ts` | EIP-712 typed meta-transactions, ERC-2771 forwarder verification, and relayer role decoupling (7 tests) |
| `backend/test/AtomicSellRace.test.ts` | Concurrent checkout race conditions and atomic state reversion (2 tests) |
| `frontend/src/app/` | Next.js 16 App Router pages (`/`, `/create`, `/admin`, `/transfers`, `/inventory`, `/verify`, `/pos`) |
| `frontend/src/app/01/[gtin]/10/[lot]/21/[serial]/` | Standard GS1 Digital Link healthcare resolver route |
| `frontend/src/app/pos/` | High-throughput Vendor POS QR Scanner Terminal with dual camera/HID wedge listeners |
| `frontend/src/app/api/pos/` | POS backend endpoints: `/verify` (5-tier audit), `/sell` (gasless relayer), `/incident` (quarantine telemetry), `/seal/reset` |
| `frontend/src/app/api/units/` | Indexed cursor-paginated projection endpoint with automated on-chain backfill |
| `frontend/src/app/api/health/` | Production diagnostic health check endpoint (RPC latency, block height, contract status, relayer solvency) |
| `frontend/src/app/verify/page.tsx` | Role-adaptive medicine provenance verification, 4-stage visual journey stepper & nuanced scan telemetry |
| `frontend/src/app/error.tsx` | Route-level React 19 error boundary with diagnostics modal and retry action |
| `frontend/src/app/global-error.tsx` | Root layout catastrophic error boundary with standalone recovery HTML |
| `frontend/src/lib/db.ts` | Serverless Postgres (Neon) client managing `tenants`, `tenant_daily_quotas`, `used_reset_nonces`, and `tamper_seals` |
| `frontend/src/lib/rateLimit.ts` | Hybrid rate limiting: Upstash Redis sliding window (when configured) with local in-memory fallback |
| `frontend/src/lib/tenantAuth.ts` | Constant-time SHA-256 API key verification, vendor whitelisting, and per-IP sandbox partitioning |
| `frontend/src/lib/gs1.ts` | GS1 Digital Link builder/parser, GTIN-14 Luhn check digit, and 2D DataMatrix generator |
| `frontend/src/lib/sealVerifier.ts` | Dual-scheme tamper seal engine with client-scoped exponential backoff and versioned HMAC verifiers |
| `frontend/src/lib/indexer.ts` | Event indexer starting from contract deployment block `12032098` |
| `frontend/src/lib/tierEvaluator.ts` | Pure 5-Tier Anti-Counterfeiting evaluation engine decoupled from RPC and database |
| `frontend/src/lib/rpc.ts` | Resilient multi-endpoint FallbackProvider with exponential backoff & rate-limit recovery |
| `frontend/src/lib/pharmaTree.ts` | Frontend ABI, contract addresses, levels, and status mappings |

---

## 3. System Architecture & Hybrid Trust Boundaries

PharmaTree operates as a hybrid Web3/Web2 system:

```mermaid
flowchart TD
    subgraph Clients["Physical Endpoints"]
        Scanner["POS Scanner / Camera Gun"]
        Consumer["Consumer Smartphone"]
        Cashier["Dispensary Cashier Terminal"]
    end

    subgraph Edge["Vercel Edge & Cloud Services"]
        NextApp["Next.js 16 Web Application"]
        RateLimit["Rate Limiter (Upstash Redis / In-Memory Fallback)"]
        Relayer["Sponsored Relayer Service (/api/pos/sell)"]
        IncidentLogger["Incident Telemetry (/api/pos/incident)"]
    end

    subgraph State["Durable Data Layer (Neon PostgreSQL)"]
        Tenants["tenants & tenant_daily_quotas"]
        UsedNonces["used_reset_nonces (Anti-Replay)"]
        Seals["tamper_seals (HMAC Verifiers)"]
        Incidents["pos_incidents (Forensic Logs)"]
    end

    subgraph Blockchain["Ethereum Sepolia Consensus Layer"]
        Forwarder["PharmaTreeForwarder.sol (ERC-2771 / EIP-712)"]
        Contract["PharmaTree.sol (0xbD24...d72)"]
        RBAC["Access Control Matrix"]
        Ledger["Unit Registry & Conservation (ΣQ)"]
    end

    Scanner & Cashier --> NextApp
    Consumer --> NextApp
    NextApp --> RateLimit
    NextApp --> Tenants & UsedNonces & Seals & Incidents
    NextApp --> Relayer
    Relayer -->|execute(fwdRequest)| Forwarder
    Forwarder -->|Forward Call| Contract
    Contract --> RBAC & Ledger
```

### Trust Boundary Specification:
1. **Consensus Layer (Decentralized SSOT)**:
   - Enforces Role-Based Access Control (`DEFAULT_ADMIN_ROLE`, `MANUFACTURER_ROLE`, `HANDLER_ROLE`).
   - Guarantees strict non-repudiation and mass quantity conservation across splits and retail sales.
   - Decoupled hot relayer (`0x335684Cfb813f673fed3f2bb87BF2778D4E96A72`) holds **zero smart contract roles**. A complete compromise of the relayer key cannot forge units, mint tokens, change roles, or sell third-party inventory.
2. **Database & Edge Layer**:
   - Manages durable daily transaction quotas (`tenant_daily_quotas`) to protect the relayer from gas exhaustion.
   - Stores single-use reset nonces (`used_reset_nonces`) to eliminate signature replay during lockout clearance.
   - Stores HMAC-SHA256 verifiers for scratch-off physical tamper seals (Tier 5).
3. **Physical Packaging Layer**:
   - Uses dual-layer packaging authentication: an external GS1 DataMatrix / QR code for supply-chain custody tracking, combined with a physical, scratch-off Crockford Base32 tamper-evident seal (Tier 5) to protect against visual QR photo-cloning.

---

## 4. Smart Contract State Machine & Mass Conservation

### 4.1 On-Chain Status Enum & State Transitions

The smart contract defines four discrete states in `PharmaTree.sol`:
```solidity
enum Status { Active, PendingTransfer, Sold, Rejected }
```

```mermaid
stateDiagram-v2
    [*] --> Active: createRootUnit / createChildUnits
    Active --> PendingTransfer: initiateTransfer / initiatePartialTransfer
    PendingTransfer --> Active: acceptTransfer (Receiver takes custody)
    PendingTransfer --> Rejected: rejectTransfer (Receiver flags damage/breach)
    PendingTransfer --> Active: cancelTransfer (Sender cancels prior to acceptance)
    Rejected --> Active: reclaimRejectedUnit (Sender reclaims after inspection)
    Active --> Sold: markAsSold / sellQuantity (Terminal Sale)
    Sold --> [*]
```

### Transition Invariants:
1. **`initiateTransfer`**: Only callable by `currentOwner`. Requires unit to be in `Status.Active` and receiver to hold an authorized role. Unit transitions to `Status.PendingTransfer`.
2. **`acceptTransfer`**: Only callable by designated `pendingReceiver`. Sets `currentOwner = _msgSender()`, clears `pendingReceiver = address(0)`, and returns unit to `Status.Active`.
3. **`rejectTransfer`**: Only callable by designated `pendingReceiver`. Sets `status = Status.Rejected` and clears `pendingReceiver = address(0)`. Ownership remains with the sender.
4. **`cancelTransfer`**: Only callable by `currentOwner` while unit is `Status.PendingTransfer`. Clears `pendingReceiver` and returns unit to `Status.Active`.
5. **`reclaimRejectedUnit`**: Only callable by `currentOwner` on a `Status.Rejected` unit. Moves unit from `Rejected` back to `Active` after formal inspection.
6. **`markAsSold` / `sellQuantity`**: Only callable by `currentOwner` on an `Active` unit. Sets `Status.Sold`. Terminal state: sold units cannot be transferred or sold again.

### 4.2 Exact Mathematical Mass Conservation Theorem

Across all split operations, transfers, and retail sales, total pharmaceutical volume is strictly conserved:

$$\sum Q_{\text{initial}} = \sum Q_{\text{active}} + \sum Q_{\text{pending}} + \sum Q_{\text{rejected}} + \sum Q_{\text{sold}}$$

When a unit of quantity $Q$ is partially transferred ($q < Q$) or partially sold ($q < Q$):
1. Parent unit quantity becomes $Q' = Q - q$.
2. Newly minted child unit quantity becomes $q$.
3. Total quantity is invariant: $Q' + q = (Q - q) + q = Q$.

This theorem is verified on-chain and tested via randomized property tests running 35 parallel operations in `backend/test/PosInvariants.test.ts`.

---

## 5. Application Workflows & Custody Handshakes

### 5.1 Mutual Acceptance Handshake Protocol
To eliminate unilateral stock dumping or false delivery claims:
1. Sender initiates transfer on-chain via `initiatePartialTransfer(unitId, receiver, quantity)`.
2. The unit enters `Status.PendingTransfer` with `pendingReceiver` recorded.
3. Ownership does not transfer until the receiver calls `acceptTransfer(unitId)`.
4. If damaged in transit, receiver calls `rejectTransfer(unitId)`, recording an immutable audit event (`TransferRejected`).

---

## 6. POS Dispensing Lifecycle, Signing & Reconciliation

### 6.1 Transaction Signing Modes
State-changing dispense operations (`markAsSold` / `sellQuantity`) require cryptographic authorization from the current unit owner:

1. **Gasless Sponsored Mode (EIP-712 Meta-Transactions)**:
   - The cashier's terminal generates an EIP-712 typed data message:
     ```json
     {
       "types": {
         "ForwardRequest": [
           { "name": "from", "type": "address" },
           { "name": "to", "type": "address" },
           { "name": "value", "type": "uint256" },
           { "name": "gas", "type": "uint256" },
           { "name": "nonce", "type": "uint256" },
           { "name": "deadline", "type": "uint48" },
           { "name": "data", "type": "bytes" }
         ]
       }
     }
     ```
   - Signed by the dispensary wallet.
   - Submitted to `/api/pos/sell`.
   - The unprivileged hot relayer verifies the signature against `PharmaTreeForwarder` and submits `forwarder.execute(fwdRequest)`, sponsoring the gas fee.
2. **Direct Browser Wallet Fallback**:
   - If the relayer is offline or depleted (< 0.001 ETH), `/api/pos/sell` returns `requiresClientSigning: true`.
   - The terminal prompts the connected browser wallet (MetaMask) to broadcast the transaction directly.

### 6.2 Mining Latency & Counter Reconciliation
- **Verification Latency**: < 100 ms via parallel multi-endpoint RPC reads.
- **Dispense Broadcast**: Submitted immediately upon cashier confirmation (`Spacebar` / `Enter`).
- **Mining Window**: Ethereum Sepolia blocks mine in ~12 seconds.
- **Optimistic UI with Reconciliation**:
  1. The terminal optimistically detaches inventory locally, rendering a temporary pending receipt.
  2. If the on-chain transaction succeeds, the receipt updates with the confirmed block number and transaction hash.
  3. If the transaction reverts (e.g., gas spike, race condition), the terminal triggers an auditory warning chime, rolls back the local stock state to `Active`, and presents a one-click retry prompt.

---

## 7. 5-Tier Anti-Counterfeiting Engine

Every scanned unit is audited across five sequential verification tiers (`frontend/src/lib/tierEvaluator.ts`):

| Tier | Name | Evaluation Rule | Normal State | Failure State |
| :---: | :--- | :--- | :--- | :--- |
| **1** | **Genesis Registry** | $1 \le \text{unitId} \le \text{unitCounter}$ and $\text{manufacturer} \ne 0\text{x}0$ | Genuine genesis record | `UNREGISTERED_ID`: Forged QR code or fake batch |
| **2** | **Anti-Replay** | $\text{status} \ne \text{Status.Sold}$ | Active unsold inventory | `ALREADY_SOLD_REPLAY`: Photocopied packaging QR |
| **3** | **Custody Audit** | $\text{currentOwner} == \text{vendorAddress}$ or ($\text{status} == \text{Pending} \land \text{pendingReceiver} == \text{vendorAddress}$) | Authorized dispensary custody | `CUSTODY_MISMATCH`: Diverted or stolen inventory |
| **4** | **Transit Integrity** | $\text{status} \ne \text{Status.Rejected}$ | Unbroken transit custody | `REJECTED_TRANSIT`: Compromised or damaged delivery |
| **5** | **Tamper Seal** | Verifies 12-char Crockford Base32 secret against server HMAC verifier | Unopened intact packaging | `INVALID_SECRET` / `LOCKED_REVIEW`: Tampered packaging |

---

## 8. Dual-Scheme Tamper Seals (Physical 2FA)

To defend against exterior packaging photocopies, PharmaTree binds the digital blockchain record to physical tear-tape scratch seals:

### 8.1 Scheme 1: Production 12-Character Crockford Base32 HMAC
- **Alphabet**: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (32 characters, excluding ambiguous glyphs `I, L, O, U`).
- **Entropy**: $32^{12} \approx 1.15 \times 10^{18}$ possibilities.
- **Verifier Generation**:
  $$\text{Verifier} = \text{"v1:"} \parallel \text{HMAC-SHA256}(\text{SEAL\_PEPPER}, \text{unitId} \parallel ":" \parallel \text{normalize}(\text{secret}))$$
- **Verification**: Evaluated in constant time using `crypto.timingSafeEqual`.
- **Client-Scoped Exponential Backoff**: Failed guesses are tracked per `(unitId, clientIpHash)`:
  - 1-2 failures: immediate retry.
  - 3 failures: 30-second backoff.
  - 4 failures: 2-minute backoff.
  - 5 failures: 24-hour lockout (`LOCKED_REVIEW`).
- **Manufacturer Unlock Challenge**: Unlock signatures require binding `(unitId, RESET_SEAL, nonce, timestamp)`. Nonces are atomically tracked and consumed in Neon table `used_reset_nonces`.

### 8.2 Scheme 0: Legacy Testnet Shorthand (Deprecated & Disabled by Default)
- Scheme 0 4-digit PINs (derived from manufacturer address) are deprecated and disabled by default.
- In production and staging, Scheme 0 verification is rejected unless explicitly enabled via `ALLOW_LEGACY_SEALS=true`.
- All production and demo units are provisioned with Scheme 1 high-entropy Crockford Base32 HMAC verifiers.

---

## 9. GS1 Digital Link & Barcode Standardization

Packaging barcodes conform to GS1 Digital Link URI standards:
$$\text{https://pharmatree.io/01/}\{GTIN\}/10/\{Lot\}/21/\{Serial\}?17=\{YYMMDD\}$$

- **Application Identifiers**:
  - `(01)`: GTIN-14 Global Trade Item Number with Modulo 10 Luhn check digit.
  - `(10)`: Batch / Lot identifier.
  - `(21)`: Serial number (128-bit unguessable high-entropy token).
  - `(17)`: Expiration date in `YYMMDD` format.
- **Optical 2D DataMatrix**: Built-in SVG synthesis using `bwip-js` conforming to GS1 healthcare marking regulations.

---

## 10. Multi-Tenant POS Authentication & Gas Throttling

To operate securely as a multi-tenant SaaS while protecting the relayer from gas exhaustion:

### 10.1 Authentication & Tier Quotas
- Dispensaries supply an `X-Tenant-Key` HTTP header.
- The raw key is hashed using SHA-256 and matched against authorized records in Neon table `tenants` or `PHARMA_TENANTS_CONFIG` using constant-time comparison.
- **Tier Quota Matrix**:
  - `sandbox` / `demo-public-sandbox`: 10 tx/day (partitioned per client IP to prevent evaluation starvation).
  - `standard`: 100 tx/day.
  - `enterprise`: 1,000 tx/day.
- **Rate Headers**:
  - `X-Tenant-ID`: Identifies active tenant context.
  - `X-Tenant-Tier`: Returns tenant tier.
  - `X-Tenant-Quota-Remaining`: Returns daily transactions remaining.

---

## 11. Smart Contract Function & Event Reference

### 11.1 Core Functions (`PharmaTree.sol`)

| Function | Visibility | Access / Modifiers | Description |
| :--- | :--- | :--- | :--- |
| `admin()` | `external view` | None | Returns contract administrator address |
| `unitCounter()` | `external view` | None | Returns total number of registered units |
| `addManufacturer(address _mfr)` | `external` | `onlyAdmin` | Grants `MANUFACTURER_ROLE` |
| `addHandler(address _handler)` | `external` | `onlyAdmin` | Grants `HANDLER_ROLE` |
| `addDispenser(address _dispenser)` | `external` | `onlyAdmin` | Grants `DISPENSER_ROLE` to hospital/pharmacy dispensaries |
| `addQA(address _qa)` | `external` | `onlyAdmin` | Grants `QA_ROLE` for quarantine clearance |
| `removeManufacturer(address _mfr)` | `external` | `onlyAdmin` | Revokes `MANUFACTURER_ROLE` immediately |
| `removeHandler(address _handler)` | `external` | `onlyAdmin` | Revokes `HANDLER_ROLE` immediately |
| `removeDispenser(address _dispenser)` | `external` | `onlyAdmin` | Revokes `DISPENSER_ROLE` immediately |
| `removeQA(address _qa)` | `external` | `onlyAdmin` | Revokes `QA_ROLE` immediately |
| `createRootUnit(...)` | `external` | `onlyManufacturer` | Mints new top-level container/batch unit |
| `createRootUnitWithSerial(...)` | `external` | `onlyManufacturer` | Mints root unit with immutable `serialHash = keccak256(serial)` and expiry |
| `createChildUnits(...)` | `external` | `onlyCurrentOwner` | Mints packed child units under active parent |
| `createChildUnitsWithSerial(...)` | `external` | `onlyCurrentOwner` | Mints child units with registered `serialHash` |
| `initiateTransfer(...)` | `external` | `onlyCurrentOwner` | Transfers unit to authorized handler |
| `acceptTransfer(uint256 _id)` | `external` | `pendingReceiver` | Accepts incoming transfer into active custody |
| `rejectTransfer(uint256 _id)` | `external` | `pendingReceiver` | Rejects incoming shipment; sets `Status.Rejected` |
| `cancelTransfer(uint256 _id)` | `external` | `onlyCurrentOwner` | Cancels pending transfer prior to receiver action |
| `clearRejected(uint256 _id, bytes32 _evidenceHash)` | `external` | `onlyQA` | Verifiable QA audit clearance restoring unit to active status |
| `recallRoot(uint256 _rootId)` | `external` | `Manufacturer / QA` | Freezes entire batch/root hierarchy from retail sale |
| `unrecallRoot(uint256 _rootId)` | `external` | `Manufacturer / QA` | Lifts batch recall freeze |
| `markAsSold(uint256 _id)` | `external` | `onlyOwner onlyDispenser dispensable` | Marks active unit as sold (blocks expired/recalled units) |
| `sellQuantity(uint256 _id, uint256 _qty)` | `external` | `onlyOwner onlyDispenser dispensable` | Splits stock and marks child unit as sold |
| `verifySerial(uint256 _id, string _serial)` | `external view` | None | Validates unguessable serial against stored `serialHash` |
| `getUnitDetails(uint256 _id)` | `external view` | None | Returns full unit tuple (parent, root, owner, status, quantity, serialHash, expiry) |

### 11.2 Emitted Events

| Event | Indexed Parameters | Payload |
| :--- | :--- | :--- |
| `UnitCreated` | `uint256 indexed id`, `uint256 indexed parentId`, `address indexed owner` | `uint8 level` |
| `TransferInitiated` | `uint256 indexed id`, `address indexed from`, `address indexed to` | None |
| `TransferCompleted` | `uint256 indexed id`, `address indexed from`, `address indexed to` | None |
| `TransferRejected` | `uint256 indexed id`, `address indexed from`, `address indexed rejectedBy` | None |
| `TransferCancelled` | `uint256 indexed id`, `address indexed cancelledBy` | None |
| `RejectedCleared` | `uint256 indexed id`, `address indexed clearedBy` | `bytes32 evidenceHash` |
| `UnitSold` | `uint256 indexed id`, `address indexed soldBy` | None |
| `RootRecalled` | `uint256 indexed rootId`, `address indexed recalledBy` | None |
| `RootUnrecalled` | `uint256 indexed rootId`, `address indexed unrecalledBy` | None |
| `UnitSold` | `uint256 indexed id`, `address indexed soldBy` | None |

---

## 12. API Endpoint & Status Code Reference

| Endpoint | Method | Purpose | Authentication | Standard Status Codes |
| :--- | :---: | :--- | :--- | :--- |
| `/api/health` | `GET` | Infrastructure & relayer solvency monitoring | Public | `200 OK`, `503 Service Unavailable` |
| `/api/pos/verify` | `POST` | 5-Tier anti-counterfeit audit | Optional `X-Tenant-Key` | `200 OK`, `400 Bad Request`, `429 Rate Limited`, `502 RPC Failover` |
| `/api/pos/sell` | `POST` | Gasless relayer dispensing execution | Required `X-Tenant-Key` or Demo | `200 OK`, `400 Invalid Sig`, `403 Custody Mismatch`, `429 Quota Exceeded`, `503 Relayer Depleted` |
| `/api/pos/incident` | `POST` | Forensic telemetry logging | Required `X-Tenant-Key` or Demo | `200 OK`, `401 Unauthorized`, `429 Rate Limited` |
| `/api/pos/seal/reset`| `POST`| Administrative seal lockout reset | Manufacturer EIP-712 Signature | `200 OK`, `400 Invalid Nonce`, `403 Unauthorized`, `409 Replayed Signature` |
| `/api/scan` | `POST` | Consumer verification telemetry | Rate-Limited Public | `200 OK`, `400 Bad Request`, `429 Rate Limited` |
| `/api/units` | `GET` | Cursor-paginated indexed unit projections | Public | `200 OK`, `500 Server Error` |

### Standard API Error Codes:
- `RATE_LIMITED`: Sliding-window query threshold exceeded.
- `UNAUTHORIZED_TENANT`: Invalid or absent `X-Tenant-Key`.
- `UNAUTHORIZED_TENANT_VENDOR`: Scanned vendor address does not belong to authorized tenant whitelist.
- `VENDOR_DAILY_QUOTA_EXCEEDED`: Daily 50 tx gasless allowance exhausted for specific vendor.
- `DEMO_QUOTA_EXCEEDED`: Per-IP 10 tx/day public demonstration allowance exhausted.
- `RELAYER_INSUFFICIENT_GAS`: Relayer balance dropped below circuit-breaker safety threshold (< 0.001 ETH).
- `REPLAYED_SIGNATURE`: Cryptographic challenge nonce already consumed in database.
- `LOCKED_REVIEW`: Tamper seal locked after 5 consecutive failed verification attempts.

---

## 13. Environment Configuration & Secrets Management

Committed example templates:
- Root / Backend: `.env.example`
- Frontend: `frontend/.env.example`

### Core Environment Variables:
```env
# Consensus & Smart Contracts (Sepolia)
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
SEPOLIA_CHAIN_ID=11155111
SEPOLIA_CONTRACT_ADDRESS=0xbD245c7f7C8bF4A8Ec016e8C370D3e6931BeAd72
TRUSTED_FORWARDER=0x2d24b5b481d0981AE7904790e9d8BF4c162b6c8c
NEXT_PUBLIC_DEPLOYMENT_BLOCK=12032098

# Gasless Relayer Hot Key (Unprivileged: 0 roles on PharmaTree)
RELAYER_PRIVATE_KEY=your_unprivileged_relayer_private_key

# Neon PostgreSQL Database
DATABASE_URL=postgresql://user:password@endpoint.neon.tech/neondb?sslmode=require

# Cryptographic Pepper for Tamper Seal HMAC
SEAL_PEPPER=your-high-entropy-server-seal-pepper-secret

# Distributed Rate Limiting (Upstash Redis)
UPSTASH_REDIS_REST_URL=https://your-upstash-redis-endpoint.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_rest_token

# IPFS Pinata Storage (Server-side only)
PINATA_API_KEY=your_pinata_api_key
PINATA_SECRET_API_KEY=your_pinata_secret_api_key
```

---

## 14. Local Development & Deployment Workflows

### Prerequisites
- **Node.js**: `>= 20.9.0 (LTS)` (Required by Next.js 16)
- **MetaMask**: Configured for Sepolia testnet

```bash
# Install all dependencies
cd backend && npm install && cd ../frontend && npm install && cd ..

# Compile smart contracts
npm run compile

# Run local Hardhat node
cd backend && npx hardhat node

# Deploy locally
cd backend && npx hardhat run scripts/deploy.ts --network localhost

# Start frontend dev server
npm run dev
```

---

## 15. Automated Testing & Invariant Validation

The monorepo features **107 passing automated tests** across 10 test suites (65 Hardhat contract & invariant tests + 42 Vitest frontend API security & evaluator tests):

```bash
# Run all smart contract, invariant, and GS1 tests (65 tests)
npm test

# Run frontend API security, tenant auth, and evaluator tests (42 tests)
npm run test:frontend

# Run full test suite across both packages
npm run test:all

# Run linter and type-checking
npm run lint

# Run production Next.js Turbopack build
npm run build
```

### Statement Coverage:
```text
--------------------------|----------|----------|----------|----------|----------------|
File                      |  % Stmts | % Branch |  % Funcs |  % Lines |Uncovered Lines |
--------------------------|----------|----------|----------|----------|----------------|
 contracts/               |    93.59 |    72.37 |    82.14 |    93.58 |                |
  PharmaTree.sol          |    93.59 |    72.37 |    81.48 |    93.58 |... 271,285,305 |
  PharmaTreeForwarder.sol |      100 |      100 |      100 |      100 |                |
--------------------------|----------|----------|----------|----------|----------------|
```

---

## 16. Comprehensive Threat Model Matrix

| Threat Vector | Severity | Attack Scenario | Implemented Defense Mechanism |
| :--- | :---: | :--- | :--- |
| **Hot Relayer Compromise** | Critical | Attacker extracts `RELAYER_PRIVATE_KEY` | **Zero Roles**: Relayer holds 0 contract roles. Cannot mint, alter roles, or sell third-party stock without signed EIP-712 forward requests. |
| **Double-Dispensing Replay** | High | Photocopied QR sticker on counterfeit carton | **On-Chain Lifecycle & Tier 5**: Status locks to `Status.Sold`. Subsequent dispense attempts revert. Scratched tamper seal exposes reuse. |
| **Custody Diversion & Theft** | High | Diverted inventory sold outside authorized channel | **Mutual Handshake (Tier 3)**: POS validates `unit.currentOwner == vendorAddress`. Incoming pending shipments display as in-transit. |
| **Sequential ID Scanning** | Medium | Attacker guesses unsold IDs (1..N) to print fake stickers | **GS1 Unguessable Serials & Tier 5**: Digital Link encodes 128-bit random serial AI(21). Physical packaging requires intact scratch seal. |
| **Phishing / Lookalike Domains**| Medium | Counterfeiter prints QR pointing to fake verify domain | **Direct POS App Ingestion & DNSSEC**: POS scanners bypass QR hostnames to query pre-configured APIs. Web portal secured via DNSSEC and TLS. |
| **Gasless Relayer DoS** | Medium | Malicious client exhausts relayer native gas | **Tiered Daily Quotas**: Strict per-tenant and per-IP sub-limits, Upstash sliding-window rate limit, and 0.001 ETH balance circuit breaker. |
| **Lockout Reset Signature Replay** | Low | Replay of manufacturer unlock signature in 10m window | **Atomic Single-Use Nonces**: Challenges bind `(unitId, RESET_SEAL, nonce, timestamp)`. Nonces consumed in `used_reset_nonces`. |
| **Physical Pill Substitution** | Inherent | Counterfeiter opens authentic box, swaps pills, reseals | **Scratch-Off Tamper Seals**: Concealed 12-char Crockford secret destroyed upon initial unboxing; cannot be reconstructed once scratched. |

---

## 17. Physical Reality Gap & Known Limitations

1. **"Garbage In, Garbage Out"**: The blockchain ledger guarantees that once data is recorded, it cannot be altered. It cannot independently perform chemical spectrometry on physical pills; initial data fidelity relies on certified manufacturer credentials and Good Manufacturing Practice (GMP) compliance audits.
2. **Testnet Finality**: Deployed on Ethereum Sepolia testnet. Transaction confirmations require ~12 seconds.
3. **Public Ledger Data Exposure**: On-chain transfer events are publicly inspectable on Sepolia. Enterprise deployments should employ zero-knowledge proofs (e.g. zk-SNARKs) to conceal transaction volumes from commercial competitors.

---

## 18. Author & License Notice

Copyright (c) 2026 Ayon Moitra. All Rights Reserved.

This software, its smart contracts, backend services, and documentation are proprietary commercial property. See [LICENSE](LICENSE) for full licensing terms.
