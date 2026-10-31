# Security Policy — PharmaTree

## 1. Overview & Trust Assumptions

PharmaTree is an enterprise-grade pharmaceutical supply-chain tracking and anti-counterfeiting platform deployed on the **Ethereum Sepolia testnet**. The architecture implements a hybrid trust model:

```
[ Decentralized Trust Layer: Ethereum Sepolia ]
   ├── PharmaTree.sol: State machine, immutable custody, quantity conservation (ΣQ)
   └── PharmaTreeForwarder.sol: ERC-2771 trusted forwarder for EIP-712 meta-transactions

[ High-Performance Edge Layer: Vercel & Neon PostgreSQL ]
   ├── Relayer Service: Gasless transaction sponsorship with zero smart contract roles
   ├── Neon Database: Durable tenant API key hashes, used reset nonces, and seal verifiers
   ├── Upstash Redis: Distributed sliding-window rate limiting
   └── 5-Tier Verification Engine: Pure mathematical evaluation of on-chain state
```

### Trust Boundary Division:
1. **Ethereum Consensus Layer (SSOT)**:
   - Enforces role-based access control (Admin, Certified Manufacturer, Handler/Pharmacy).
   - Guarantees strict non-repudiation and mass quantity conservation across splits and retail sales.
   - Decoupled hot relayer (`0x335684Cfb813f673fed3f2bb87BF2778D4E96A72`) holds **zero smart contract roles**. A complete compromise of the relayer key cannot forge units, mint tokens, change roles, or sell third-party inventory.
2. **Database & Edge Layer**:
   - Stores durable tenant daily quotas (`tenant_daily_quotas`) to protect the relayer from gas-exhaustion denial of service.
   - Records single-use cryptographic reset nonces (`used_reset_nonces`) to prevent replay attacks during seal lockout clearance.
   - Stores HMAC-SHA256 verifiers for scratch-off physical tamper seals (Tier 5).
3. **Physical & Client Boundary**:
   - The platform uses dual-layer packaging authentication: an external GS1 DataMatrix / QR code for supply-chain custody tracking, combined with a physical, scratch-off Crockford Base32 tamper-evident seal (Tier 5) to protect against visual QR photo-cloning.

---

## 2. Threat Model Matrix & Defense Architecture

| Threat Vector | Severity | Attack Mechanism | Implemented Defense Mechanism |
| :--- | :---: | :--- | :--- |
| **Hot Relayer Compromise** | Critical | Attacker extracts server `RELAYER_PRIVATE_KEY`. | **Role Decoupling**: Relayer address holds 0 contract roles. Can only submit EIP-712 meta-transactions bearing valid cryptographic signatures from authorized unit owners. |
| **Double-Dispensing / Replay** | High | Counterfeiter photocopies a legitimate packaging QR. | **On-Chain Lifecycle & Tier 5 Seal**: Once sold, unit enters terminal `Status.Sold`. Attempting to dispense again triggers on-chain transaction revert. Repeat consumer scans prompt tamper-seal verification. |
| **Custody Diversion / Theft** | High | Stolen or competitor inventory scanned at checkout. | **Handshake Verification (Tier 3)**: POS scanner validates `unit.currentOwner == vendorAddress`. Incoming shipments (`Status.PendingTransfer`) are recognized only when `unit.pendingReceiver == vendorAddress`. |
| **Sequential ID Scanning** | Medium | Attacker scans monotonic `unitId` (1..N) to find unsold units. | **GS1 Unguessable Serials & Tier 5**: Packaging incorporates GS1 Digital Link standard with 128-bit unguessable serials AI(21) and physical scratch-off HMAC secrets. |
| **Phishing / Lookalike Domains** | Medium | Counterfeiter prints QR pointing to fake verification domain. | **Direct POS App Ingestion & DNSSEC**: Production POS terminals query pre-configured API endpoints directly, ignoring QR hostnames. Public portal protected by TLS, DNSSEC, and domain pinning. |
| **Relayer Gas Starvation (DoS)** | Medium | Malicious visitor spams state-changing dispense API. | **Multi-Tenant Daily Quotas & Rate Limits**: Tiered quotas (Demo: 10 tx/day partitioned per-IP; Enterprise: 1,000 tx/day), Upstash sliding-window rate limit, and 0.001 ETH balance circuit-breaker. |
| **Seal Lockout Replay** | Low | Replay of manufacturer unlock signature within expiry window. | **Atomic Nonce Invalidation**: Unlock challenge binds `(unitId, RESET_SEAL, nonce, timestamp)` and records single-use nonces in Neon table `used_reset_nonces`. |
| **Physical Pill Substitution** | Inherent | Malicious actor opens genuine box, substitutes chalk, reseals. | **Scratch-Off Tamper Seals**: High-entropy 12-char Crockford Base32 secret destroyed on unboxing; cannot be recovered once scratched. |

---

## 3. Known Limitations & Prototype Scope

1. **Testnet Deployment**: The contracts are deployed on Ethereum Sepolia testnet. Transaction finality depends on testnet block times (~12 seconds).
2. **Garbage In, Garbage Out**: The blockchain immutably records what certified manufacturers submit. It cannot physically or chemically verify tablet composition; initial data fidelity relies on certified enterprise identity and regulatory GMP oversight.
3. **Relayer Private Key Storage**: In the current testnet environment, the relayer key is loaded from environment variables (`RELAYER_PRIVATE_KEY`). For production mainnet deployment, this should migrate to a Hardware Security Module (HSM) or cloud KMS (e.g., AWS KMS, HashiCorp Vault) with hardware enclave signing.

---

## 4. Reporting a Vulnerability

If you discover a security vulnerability or design gap in PharmaTree:

1. **Do Not File a Public GitHub Issue**.
2. **Email the Security Contact**: Send details, proof-of-concept steps, and affected contract or route references to:
   - Email: **security@pharmatree.internal** (or contact repository maintainers privately via GitHub Security Advisories).
3. **Response Timeline**:
   - Initial acknowledgement: within 24 hours.
   - Assessment and mitigation plan: within 72 hours.
   - Fix deployment: dependent on severity (critical issues within 24 hours).
