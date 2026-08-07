// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {SelfCallRelayer, EIP712} from "./base/SelfCallRelayer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title IOldBTCVaultSwap
/// @notice Minimal ABI of the legacy BTCVaultSwap deployment, declared here because `IBTCVaultSwap` in
///         lib/tbv-contracts has since diverged from what is deployed.
/// @dev The legacy preview struct carries no `amountWbtcEquivalent` or `amountProfitEst` member, which is
///      why {ArbitrageRouterOldVaultSwap} estimates profit differently from {ArbitrageRouter}. Member
///      order must match the deployed contract exactly — the result is decoded positionally.
interface IOldBTCVaultSwap {
    /// @notice Info about an escrowed vault
    struct EscrowedVaultPreviewResult {
        bytes32 vaultId;
        uint256 amountVault; // Original BTC amount in vault
        uint256 amountDebt; // Current debt to Hub (drawn amount + interest)
        uint256 amountInterest; // Current accrued interest above the original Hub draw
        uint256 amountFee;
        // deduced values
        uint256 amountWbtcToAcquire; // amountDebt + amountFee
        bool isProfitable; // amountWbtcEquivalent > amountDebt
    }

    /// @notice Previews the current cost of acquiring each escrowed vault.
    /// @param vaultIds Vaults to preview
    /// @return Preview results, one per requested vault, in the same order
    function previewEscrowedVaults(bytes32[] calldata vaultIds)
        external
        view
        returns (EscrowedVaultPreviewResult[] memory);

    /// @notice Buys an escrowed vault, redeeming it to a vault keeper's BTC key.
    /// @param vaultId Vault to acquire
    /// @param amountWbtc Maximum WBTC the caller is willing to spend
    /// @param onBehalfOf Vault keeper receiving the redeemed vault
    function swapWbtcForVaultOnBehalf(bytes32 vaultId, uint256 amountWbtc, address onBehalfOf) external;

    /// @notice Whether a vault is currently held in escrow and therefore acquirable.
    /// @param vaultId Vault to check
    /// @return True if the vault is escrowed
    function isVaultEscrowed(bytes32 vaultId) external view returns (bool);
}

