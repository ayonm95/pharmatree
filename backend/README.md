# PharmaTree Smart Contracts & Backend

The smart contract foundation of the **PharmaTree** decentralized pharmaceutical tracking network. Built with **Solidity ^0.8.20** (compiled with **v0.8.28**), **Hardhat**, and **Ethers.js v6**.

---

## 📍 Live Deployment (Ethereum Sepolia)

| Parameter | Value |
| :--- | :--- |
| **Network** | Ethereum Sepolia Testnet |
| **Chain ID** | `11155111` |
| **Contract Address** | [`0xa51Fe74519fFdd2f167e74780Be7AAD155eEF345`](https://sepolia.etherscan.io/address/0xa51Fe74519fFdd2f167e74780Be7AAD155eEF345#code) (Verified) |
| **Trusted Forwarder** | [`0x2d24b5b481d0981AE7904790e9d8BF4c162b6c8c`](https://sepolia.etherscan.io/address/0x2d24b5b481d0981AE7904790e9d8BF4c162b6c8c#code) (Verified) |
| **Deployment Block** | `12033849` |
| **Compiler Version** | `v0.8.28` (Cancun EVM) |

---

## 🏛️ Smart Contract Architecture (`contracts/PharmaTree.sol`)

- **Role-Based Access Control (RBAC)**:
  - `Admin`: Assigns and revokes `Manufacturer`, `Handler`, `Dispenser`, and `QA` authorizations. Revocation immediately freezes all custody and dispensing privileges.
  - `Manufacturer`: Authorized to create root pharmaceutical units with cryptographic serial hashes (`createRootUnit`).
  - `Handler`: Authorized logistics and healthcare entities (Distributors, Wholesalers, Pharmacies) allowed to participate in custody handshakes.
  - `Dispenser`: Authorized pharmacies/hospitals permitted to execute retail dispensing (`markAsSold`, `sellQuantityWithSerialHash`).
  - `QA`: Authorized quality assurance auditors permitted to recall batches (`recallRoot`, `unrecallRoot`), clear rejected quarantine stock with cryptographic evidence (`clearRejected`), and reassign orphaned inventory (`reassignCustody`).
- **Hierarchical Packaging Lineage**:
  `Container (0) ➔ Shipment (1) ➔ Batch (2) ➔ Box (3) ➔ IndividualItem (4)`
- **Calldata-Hardened Serial Privacy & Deduplication**:
  - Serials are never sent in calldata plaintext; clients pass `bytes32 _serialHash = keccak256(serial)` computed off-chain.
  - On-chain `usedSerialHash` mapping guarantees every root, batch child, and split retail sale has a globally unique serial hash.
- **Two-Party Handshake & Custody Transfer**:
  - `initiateTransfer(unitId, receiver)`: Transfers full unit quantity to pending state.
  - `initiatePartialTransfer(unitId, receiver, quantity)`: Splits available quantity, preserving sender remainder and minting a child unit with inherited parent/root lineage.
  - `acceptTransfer(unitId)`: Authorized recipient accepts custody, transitioning state to `Active`.
  - `rejectTransfer(unitId)`: Authorized recipient rejects inbound shipment, transitioning state to `Rejected`.
  - `clearRejected(unitId, evidenceHash)`: Authorized QA auditor (`QA_ROLE`) clears quarantine back to `Active` after formal inspection with cryptographic audit evidence.
  - `reassignCustody(unitId, newCustodian, reasonHash)`: Narrowed Admin/QA path to recover orphaned stock when current owner's role is revoked.
- **Dispensing & Sale Detachment**:
  - `sellQuantityWithSerialHash(unitId, quantity, childSerialHash)`: Splits stock and marks partial dispensing on-chain (`DISPENSER_ROLE` and `dispensable` required).
  - `markAsSold(unitId)`: Finalizes complete unit sale, permanently locking it against subsequent transfers (`DISPENSER_ROLE` and `dispensable` required).

---

## 🧪 Testing Suite (80 Automated Tests)

Run the Chai/Hardhat test suite:

```bash
npm test
```

All 80 comprehensive test scenarios validate:
1. **Admin & Role Authorization**: Role assignment, admin initialization, role revocation, and strict segregation of `HANDLER_ROLE`, `DISPENSER_ROLE`, and `QA_ROLE`.
2. **Hierarchical Creation**: Root unit creation with off-chain `serialHash` and future `expiry`, parent/root lineage tracking, batch packing limits ($\le 100$), hierarchy level enforcement, zero-hash rejection, past-expiry rejection, and serial hash collision prevention.
3. **Partial Transfers**: Sender remainder retention, child unit detachment, and mass conservation ($\sum Q$).
4. **Two-Party Handshake & Quarantine**: Mutual acceptance, unauthorized recipient prevention, wrong-caller reverts, transfer cancellation, transit rejection, and role-gated QA audit clearance (`clearRejected`).
5. **Dispensing, Expiry & Recalls**: Retail dispensing validation, expiration blocking (`expiry`), batch-wide recall freezing (`recalledRoots`), and transfer prevention on sold stock.
6. **EIP-712 Meta-Transactions & Relayer Decoupling**: Gasless forwarder execution with an unprivileged relayer holding zero contract roles.
7. **Randomized Property Tests**: 35 randomized supply-chain operations verifying strict inventory mass conservation under concurrency.

---

## 🚀 Deployment & Scripts

```bash
# Compile contracts
npx hardhat compile

# Run tests (80 tests)
npm test

# Deploy to Sepolia testnet and sync environment files
npx hardhat run scripts/deploy-and-sync-env.ts --network sepolia

# Run E2E Sepolia invariant verification suite (10/10 live checks)
npx hardhat run scripts/e2e-sepolia-validation.ts --network sepolia
```

