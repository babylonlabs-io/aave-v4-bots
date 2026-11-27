// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {SelfCallRelayer, EIP712} from "./base/SelfCallRelayer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBTCVaultSwap} from "vault-contracts/applications/aave/interfaces/IBTCVaultSwap.sol";

/// @title ArbitrageRouter
/// @notice Acquires escrowed BTC vaults from a BTCVaultSwap (LLP) with WBTC supplied by `payer`, on behalf
///         of a registered vault keeper.
/// @dev Splits three roles that are usually collapsed into one key:
///
///      - `signer` (inherited from {SelfCallRelayer}) authorizes which acquisitions may happen, and is also
///        the only address that may submit one — see {_checkExecutor}. It is a hot key held by the
///        off-chain arbitrage system, pays the gas for every acquisition, and never holds funds.
///      - `payer` supplies the WBTC. It grants this contract an ERC-20 allowance and is refunded any WBTC
///        left on the contract after each acquisition.
///      - `allowedOnBehalfOf` is the vault keeper whose BTC key receives the redeemed vault.
///
///      See {SelfCallRelayer} for the rest of the trust model, including the absence of a nonce.
///
///      The LLP and vault keeper are fixed at construction, so the signer cannot redirect a purchase to
///      another contract or keeper. The LLP and its governance must still be trusted. Revoke the payer's
///      approval promptly if the signer is compromised.
///
///      Profit is not realized on-chain. The router pays WBTC and the vault is redeemed to a Bitcoin key
///      off-chain, so `minProfit` bounds the estimate the LLP reports at execution time, not settlement.
contract ArbitrageRouter is SelfCallRelayer {
    using SafeERC20 for IERC20;

    /// @notice Emitted after a vault is acquired.
    /// @param vaultSwap The BTCVaultSwap (LLP) the vault was acquired from
    /// @param vaultId The acquired vault
    /// @param onBehalfOf Vault keeper whose BTC key received the redeemed vault
    /// @param amountWbtcToAcquire WBTC paid to the LLP: the Hub debt, capped by the minimum profit threshold
    /// @param amountVault Original BTC amount held in the vault
    event SwapWbtcToVault(
        address indexed vaultSwap,
        bytes32 indexed vaultId,
        address indexed onBehalfOf,
        uint256 amountWbtcToAcquire,
        uint256 amountVault
    );

    /// @notice EIP-712 domain name.
    string public constant NAME = "ArbitrageRouter";

    /// @notice EIP-712 domain version.
    string public constant VERSION = "1.0.0";

    /// @notice Address the WBTC is pulled from. Must keep an ERC-20 allowance on this contract.
    address public immutable payer;

    /// @notice WBTC token used to acquire vaults.
    address public immutable wbtc;

    /// @notice The only LLP the router may approve and call.
    address public immutable allowedVaultSwap;

    /// @notice The only vault keeper on whose behalf the router may acquire vaults.
    address public immutable allowedOnBehalfOf;

    /// @param _signer Address whose signature authorizes relayed batches; must be non-zero
    /// @param _payer Address supplying the WBTC; must be non-zero and must approve this contract
    /// @param _wbtc WBTC token address; must be non-zero and must match the LLP's exitBTC
    /// @param _allowedVaultSwap Trusted LLP address; must be non-zero
    /// @param _allowedOnBehalfOf Trusted vault keeper address; must be non-zero
    constructor(address _signer, address _payer, address _wbtc, address _allowedVaultSwap, address _allowedOnBehalfOf)
        EIP712(NAME, VERSION)
        SelfCallRelayer(_signer)
    {
        require(_payer != address(0), "ArbitrageRouter: invalid payer");
        require(_wbtc != address(0), "ArbitrageRouter: invalid wbtc");
        require(_allowedVaultSwap != address(0), "ArbitrageRouter: invalid vaultSwap");
        require(_allowedOnBehalfOf != address(0), "ArbitrageRouter: invalid onBehalfOf");
        payer = _payer;
        wbtc = _wbtc;
        allowedVaultSwap = _allowedVaultSwap;
        allowedOnBehalfOf = _allowedOnBehalfOf;
    }

    /// @notice Restricts submission of a relayed batch to `signer`.
    /// @dev The batch is visible before it executes (gas estimation and broadcast expose it), so an
    ///      unbound batch could be executed by anyone until its `deadline` and paid from `payer`'s
    ///      allowance. The bot signs and submits with the same key, so this costs nothing.
    function _checkExecutor() internal view override {
        require(msg.sender == signer, "ArbitrageRouter: unauthorized submitter");
    }

    /// @notice Buys one escrowed vault from `vaultSwap` and has it redeemed to `onBehalfOf`'s BTC key.
    /// @dev Reachable only through {SelfCallRelayer-relay}, so every execution is signer-authorized.
    ///
    ///      Flow: preview the vault, check the estimated profit, pull exactly `amountExitBtcToAcquire` from
    ///      `payer`, approve the LLP for that amount, swap, reset the approval to zero, and sweep any WBTC
    ///      left on this contract back to `payer`.
    ///
    ///      `amountExitBtcToAcquire` is read and spent within the same transaction, so the LLP recomputes the
    ///      same cost when it re-previews; passing it as `maxWbtcIn` makes the swap revert rather than
    ///      overspend if that ever stops holding.
    ///
    ///      The sweep returns the contract's whole WBTC balance, so any WBTC sent here by anyone is
    ///      forwarded to `payer` on the next acquisition.
    /// @param vaultSwap BTCVaultSwap (LLP) holding the vault in escrow
    /// @param vaultId Vault to acquire
    /// @param onBehalfOf Registered, non-blocklisted vault keeper whose BTC key receives the vault
    /// @param minProfit Minimum acceptable `amountProfitEst`, in WBTC terms, at execution time
    /// @param maxWbtcIn Maximum WBTC to spend on the swap; must be at least `amountExitBtcToAcquire` from the preview
    function swapWbtcToVault(
        address vaultSwap,
        bytes32 vaultId,
        address onBehalfOf,
        uint256 minProfit,
        uint256 maxWbtcIn
    ) external onlySelf {
        require(vaultSwap == allowedVaultSwap, "ArbitrageRouter: unauthorized vaultSwap");
        require(onBehalfOf == allowedOnBehalfOf, "ArbitrageRouter: unauthorized onBehalfOf");
        IBTCVaultSwap.EscrowedVaultPreviewResult memory preview = _preview(vaultSwap, vaultId);
        require(preview.amountProfitEst >= minProfit, "ArbitrageRouter: insufficient profit");
        require(preview.amountExitBtcToAcquire <= maxWbtcIn, "ArbitrageRouter: exceeds maxWbtcIn");

        IERC20(wbtc).safeTransferFrom(payer, address(this), preview.amountExitBtcToAcquire);
        IERC20(wbtc).forceApprove(vaultSwap, preview.amountExitBtcToAcquire);
        IBTCVaultSwap(vaultSwap).swapExitBtcForVaultOnBehalf(vaultId, preview.amountExitBtcToAcquire, onBehalfOf);
        IERC20(wbtc).forceApprove(vaultSwap, 0);

        uint256 wbtcBalance = IERC20(wbtc).balanceOf(address(this));
        if (wbtcBalance > 0) {
            IERC20(wbtc).safeTransfer(payer, wbtcBalance);
        }

        emit SwapWbtcToVault(vaultSwap, vaultId, onBehalfOf, preview.amountExitBtcToAcquire, preview.amountVault);
    }

    /// @dev Previews a single vault through the LLP's batch preview entrypoint.
    ///      Reverts inside the LLP if the vault is not escrowed or is marked as deficit.
    /// @param vaultSwap BTCVaultSwap (LLP) to query
    /// @param vaultId Vault to preview
    /// @return Current cost, profit estimate, and vault accounting for `vaultId`
    function _preview(address vaultSwap, bytes32 vaultId)
        internal
        view
        returns (IBTCVaultSwap.EscrowedVaultPreviewResult memory)
    {
        bytes32[] memory vaultIds = new bytes32[](1);
        vaultIds[0] = vaultId;
        IBTCVaultSwap.EscrowedVaultPreviewResult[] memory previews =
            IBTCVaultSwap(vaultSwap).previewEscrowedVaults(vaultIds);
        require(previews.length == 1, "ArbitrageRouter: preview length mismatch");
        return previews[0];
    }
}
