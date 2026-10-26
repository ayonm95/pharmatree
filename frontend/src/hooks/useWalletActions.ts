"use client";

import { useState, useCallback } from "react";
import { ethers } from "ethers";

interface UseWalletActionsProps {
  contract: ethers.Contract | null;
  readonlyContract: ethers.Contract;
  account: string;
  role: { manufacturer: boolean; handler: boolean };
  isAdmin: boolean;
  refreshData: (account: string, contractToUse?: ethers.Contract) => Promise<void>;
  notify: (message: string, tone?: "success" | "error" | "info") => void;
}

export function useWalletActions({
  contract,
  readonlyContract,
  account,
  role,
  isAdmin,
  refreshData,
  notify,
}: UseWalletActionsProps) {
  const [loading, setLoading] = useState(false);

  const createMedicine = useCallback(
    async (name: string, quantity: string) => {
      if (!contract || !account) {
        notify("Connect a wallet before creating a medicine batch.", "error");
        return;
      }
      if (!role.manufacturer && !isAdmin) {
        notify("Only manufacturers or admins can register medicine units.", "error");
        return;
      }
      const qtyNum = Number(quantity.trim());
      if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
        notify("Quantity must be a positive whole number.", "error");
        return;
      }

      try {
        setLoading(true);
        const metadata = `${name.trim()}, ${qtyNum} tablets`;
        const tx = await contract.createRootUnit(0, metadata, qtyNum);
        await tx.wait();
        notify(`Medicine batch registered: ${name} (${qtyNum} units).`, "success");
        await refreshData(account, contract);
      } catch (err: any) {
        console.error("createMedicine error:", err);
        notify("Failed to create medicine batch. Verify network connection and gas.", "error");
      } finally {
        setLoading(false);
      }
    },
    [account, contract, isAdmin, notify, refreshData, role.manufacturer]
  );

  const assignRole = useCallback(
    async (target: string, type: "manufacturer" | "handler") => {
      if (!contract || !account) {
        notify("Connect an authorized wallet before assigning roles.", "error");
        return;
      }
      if (!ethers.isAddress(target)) {
        notify("Enter a valid target wallet address.", "error");
        return;
      }

      // Check permissions: only contract admin has AccessControl DEFAULT_ADMIN_ROLE to grant roles
      if (!isAdmin) {
        notify("Only the System Administrator can authorize new manufacturers or handlers.", "error");
        return;
      }

      const cleanTarget = target.trim();
      const roleLabel = type === "manufacturer" ? "Manufacturer" : "Handler";

      try {
        setLoading(true);

        // Pre-check if target already has roles assigned
        const [targetIsMfr, targetIsHnd] = await Promise.all([
          readonlyContract.isManufacturer(cleanTarget),
          readonlyContract.isHandler(cleanTarget),
        ]);

        if (type === "manufacturer" && targetIsMfr) {
          notify(`Role already assigned: ${cleanTarget} is already an authorized Manufacturer.`, "error");
          setLoading(false);
          return;
        }

        if (type === "handler" && targetIsHnd) {
          notify(`Role already assigned: ${cleanTarget} is already an authorized Handler.`, "error");
          setLoading(false);
          return;
        }

        if (targetIsMfr || targetIsHnd) {
          const currentRole = targetIsMfr && targetIsHnd ? "Manufacturer & Handler" : targetIsMfr ? "Manufacturer" : "Handler";
          notify(`Role already assigned: Address already holds role '${currentRole}'.`, "info");
        }

        const tx =
          type === "manufacturer"
            ? await contract.addManufacturer(cleanTarget)
            : await contract.addHandler(cleanTarget);
        await tx.wait();
        notify(`${roleLabel} role granted to ${cleanTarget}.`, "success");
        await refreshData(account, contract);
      } catch (err: any) {
        console.error("assignRole error:", err);
        const errMessage = err?.reason || err?.message || "";
        if (errMessage.includes("Not admin")) {
          notify("Transaction reverted: Only the contract Administrator can grant roles.", "error");
        } else {
          notify(`Could not grant the ${type} role: ${errMessage.slice(0, 80)}`, "error");
        }
      } finally {
        setLoading(false);
      }
    },
    [account, contract, isAdmin, notify, readonlyContract, refreshData]
  );

  const initiateTransfer = useCallback(
    async (unitId: string, receiver: string, quantity: number) => {
      if (!contract || !account) {
        notify("Connect a wallet before initiating a transfer.", "error");
        return;
      }
      if (!ethers.isAddress(receiver)) {
        notify("Enter a valid receiver wallet address.", "error");
        return;
      }

      try {
        setLoading(true);
        const [isMfr, isHnd] = await Promise.all([
          readonlyContract.isManufacturer(receiver),
          readonlyContract.isHandler(receiver),
        ]);
        if (!isMfr && !isHnd) {
          notify("Transfer blocked: receiver is not an authorized manufacturer or handler.", "error");
          setLoading(false);
          return;
        }

        const tx = await contract.initiatePartialTransfer(Number(unitId), receiver, quantity);
        await tx.wait();
        notify("Custody transfer initiated. Awaiting receiver approval.", "success");
        await refreshData(account, contract);
      } catch (err: any) {
        console.error("initiateTransfer error:", err);
        const reason = err?.message || "Failed to initiate custody transfer.";
        notify(reason.slice(0, 120), "error");
      } finally {
        setLoading(false);
      }
    },
    [account, contract, notify, readonlyContract, refreshData]
  );

  const markAsSold = useCallback(
    async (unitId: string, quantity: number) => {
      if (!contract || !account) {
        notify("Connect a wallet before marking medicine as sold.", "error");
        return;
      }

      try {
        setLoading(true);
        let tx;
        if (typeof contract.sellQuantity === "function") {
          tx = await contract.sellQuantity(Number(unitId), quantity);
        } else {
          tx = await contract.markAsSold(Number(unitId));
        }
        await tx.wait();
        notify("Medicine marked as sold / dispensed.", "success");
        await refreshData(account, contract);
      } catch (err: any) {
        console.error("markAsSold error:", err);
        notify("Failed to record dispensing sale.", "error");
      } finally {
        setLoading(false);
      }
    },
    [account, contract, notify, refreshData]
  );

  const acceptTransfer = useCallback(
    async (unitId: string) => {
      if (!contract || !account) return;
      try {
        setLoading(true);
        const tx = await contract.acceptTransfer(Number(unitId));
        await tx.wait();
        notify("Custody transfer accepted. Medicine added to inventory.", "success");
        await refreshData(account, contract);
      } catch (err: any) {
        console.error("acceptTransfer error:", err);
        notify("Failed to accept custody transfer.", "error");
      } finally {
        setLoading(false);
      }
    },
    [account, contract, notify, refreshData]
  );

  const rejectTransfer = useCallback(
    async (unitId: string) => {
      if (!contract || !account) return;
      try {
        setLoading(true);
        const tx = await contract.rejectTransfer(Number(unitId));
        await tx.wait();
        notify("Custody transfer rejected.", "info");
        await refreshData(account, contract);
      } catch (err: any) {
        console.error("rejectTransfer error:", err);
        notify("Failed to reject custody transfer.", "error");
      } finally {
        setLoading(false);
      }
    },
    [account, contract, notify, refreshData]
  );

  const reclaimUnit = useCallback(
    async (unitId: string) => {
      if (!contract || !account) return;
      try {
        setLoading(true);
        const tx = await contract.reclaimRejectedUnit(Number(unitId));
        await tx.wait();
        notify("Rejected unit reclaimed and restored to Active stock.", "success");
        await refreshData(account, contract);
      } catch (err: any) {
        console.error("reclaimUnit error:", err);
        const reason = err?.reason || err?.message || "";
        if (reason.includes("missing revert data") || reason.includes("CALL_EXCEPTION") || reason.includes("reclaimRejectedUnit")) {
          notify(
            "Contract Notice: The connected contract does not support reclaiming. Rejected units remain permanently archived as Rejected on-chain.",
            "error"
          );
        } else {
          notify("Failed to reclaim rejected unit: " + (err?.shortMessage || err?.message || "Transaction reverted"), "error");
        }
      } finally {
        setLoading(false);
      }
    },
    [account, contract, notify, refreshData]
  );

  return {
    loading,
    createMedicine,
    assignRole,
    initiateTransfer,
    markAsSold,
    acceptTransfer,
    rejectTransfer,
    reclaimUnit,
  };
}