/// @title ArbitrageRouterOldVaultSwap
/// @notice {ArbitrageRouter} retargeted at the legacy BTCVaultSwap ABI, for arbitraging vaults escrowed by
///         LLP deployments that predate the current `IBTCVaultSwap` interface.
/// @dev Identical in structure and trust model to {ArbitrageRouter} — same `signer` / `payer` /
///      `onBehalfOf` role split, same caller-supplied `vaultSwap`, same reliance on {SelfCallRelayer} for
///      authorization. Read that contract's documentation first; only the differences are noted here.
///
///      The one behavioral difference is the profit check. The legacy preview reports no oracle-converted
///      WBTC equivalent, so profit is estimated as `amountVault - amountWbtcToAcquire`. `amountVault` is
///      denominated in vault BTC and `amountWbtcToAcquire` in WBTC; both use 8 decimals, but the estimate
///      ignores the vaultBTC/WBTC price ratio and so overstates profit whenever vaultBTC trades below
///      WBTC. It also reverts with an arithmetic panic, rather than the `insufficent profit` message, when
///      a vault costs more than it holds. `minProfit` is therefore a loose bound here; {ArbitrageRouter}
///      against the current LLP uses that contract's own `amountProfitEst` instead.
///
///      This contract exists only to serve already-deployed legacy LLPs and should be retired with them.
contract ArbitrageRouterOldVaultSwap is SelfCallRelayer {
    using SafeERC20 for IERC20;

    /// @notice Emitted after a vault is acquired.
    /// @param vaultSwap The legacy BTCVaultSwap (LLP) the vault was acquired from
    /// @param vaultId The acquired vault
    /// @param onBehalfOf Vault keeper whose BTC key received the redeemed vault
    /// @param amountWbtcToAcquire WBTC paid to the LLP (Hub debt + protocol fee)
    /// @param amountVault Original BTC amount held in the vault
    event SwapWbtcToVault(
        address indexed vaultSwap,
        bytes32 indexed vaultId,
        address indexed onBehalfOf,
        uint256 amountWbtcToAcquire,
        uint256 amountVault
    );

    /// @notice EIP-712 domain name. Shared with {ArbitrageRouter}; the domain separator still differs
    ///         because it binds `verifyingContract`, so signatures cannot cross between deployments.
    string public constant NAME = "ArbitrageRouter";

    /// @notice EIP-712 domain version.
    string public constant VERSION = "1.0.0";

    /// @notice Address the WBTC is pulled from. Must keep an ERC-20 allowance on this contract.
    address public immutable payer;

    /// @notice WBTC token used to acquire vaults.
    address public immutable wbtc;

    /// @param _signer Address whose signature authorizes relayed batches; must be non-zero
    /// @param _payer Address supplying the WBTC; must be non-zero and must approve this contract
    /// @param _wbtc WBTC token address; must be non-zero and must match the LLP's WBTC
    constructor(address _signer, address _payer, address _wbtc) EIP712(NAME, VERSION) SelfCallRelayer(_signer) {
        require(_payer != address(0), "ArbitrageRouter: invalid payer");
        require(_wbtc != address(0), "ArbitrageRouter: invalid wbtc");
        payer = _payer;
        wbtc = _wbtc;
    }

    /// @notice Buys one escrowed vault from a legacy `vaultSwap` and has it redeemed to `onBehalfOf`'s
    ///         BTC key.
    /// @dev Reachable only through {SelfCallRelayer-relay}, so every execution is signer-authorized.
    ///      Flow matches {ArbitrageRouter-swapWbtcToVault}: preview, check profit, pull exactly
    ///      `amountWbtcToAcquire` from `payer`, approve the LLP for that amount, swap, reset the approval
    ///      to zero, then sweep the contract's WBTC balance back to `payer`.
    /// @param vaultSwap Legacy BTCVaultSwap (LLP) holding the vault in escrow
    /// @param vaultId Vault to acquire
    /// @param onBehalfOf Registered, non-blocklisted vault keeper whose BTC key receives the vault
    /// @param minProfit Minimum acceptable `amountVault - amountWbtcToAcquire`; see the contract-level
    ///        note on why this estimate is approximate
    /// @param maxWbtcIn Maximum WBTC to spend on the swap; must be at least `amountWbtcToAcquire` from the preview
    function swapWbtcToVault(
        address vaultSwap,
        bytes32 vaultId,
        address onBehalfOf,
        uint256 minProfit,
        uint256 maxWbtcIn
    ) external onlySelf {
        IOldBTCVaultSwap.EscrowedVaultPreviewResult memory preview = _preview(vaultSwap, vaultId);
        require(preview.amountVault - preview.amountWbtcToAcquire >= minProfit, "ArbitrageRouter: insufficient profit");
        require(preview.amountWbtcToAcquire <= maxWbtcIn, "ArbitrageRouter: exceeds maxWbtcIn");

        IERC20(wbtc).safeTransferFrom(payer, address(this), preview.amountWbtcToAcquire);
        IERC20(wbtc).forceApprove(vaultSwap, preview.amountWbtcToAcquire);
        IOldBTCVaultSwap(vaultSwap).swapWbtcForVaultOnBehalf(vaultId, preview.amountWbtcToAcquire, onBehalfOf);
        IERC20(wbtc).forceApprove(vaultSwap, 0);

        uint256 wbtcBalance = IERC20(wbtc).balanceOf(address(this));
        if (wbtcBalance > 0) {
            IERC20(wbtc).safeTransfer(payer, wbtcBalance);
        }

        emit SwapWbtcToVault(vaultSwap, vaultId, onBehalfOf, preview.amountWbtcToAcquire, preview.amountVault);
    }

    /// @dev Previews a single vault through the legacy LLP's batch preview entrypoint.
    ///      Reverts inside the LLP if the vault is not escrowed or is marked as deficit.
    /// @param vaultSwap Legacy BTCVaultSwap (LLP) to query
    /// @param vaultId Vault to preview
    /// @return Current cost and vault accounting for `vaultId`
    function _preview(address vaultSwap, bytes32 vaultId)
        internal
        view
        returns (IOldBTCVaultSwap.EscrowedVaultPreviewResult memory)
    {
        bytes32[] memory vaultIds = new bytes32[](1);
        vaultIds[0] = vaultId;
        IOldBTCVaultSwap.EscrowedVaultPreviewResult[] memory previews =
            IOldBTCVaultSwap(vaultSwap).previewEscrowedVaults(vaultIds);
        require(previews.length == 1, "ArbitrageRouter: preview length mismatch");
        return previews[0];
    }
}
