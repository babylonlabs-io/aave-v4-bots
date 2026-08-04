// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {SelfCallRelayer, EIP712} from "./base/SelfCallRelayer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBTCVaultSwap} from "../../lib/contracts/src/applications/aave/interfaces/IBTCVaultSwap.sol";

contract ArbitrageRouter is SelfCallRelayer {
    using SafeERC20 for IERC20;

    event SwapWbtcToVault(
        address indexed vaultSwap,
        bytes32 indexed vaultId,
        address indexed onBehalfOf,
        uint256 amountWbtcToAcquire,
        uint256 amountVault
    );

    string public constant NAME = "ArbitrageRouter";
    string public constant VERSION = "1.0.0";

    address public immutable payer;
    address public immutable wbtc;

    constructor(address _signer, address _payer, address _wbtc) EIP712(NAME, VERSION) SelfCallRelayer(_signer) {
        require(_payer != address(0), "ArbitrageRouter: invalid payer");
        require(_wbtc != address(0), "ArbitrageRouter: invalid wbtc");
        payer = _payer;
        wbtc = _wbtc;
    }

    function swapWbtcToVault(address vaultSwap, bytes32 vaultId, address onBehalfOf, uint256 minProfit)
        external
        onlySelf
    {
        IBTCVaultSwap.EscrowedVaultPreviewResult memory preview = _preview(vaultSwap, vaultId);
        require(preview.amountProfitEst >= minProfit, "ArbitrageRouter: insufficient profit");

        IERC20(wbtc).safeTransferFrom(payer, address(this), preview.amountWbtcToAcquire);
        IERC20(wbtc).forceApprove(vaultSwap, preview.amountWbtcToAcquire);
        IBTCVaultSwap(vaultSwap).swapWbtcForVaultOnBehalf(vaultId, preview.amountWbtcToAcquire, onBehalfOf);
        IERC20(wbtc).forceApprove(vaultSwap, 0);

        uint256 wbtcBalance = IERC20(wbtc).balanceOf(address(this));
        if (wbtcBalance > 0) {
            IERC20(wbtc).safeTransfer(payer, wbtcBalance);
        }

        emit SwapWbtcToVault(vaultSwap, vaultId, onBehalfOf, preview.amountWbtcToAcquire, preview.amountVault);
    }

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
