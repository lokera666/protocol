// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.9;

import "contracts/interfaces/IFacadeWrite.sol";
import "contracts/facade/lib/FacadeWriteLib.sol";

/**
 * @title FacadeWrite
 * @notice A UX-friendly layer to interact with the protocol
 * @dev Under the hood, uses two external libs to deal with blocksize limits.
 */
contract FacadeWrite is IFacadeWrite {
    using FacadeWriteLib for address;

    IDeployer public immutable deployer;

    constructor(IDeployer deployer_) {
        require(address(deployer_) != address(0), "invalid address");
        deployer = deployer_;
    }

    /// Step 1
    function deployRToken(ConfigurationParams calldata config, SetupParams calldata setup)
        external
        returns (address)
    {
        // Perform validations
        require(setup.primaryBasket.length > 0, "no collateral");
        require(setup.primaryBasket.length == setup.weights.length, "invalid length");

        // Validate backups
        for (uint256 i = 0; i < setup.backups.length; ++i) {
            require(setup.backups[i].backupCollateral.length > 0, "no backup collateral");
        }

        // Deploy contracts
        IRToken rToken = IRToken(
            deployer.deploy(
                config.name,
                config.symbol,
                config.mandate,
                address(this), // set as owner
                config.params
            )
        );

        // Get Main
        IMain main = rToken.main();

        // Register assets
        for (uint256 i = 0; i < setup.assets.length; ++i) {
            IAssetRegistry(address(main.assetRegistry())).register(setup.assets[i]);
        }

        // Setup basket
        {
            IERC20[] memory basketERC20s = new IERC20[](setup.primaryBasket.length);

            // Register collateral
            for (uint256 i = 0; i < setup.primaryBasket.length; ++i) {
                IAssetRegistry(address(main.assetRegistry())).register(setup.primaryBasket[i]);
                IERC20 erc20 = setup.primaryBasket[i].erc20();
                basketERC20s[i] = erc20;

                // Grant allowance
                main.backingManager().grantRTokenAllowance(erc20);
            }

            // Set basket
            main.basketHandler().setPrimeBasket(basketERC20s, setup.weights);
            main.basketHandler().refreshBasket();
        }

        // Set backup config
        {
            for (uint256 i = 0; i < setup.backups.length; ++i) {
                IERC20[] memory backupERC20s = new IERC20[](
                    setup.backups[i].backupCollateral.length
                );

                for (uint256 j = 0; j < setup.backups[i].backupCollateral.length; ++j) {
                    ICollateral backupColl = setup.backups[i].backupCollateral[j];
                    IAssetRegistry(address(main.assetRegistry())).register(backupColl);
                    backupERC20s[j] = backupColl.erc20();
                }

                main.basketHandler().setBackupConfig(
                    setup.backups[i].backupUnit,
                    setup.backups[i].diversityFactor,
                    backupERC20s
                );
            }
        }

        // Pause until setupGovernance
        main.pause();

        // Setup deployer as owner to complete next step - do not renounce roles yet
        main.grantRole(OWNER, msg.sender);

        // Return rToken address
        return address(rToken);
    }

    /// Step 2
    /// @return newOwner The address of the new owner
    function setupGovernance(
        IRToken rToken,
        bool deployGovernance,
        bool unpause,
        GovernanceParams calldata govParams,
        address owner,
        address guardian,
        address pauser
    ) external returns (address newOwner) {
        // Get Main
        IMain main = rToken.main();

        require(main.hasRole(OWNER, address(this)), "ownership already transferred");
        require(main.hasRole(OWNER, msg.sender), "not initial deployer");

        // Remove ownership to sender
        main.revokeRole(OWNER, msg.sender);

        if (deployGovernance) {
            require(owner == address(0), "owner should be empty");

            TimelockController timelock = new TimelockController(
                govParams.timelockDelay,
                new address[](0),
                new address[](0)
            );

            // Deploy Governance contract
            address governance = FacadeWriteLib.deployGovernance(
                IStRSRVotes(address(main.stRSR())),
                timelock,
                govParams.votingDelay,
                govParams.votingPeriod,
                govParams.proposalThresholdAsMicroPercent,
                govParams.quorumPercent
            );
            emit GovernanceCreated(rToken, governance, address(timelock));

            // Setup Roles
            timelock.grantRole(timelock.PROPOSER_ROLE(), governance); // Gov only proposer
            timelock.grantRole(timelock.CANCELLER_ROLE(), guardian); // Guardian as canceller
            timelock.grantRole(timelock.EXECUTOR_ROLE(), address(0)); // Anyone as executor
            timelock.revokeRole(timelock.TIMELOCK_ADMIN_ROLE(), address(this)); // Revoke admin role

            // Set new owner to timelock
            newOwner = address(timelock);
        } else {
            require(owner != address(0), "owner not defined");
            newOwner = owner;
        }

        // Setup guardian as freeze starter / extender + pauser
        if (guardian != address(0)) {
            // As a further decentralization step it is suggested to further differentiate between
            // these two roles. But this is what will make sense for simple system setup.
            main.grantRole(SHORT_FREEZER, guardian);
            main.grantRole(LONG_FREEZER, guardian);
            main.grantRole(PAUSER, guardian);
        }

        // Setup Pauser
        if (pauser != address(0)) {
            main.grantRole(PAUSER, pauser);
        }

        // Unpause if required
        if (unpause) {
            main.unpause();
        }

        // Transfer Ownership and renounce roles
        main.grantRole(OWNER, newOwner);
        main.grantRole(SHORT_FREEZER, newOwner);
        main.grantRole(LONG_FREEZER, newOwner);
        main.grantRole(PAUSER, newOwner);
        main.renounceRole(OWNER, address(this));
        main.renounceRole(SHORT_FREEZER, address(this));
        main.renounceRole(LONG_FREEZER, address(this));
        main.renounceRole(PAUSER, address(this));
    }
}
