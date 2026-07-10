// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {AaveAdapter, TokenAmountLib} from "vault-contracts/applications/aave/AaveAdapter.sol";
import {VenueManager} from "./VenueManager.sol";
import {Types} from "./lib/Types.sol";
import {AaveAdapterLens, ISpoke} from "vault-contracts/applications/aave/AaveAdapterLens.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BTCVaultSwap} from "vault-contracts/applications/aave/llps/BTCVaultSwap.sol";

contract LiquidationRouter is VenueManager {
    using SafeERC20 for IERC20;

    uint256 private constant MIN_PROFIT_REVERT_TAG = type(uint256).max;

    address public immutable owner;
    address public immutable lens;
    address public immutable aaveAdapter;
    address public immutable spoke;
    uint256 public immutable vaultBtcReserveId;
    address public immutable btcVaultSwap;
    address public immutable wbtc;

    error BelovedError(uint256 netWbtcBeforePayment, Types.VenueDebt[] debts);

    modifier auth() {
        require(msg.sender == owner, "LiquidationRouter: Unauthorized");
        _;
    }

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

    function liquidate(
        Types.LiquidationData memory liquidationData,
        Types.FlashData[] memory flashDatas,
        Types.SwapData[] memory swapDatas
    ) external auth returns (uint256 wbtcProfit) {
        require (liquidationData.borrower != address(0), "LiquidationRouter: Invalid borrower address");
        require (flashDatas.length > 0, "LiquidationRouter: No flash data provided");

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

    function _resumeAfterCallback(bytes memory data) internal virtual override {
        Types.LiquidationIteration memory iteration = abi.decode(data, (Types.LiquidationIteration));
        _iterateLiquidation(iteration);
    }

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
            (bool success,) = iteration.swapDatas[i].dexAggRouter.call(iteration.swapDatas[i].callData);
            require(success, "LiquidationRouter: Swap failed");
            IERC20(wbtc).forceApprove(iteration.swapDatas[i].dexAggRouter, 0);
        }
    }

    // ---------------------- PHASE IMPLEMENTATION ----------------------

    function _executeSingleSetupPhase(Types.LiquidationIteration memory iteration) internal virtual {
        (Types.VenueType venueType, address venueAddress) =
            (iteration.flashDatas[iteration.i].venueType, iteration.flashDatas[iteration.i].venueAddress);
        if (!_venueRequiresSetup(venueType, venueAddress)) {
            _iterateLiquidation(_toNextIteration(iteration));
            return;
        }
        _setUpSwapVenue(venueAddress, abi.encode(_toNextIteration(iteration)));
    }

    function _executeSingleFlashLoanPhase(Types.LiquidationIteration memory iteration) internal virtual {
        address token = iteration.flashDatas[iteration.i].token;
        uint256 amount = _getReserveDebtAmount(iteration.reserveTokens, iteration.reserveDebtsToLiquidate, token);

        Types.FlashData memory flashData = iteration.flashDatas[iteration.i];
        _flashLoan(flashData, amount, abi.encode(_toNextIteration(iteration)));
    }

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

    function _estLiquidationPayment(address borrower)
        internal
        view
        returns (address[] memory reserveTokens, uint256[] memory reserveDebtsToLiquidate, uint256 wbtcPayment)
    {
        reserveTokens = _getReserves();
        (reserveDebtsToLiquidate, wbtcPayment,) = AaveAdapterLens(lens)
            .estimateLiquidation(AaveAdapter(aaveAdapter).getPosition(borrower).proxyContract, false);
    }

    function _getReserves() internal view returns (address[] memory reserveTokens) {
        uint256 reserveCount = ISpoke(spoke).getReserveCount();
        reserveTokens = new address[](reserveCount);
        for (uint256 i = 0; i < reserveCount; i++) {
            reserveTokens[i] = ISpoke(spoke).getReserve(i).underlying;
        }
    }

    // ---------------------- ERC20 Handlers ----------------------

    function _transferAllReservesOut(address[] memory reserveTokens) internal {
        address to = owner;
        for (uint256 i = 0; i < reserveTokens.length; i++) {
            address token = reserveTokens[i];
            if (IERC20(token).balanceOf(address(this)) > 0) {
                IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
            }
        }
    }

    function _approveForAdapter(address[] memory reserveTokens, uint256[] memory reservePayments, uint256 wbtcPayment)
        internal
    {
        for (uint256 i = 0; i < reserveTokens.length; i++) {
            if (reservePayments[i] > 0) {
                address token = reserveTokens[i];
                uint256 amountPayment = reservePayments[i] + (token == wbtc ? wbtcPayment : 0);
                IERC20(token).forceApprove(aaveAdapter, amountPayment);
            }
        }
    }

    function _revokeApprovalForAdapter(address[] memory reserveTokens) internal {
        for (uint256 i = 0; i < reserveTokens.length; i++) {
            IERC20(reserveTokens[i]).forceApprove(aaveAdapter, 0);
        }
    }

    // ---------------------- MULTICALL ----------------------

    function multicall(bytes[] calldata data, bool requireSuccess)
        external
        returns (bool[] memory successes, bytes[] memory results)
    {
        results = new bytes[](data.length);
        successes = new bool[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (successes[i], results[i]) = address(this).call(data[i]);
            if (requireSuccess && !successes[i]) {
                revert(string(results[i]));
            }
        }
    }

    // ---------------------- MISC ----------------------
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

    function _getDefaultOrder(uint256 length) internal pure returns (uint256[] memory order) {
        order = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            order[i] = i;
        }
    }
}
