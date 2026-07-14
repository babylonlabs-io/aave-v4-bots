// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {AaveAdapter, TokenAmountLib} from "vault-contracts/applications/aave/AaveAdapter.sol";
import {VenueManager} from "./VenueManager.sol";
import {Types} from "./lib/Types.sol";
import {AaveAdapterLens, ISpoke} from "vault-contracts/applications/aave/AaveAdapterLens.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BTCVaultSwap} from "vault-contracts/applications/aave/llps/BTCVaultSwap.sol";

/// @notice Owner-operated bot that liquidates an Aave v4 position, funding the debt repayment with flash
///         liquidity and selling the seized WBTC collateral back into the borrowed assets.
/// @dev    The liquidation runs as a state machine (`Types.LiquidationIteration`) rather than a flat sequence,
///         because every flash venue hands control back through a callback. Each phase re-enters the router via
///         `VenueManager._resumeAfterCallback`, so the whole flow happens inside the outermost `liquidate` call:
///
///         Setup     -> for each flash venue that needs it (e.g. unlocking the UniswapV4 pool manager), one nested
///                      callback per venue.
///         FlashLoan -> for each flash venue, borrow that venue's token; each borrow nests another callback.
///         LiquidationAndSwap -> innermost frame: repay the borrower's debts through the Aave adapter, receive WBTC
///                      collateral, then swap WBTC back to the borrowed tokens via the supplied dex-aggregator calls.
///
///         As the stack unwinds, each venue pulls its own repayment back out of this contract (see `VenueManager`).
///         Whatever WBTC is left once every debt is repaid is the profit, and all reserve balances are swept to
///         `owner`.
contract LiquidationRouter is VenueManager {
    using SafeERC20 for IERC20;

    /// @dev Sentinel value for `LiquidationData.minWbtcProfit`. When set, the liquidation is forced to revert with
    ///      `BelovedError` at the point where the swap amounts are known. This is a simulation-only path: it is how
    ///      an off-chain caller reads back the WBTC balance and the outstanding venue debts in order to build the
    ///      `swapDatas` dex-aggregator calls for the real transaction. Never use it on-chain.
    uint256 private constant MIN_PROFIT_REVERT_TAG = type(uint256).max;

    /// @notice The only address allowed to run a liquidation; also the recipient of all proceeds.
    address public immutable owner;
    /// @notice Aave v4 lens used to enumerate reserves and estimate the liquidation payment.
    address public immutable lens;
    /// @notice Aave v4 adapter through which the liquidation is executed.
    address public immutable aaveAdapter;
    /// @notice Aave v4 spoke, the source of the reserve list.
    address public immutable spoke;
    /// @notice Reserve id of the BTC vault token in the spoke.
    uint256 public immutable vaultBtcReserveId;
    /// @notice LLP contract that converts the seized BTC vault collateral into WBTC during liquidation.
    address public immutable btcVaultSwap;
    /// @notice WBTC, the token the collateral is realised in and profit is measured in.
    address public immutable wbtc;

    /// @notice Thrown on purpose by the `MIN_PROFIT_REVERT_TAG` simulation path, to surface the amounts an off-chain
    ///         caller needs to build the dex-aggregator swap calldata.
    /// @param netWbtcBeforePayment WBTC held by this contract after the liquidation but before the venues are repaid.
    /// @param debts Every outstanding flash-venue debt (token, venue, amount) that the swaps must cover.
    error BelovedError(uint256 netWbtcBeforePayment, Types.VenueDebt[] debts);

    /// @notice Restricts a function to `owner`.
    modifier auth() {
        require(msg.sender == owner, "LiquidationRouter: Unauthorized");
        _;
    }

    /// @param _owner The address allowed to liquidate and receive the proceeds.
    /// @param _lens The Aave v4 adapter lens; the adapter, spoke and BTC reserve id are read from it.
    /// @param _btcVaultSwap The LLP used to realise seized BTC vault collateral as WBTC.
    constructor(address _owner, address _lens, address _btcVaultSwap) {
        require(_owner != address(0), "LiquidationRouter: Invalid owner address");
        owner = _owner;
        lens = _lens;
        aaveAdapter = AaveAdapterLens(_lens).adapter();
        spoke = AaveAdapterLens(_lens).spoke();
        vaultBtcReserveId = AaveAdapterLens(_lens).vaultBtcReserveId();
        btcVaultSwap = _btcVaultSwap;
        wbtc = address(BTCVaultSwap(_btcVaultSwap).WBTC());
    }

    /// @notice Liquidates a borrower and sweeps every reserve balance held by this contract to `owner`.
    /// @dev Entrypoint of the state machine described on the contract. Reverts unless the WBTC left after all flash
    ///      venues are repaid is at least `liquidationData.minWbtcProfit`, so a liquidation that turns out unprofitable
    ///      costs only gas.
    /// @param liquidationData The borrower to liquidate and the minimum acceptable WBTC profit.
    /// @param flashDatas The flash venues to borrow from, one per token needed to repay the borrower's debts. The
    ///        order matters: venues are set up and drawn in this order, and repaid in reverse as the callbacks unwind.
    /// @param swapDatas Dex-aggregator calls executed at the innermost frame to swap the seized WBTC back into the
    ///        borrowed tokens. Built off-chain, typically from a `MIN_PROFIT_REVERT_TAG` simulation.
    /// @return wbtcProfit The WBTC left over once every flash venue has been repaid.
    function liquidate(
        Types.LiquidationData memory liquidationData,
        Types.FlashData[] memory flashDatas,
        Types.SwapData[] memory swapDatas
    ) external auth returns (uint256 wbtcProfit) {
        require(liquidationData.borrower != address(0), "LiquidationRouter: Invalid borrower address");
        require(flashDatas.length > 0, "LiquidationRouter: No flash data provided");

        (address[] memory reserveTokens, uint256[] memory reserveDebtsToLiquidate, uint256 wbtcPayment) =
            _estLiquidationPayment(liquidationData.borrower);

        Types.LiquidationIteration memory iteration = Types.LiquidationIteration({
            phase: Types.LiquidationPhase.Setup,
            i: 0,
            liquidationData: liquidationData,
            flashDatas: flashDatas,
            swapDatas: swapDatas,
            reserveDebtsToLiquidate: reserveDebtsToLiquidate,
            wbtcPayment: wbtcPayment,
            reserveTokens: reserveTokens
        });

        _iterateLiquidation(iteration);
        _clearVenueDebts();

        wbtcProfit = IERC20(wbtc).balanceOf(address(this));
        require(wbtcProfit >= liquidationData.minWbtcProfit, "LiquidationRouter: Insufficient WBTC profit");
        _transferAllReservesOut(iteration.reserveTokens);
    }

    /// @inheritdoc VenueManager
    /// @dev The forwarded data is the ABI-encoded iteration state, which is how the router picks up where it left off
    ///      inside a venue callback.
    function _resumeAfterCallback(bytes memory data) internal virtual override {
        Types.LiquidationIteration memory iteration = abi.decode(data, (Types.LiquidationIteration));
        _iterateLiquidation(iteration);
    }

    /// @notice Runs one step of the liquidation state machine.
    /// @dev Setup and FlashLoan steps re-enter this function from inside a venue callback, so the call stack grows one
    ///      frame per venue. The final step liquidates and then swaps the seized WBTC; it is the innermost frame, and
    ///      everything after it happens as the stack unwinds.
    function _iterateLiquidation(Types.LiquidationIteration memory iteration) internal virtual {
        if (iteration.phase == Types.LiquidationPhase.Setup) {
            _executeSingleSetupPhase(iteration);
            return;
        }

        if (iteration.phase == Types.LiquidationPhase.FlashLoan) {
            _executeSingleFlashLoanPhase(iteration);
            return;
        }

        _executeLiquidationPhase(iteration);

        if (iteration.liquidationData.minWbtcProfit == MIN_PROFIT_REVERT_TAG) {
            revert BelovedError(IERC20(wbtc).balanceOf(address(this)), _getAllDebts());
        }

        for (uint256 i = 0; i < iteration.swapDatas.length; i++) {
            IERC20(wbtc).forceApprove(iteration.swapDatas[i].dexAggRouter, type(uint256).max);
            (bool success, bytes memory err) = iteration.swapDatas[i].dexAggRouter.call(iteration.swapDatas[i].callData);

            if (!success) {
                assembly {
                    revert(add(err, 0x20), mload(err))
                }
            }

            IERC20(wbtc).forceApprove(iteration.swapDatas[i].dexAggRouter, 0);
        }
    }

    // ---------------------- PHASE IMPLEMENTATION ----------------------

    /// @notice Setup phase: prepares venue `iteration.i`, if that venue needs it.
    /// @dev Venues that need no setup are skipped without a callback; the rest continue the state machine from inside
    ///      their setup callback.
    function _executeSingleSetupPhase(Types.LiquidationIteration memory iteration) internal virtual {
        (Types.VenueType venueType, address venueAddress) =
            (iteration.flashDatas[iteration.i].venueType, iteration.flashDatas[iteration.i].venueAddress);
        if (!_venueRequiresSetup(venueType, venueAddress)) {
            _iterateLiquidation(_toNextIteration(iteration));
            return;
        }
        _setUpSwapVenue(venueAddress, abi.encode(_toNextIteration(iteration)));
    }

    /// @notice FlashLoan phase: borrows venue `iteration.i`'s token in the amount needed to repay the borrower.
    /// @dev The amount is the borrower's debt in that token, plus the WBTC payment (fairness payment) when the token is
    ///      WBTC. A venue whose token is not owed anything is skipped rather than flash-borrowed for zero.
    function _executeSingleFlashLoanPhase(Types.LiquidationIteration memory iteration) internal virtual {
        address token = iteration.flashDatas[iteration.i].token;
        uint256 amount = _getReserveDebtAmount(iteration.reserveTokens, iteration.reserveDebtsToLiquidate, token)
            + (token == wbtc ? iteration.wbtcPayment : 0);

        if (amount == 0) {
            _iterateLiquidation(_toNextIteration(iteration));
            return;
        }

        Types.FlashData memory flashData = iteration.flashDatas[iteration.i];
        _flashLoan(flashData, amount, abi.encode(_toNextIteration(iteration)));
    }

    /// @notice LiquidationAndSwap phase: repays the borrower's debts through the Aave adapter and seizes the
    ///         collateral as WBTC.
    /// @dev Runs with every flash loan already drawn, so this contract holds the tokens the adapter pulls. Approvals
    ///      are granted for exactly the payment amounts and revoked immediately after.
    function _executeLiquidationPhase(Types.LiquidationIteration memory iteration) internal virtual {
        _approveForAdapter(iteration.reserveTokens, iteration.reserveDebtsToLiquidate, iteration.wbtcPayment);

        AaveAdapter(aaveAdapter)
            .liquidateWithLLP(
                iteration.liquidationData.borrower,
                btcVaultSwap,
                iteration.reserveDebtsToLiquidate,
                _getDefaultOrder(iteration.reserveDebtsToLiquidate.length),
                new TokenAmountLib.TokenAmount[](0)
            );

        _revokeApprovalForAdapter(iteration.reserveTokens);
    }

    /// @notice Advances the state machine: next venue within the current phase, or the first venue of the next phase.
    /// @dev Mutates and returns the same memory struct. Asserts on the LiquidationAndSwap phase, which is terminal.
    function _toNextIteration(Types.LiquidationIteration memory iteration)
        internal
        pure
        returns (Types.LiquidationIteration memory)
    {
        if (iteration.phase == Types.LiquidationPhase.Setup) {
            if (iteration.i == iteration.flashDatas.length - 1) {
                iteration.phase = Types.LiquidationPhase.FlashLoan;
                iteration.i = 0;
            } else {
                iteration.i++;
            }
        } else if (iteration.phase == Types.LiquidationPhase.FlashLoan) {
            if (iteration.i == iteration.flashDatas.length - 1) {
                iteration.phase = Types.LiquidationPhase.LiquidationAndSwap;
                iteration.i = 0;
            } else {
                iteration.i++;
            }
        } else {
            assert(false);
        }
        return iteration;
    }

    // ---------------------- ESTIMATE LIQUIDATION PAYMENT ----------------------

    /// @notice Asks the lens what it costs to fully liquidate `borrower`.
    /// @param borrower The account being liquidated.
    /// @return reserveTokens Every reserve underlying, in spoke order. `reserveDebtsToLiquidate` is indexed by it.
    /// @return reserveDebtsToLiquidate The amount of each reserve token needed to repay the borrower's debt.
    /// @return wbtcPayment The extra WBTC fairness payment
    function _estLiquidationPayment(address borrower)
        internal
        view
        returns (address[] memory reserveTokens, uint256[] memory reserveDebtsToLiquidate, uint256 wbtcPayment)
    {
        reserveTokens = _getReserves();
        (reserveDebtsToLiquidate, wbtcPayment,) = AaveAdapterLens(lens)
            .estimateLiquidation(AaveAdapter(aaveAdapter).getPosition(borrower).proxyContract, false);
    }

    /// @notice Lists the underlying token of every reserve on the spoke, in reserve-id order.
    function _getReserves() internal view returns (address[] memory reserveTokens) {
        uint256 reserveCount = ISpoke(spoke).getReserveCount();
        reserveTokens = new address[](reserveCount);
        for (uint256 i = 0; i < reserveCount; i++) {
            reserveTokens[i] = ISpoke(spoke).getReserve(i).underlying;
        }
    }

    // ---------------------- ERC20 Handlers ----------------------

    /// @notice Sweeps this contract's balance of every reserve token to `owner`. Called once the venues are repaid,
    ///         so anything left is profit or swap dust.
    function _transferAllReservesOut(address[] memory reserveTokens) internal {
        address to = owner;
        for (uint256 i = 0; i < reserveTokens.length; i++) {
            address token = reserveTokens[i];
            uint256 balance = IERC20(token).balanceOf(address(this));
            if (balance > 0) {
                IERC20(token).safeTransfer(to, balance);
            }
        }
    }

    /// @notice Approves the Aave adapter to pull exactly the repayment amount of each reserve token, plus the fairness payment
    ///         in WBTC on top of the WBTC entry.
    function _approveForAdapter(address[] memory reserveTokens, uint256[] memory reservePayments, uint256 wbtcPayment)
        internal
    {
        for (uint256 i = 0; i < reserveTokens.length; i++) {
            address token = reserveTokens[i];
            uint256 amountPayment = reservePayments[i] + (token == wbtc ? wbtcPayment : 0);

            if (amountPayment == 0) {
                continue;
            }
            IERC20(token).forceApprove(aaveAdapter, amountPayment);
        }
    }

    /// @notice Drops the adapter's allowance on every reserve token back to zero, so no approval outlives the call.
    function _revokeApprovalForAdapter(address[] memory reserveTokens) internal {
        for (uint256 i = 0; i < reserveTokens.length; i++) {
            IERC20(reserveTokens[i]).forceApprove(aaveAdapter, 0);
        }
    }

    // ---------------------- MULTICALL ----------------------

    /// @notice Batches several calls to this contract into one transaction.
    /// @dev `delegatecall` to self, so `msg.sender` is preserved and the `auth` gate on `liquidate` still applies —
    ///      this function is deliberately not gated itself. Typical use is trying several candidate liquidations with
    ///      `requireSuccess == false`, letting the ones that lost the race fail without reverting the batch.
    /// @param data The calls to make, each ABI-encoded as if calling this contract directly.
    /// @param requireSuccess If true, the first failing call reverts the whole batch with its revert reason.
    /// @return successes Whether each call succeeded.
    /// @return results The raw return (or revert) data of each call.
    function multicall(bytes[] calldata data, bool requireSuccess)
        external
        returns (bool[] memory successes, bytes[] memory results)
    {
        results = new bytes[](data.length);
        successes = new bool[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (successes[i], results[i]) = address(this).delegatecall(data[i]);
            if (requireSuccess && !successes[i]) {
                revert(string(results[i]));
            }
        }
    }

    // ---------------------- MISC ----------------------

    /// @notice Looks up how much of `ofToken` the liquidation has to repay.
    /// @dev `reserveDebts` is indexed by `reserveTokens`. Returns 0 for a token that is not a reserve.
    function _getReserveDebtAmount(address[] memory reserveTokens, uint256[] memory reserveDebts, address ofToken)
        internal
        pure
        returns (uint256)
    {
        for (uint256 i = 0; i < reserveTokens.length; i++) {
            if (reserveTokens[i] == ofToken) {
                return reserveDebts[i];
            }
        }
        return 0;
    }

    /// @notice Builds the identity order `[0, 1, ..., length - 1]`, i.e. repay the reserves in spoke order.
    function _getDefaultOrder(uint256 length) internal pure returns (uint256[] memory order) {
        order = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            order[i] = i;
        }
    }
}
