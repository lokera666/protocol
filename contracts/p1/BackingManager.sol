// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.9;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "contracts/interfaces/IAsset.sol";
import "contracts/interfaces/IBackingManager.sol";
import "contracts/interfaces/IMain.sol";
import "contracts/libraries/Fixed.sol";
import "contracts/p1/mixins/Trading.sol";
import "contracts/p1/mixins/TradingLib.sol";

/**
 * @title BackingManager
 * @notice The backing manager holds + manages the backing for an RToken
 */

/// @custom:oz-upgrades-unsafe-allow external-library-linking
contract BackingManagerP1 is TradingP1, IBackingManager {
    using FixLib for uint192;
    using SafeERC20Upgradeable for IERC20Upgradeable;

    uint48 public constant MAX_TRADING_DELAY = 31536000; // {s} 1 year
    uint192 public constant MAX_BACKING_BUFFER = 1e18; // {%}

    uint48 public tradingDelay; // {s} how long to wait until resuming trading after switching
    uint192 public backingBuffer; // {%} how much extra backing collateral to keep

    function init(
        IMain main_,
        uint48 tradingDelay_,
        uint192 backingBuffer_,
        uint192 maxTradeSlippage_
    ) external initializer {
        __Component_init(main_);
        __Trading_init(maxTradeSlippage_);
        setTradingDelay(tradingDelay_);
        setBackingBuffer(backingBuffer_);
    }

    // Give RToken max allowance over a registered token
    /// @custom:interaction CEI
    function grantRTokenAllowance(IERC20 erc20) external notPausedOrFrozen {
        require(main.assetRegistry().isRegistered(erc20), "erc20 unregistered");
        // == Interaction ==
        uint256 currAllowance = erc20.allowance(address(this), address(main.rToken()));
        IERC20Upgradeable(address(erc20)).safeIncreaseAllowance(
            address(main.rToken()),
            type(uint256).max - currAllowance
        );
    }

    /// Maintain the overall backing policy; handout assets otherwise
    /// @custom:interaction RCEI
    function manageTokens(IERC20[] calldata erc20s) external notPausedOrFrozen {
        // Token list must not contain duplicates
        requireUnique(erc20s);

        // == Refresh ==
        main.assetRegistry().refresh();

        if (tradesOpen > 0) return;
        // Only trade when all the collateral assets in the basket are SOUND
        require(main.basketHandler().status() == CollateralStatus.SOUND, "basket not sound");

        (, uint256 basketTimestamp) = main.basketHandler().lastSet();
        if (block.timestamp < basketTimestamp + tradingDelay) return;

        if (main.basketHandler().fullyCollateralized()) {
            // == Interaction (then return) ==
            handoutExcessAssets(erc20s);
        } else {
            /*
             * Recapitalization
             *
             * Strategy: iteratively move the system on a forgiving path towards capitalization
             * through a narrowing BU price band. The initial large spread reflects the
             * uncertainty associated with the market price of defaulted/volatile collateral, as
             * well as potential losses due to trading slippage. In the absence of further
             * collateral default, the size of the BU price band should decrease with each trade
             * until it is 0, at which point capitalization is restored.
             *
             * TODO
             * Argument for why this converges
             *
             * ======
             *
             * If we run out of capital and are still undercapitalized, we compromise
             * rToken.basketsNeeded to the current basket holdings. Haircut time.
             *
             * TODO
             * Argument for why this can't hurt RToken holders
             */

            (bool doTrade, TradeRequest memory req) = TradingLibP1.prepareTradeRecapitalize();

            if (doTrade) {
                // Seize RSR if needed
                if (req.sell.erc20() == main.rsr()) {
                    uint256 bal = req.sell.erc20().balanceOf(address(this));
                    if (req.sellAmount > bal) main.stRSR().seizeRSR(req.sellAmount - bal);
                }

                tryTrade(req);
            } else {
                // Haircut time
                compromiseBasketsNeeded();
            }
        }
    }

    /// Send excess assets to the RSR and RToken traders
    /// @custom:interaction CEI
    function handoutExcessAssets(IERC20[] calldata erc20s) private {
        /**
         * Assumptions:
         *   - Fully capitalized. All collateral, and therefore assets, meet balance requirements
         *   - All backing capital is held at BackingManager's address. No capital is out on-trade
         *   - Neither RToken nor RSR are in the basket
         *   - Each address in erc20s is unique
         *
         * Steps:
         *   1. Forward all held RSR to the RSR trader to prevent using it for RToken appreciation
         *   2. Using whatever balances of collateral is there, mint as much RToken as possible.
         *      Update `basketNeeded`.
         *   3. Handout all surplus asset balances (including collateral and RToken) to the
         *      RSR and RToken traders according to the distribution totals.
         */

        IBasketHandler basketHandler = main.basketHandler();
        address rsrTrader = address(main.rsrTrader());
        address rTokenTrader = address(main.rTokenTrader());

        // Forward any RSR held to StRSR pool; RSR should never be sold for RToken yield
        if (main.rsr().balanceOf(address(this)) > 0) {
            // We consider this an interaction "within our system" even though RSR is already live
            IERC20Upgradeable(address(main.rsr())).safeTransfer(
                address(main.rsrTrader()),
                main.rsr().balanceOf(address(this))
            );
        }

        // Mint revenue RToken and update `basketsNeeded`
        uint192 needed; // {BU}
        {
            IRToken rToken = main.rToken();
            needed = rToken.basketsNeeded(); // {BU}
            uint192 held = basketHandler.basketsHeldBy(address(this)); // {BU}
            if (held.gt(needed)) {
                int8 decimals = int8(rToken.decimals());
                uint192 totalSupply = shiftl_toFix(rToken.totalSupply(), -decimals); // {rTok}

                // {qRTok} = ({(BU - BU) * rTok / BU}) * {qRTok/rTok}
                uint256 rTok = held.minus(needed).mulDiv(totalSupply, needed).shiftl_toUint(
                    decimals
                );
                rToken.mint(address(this), rTok);
                rToken.setBasketsNeeded(held);
                needed = held;
            }
        }
        // Post-conditions:
        // - Still fully capitalized
        // - BU exchange rate {BU/rTok} did not decrease

        // Keep a small surplus of individual collateral
        needed = needed.mul(FIX_ONE.plus(backingBuffer));

        // Handout excess assets above what is needed, including any recently minted RToken
        uint256 length = erc20s.length;
        RevenueTotals memory totals = main.distributor().totals();
        uint256[] memory toRSR = new uint256[](length);
        uint256[] memory toRToken = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            IAsset asset = main.assetRegistry().toAsset(erc20s[i]);

            uint192 req = needed.mul(basketHandler.quantity(erc20s[i]), CEIL);
            if (asset.bal(address(this)).gt(req)) {
                // delta: {qTok}
                uint256 delta = asset.bal(address(this)).minus(req).shiftl_toUint(
                    int8(IERC20Metadata(address(erc20s[i])).decimals())
                );
                toRSR[i] = (delta / (totals.rTokenTotal + totals.rsrTotal)) * totals.rsrTotal;
                toRToken[i] = (delta / (totals.rTokenTotal + totals.rsrTotal)) * totals.rTokenTotal;
            }
        }

        // == Interactions ==
        for (uint256 i = 0; i < length; ++i) {
            IERC20Upgradeable erc20 = IERC20Upgradeable(address(erc20s[i]));
            if (toRToken[i] > 0) erc20.safeTransfer(rTokenTrader, toRToken[i]);
            if (toRSR[i] > 0) erc20.safeTransfer(rsrTrader, toRSR[i]);
        }

        // It's okay if there is leftover dust for RToken or a surplus asset (not RSR)
    }

    /// Compromise on how many baskets are needed in order to recapitalize-by-accounting
    function compromiseBasketsNeeded() private {
        // TODO this might be the one assert we actually keep
        assert(tradesOpen == 0 && !main.basketHandler().fullyCollateralized());
        main.rToken().setBasketsNeeded(main.basketHandler().basketsHeldBy(address(this)));
    }

    /// Require that all tokens in this array are unique
    function requireUnique(IERC20[] calldata erc20s) internal pure {
        for (uint256 i = 1; i < erc20s.length; i++) {
            for (uint256 j = 0; j < i; j++) {
                require(erc20s[i] != erc20s[j], "duplicate tokens");
            }
        }
    }

    // === Setters ===

    /// @custom:governance
    function setTradingDelay(uint48 val) public governance {
        require(val <= MAX_TRADING_DELAY, "invalid tradingDelay");
        emit TradingDelaySet(tradingDelay, val);
        tradingDelay = val;
    }

    /// @custom:governance
    function setBackingBuffer(uint192 val) public governance {
        require(val <= MAX_BACKING_BUFFER, "invalid backingBuffer");
        emit BackingBufferSet(backingBuffer, val);
        backingBuffer = val;
    }
}
