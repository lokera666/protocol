import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { BigNumber, ContractFactory, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { IConfig, TradingRange } from '../../common/configuration'
import {
  BN_SCALE_FACTOR,
  CollateralStatus,
  MAX_UINT192,
  MAX_UINT256,
  ZERO_ADDRESS,
} from '../../common/constants'
import { bn, fp } from '../../common/numbers'
import {
  ATokenFiatCollateral,
  ComptrollerMock,
  CTokenFiatCollateral,
  CTokenNonFiatCollateral,
  CTokenMock,
  CTokenSelfReferentialCollateral,
  ERC20Mock,
  EURFiatCollateral,
  Facade,
  FiatCollateral,
  MockV3Aggregator,
  NonFiatCollateral,
  OracleLib,
  RTokenAsset,
  SelfReferentialCollateral,
  StaticATokenMock,
  TestIBackingManager,
  TestIRToken,
  USDCMock,
  WETH9,
} from '../../typechain'
import { advanceTime, getLatestBlockTimestamp, setNextBlockTimestamp } from '../utils/time'
import snapshotGasCost from '../utils/snapshotGasCost'
import { setInvalidOracleTimestamp, setOraclePrice } from '../utils/oracles'
import { Collateral, defaultFixture, ORACLE_TIMEOUT } from '../fixtures'

const createFixtureLoader = waffle.createFixtureLoader

const DEFAULT_THRESHOLD = fp('0.05') // 5%
const DELAY_UNTIL_DEFAULT = bn('86400') // 24h

const describeGas = process.env.REPORT_GAS ? describe : describe.skip

describe('Collateral contracts', () => {
  let owner: SignerWithAddress

  let rToken: TestIRToken

  // Tokens
  let token: ERC20Mock
  let usdc: USDCMock
  let aToken: StaticATokenMock
  let cToken: CTokenMock
  let aaveToken: ERC20Mock
  let compToken: ERC20Mock

  // Assets
  let tokenCollateral: FiatCollateral
  let usdcCollateral: FiatCollateral
  let aTokenCollateral: ATokenFiatCollateral
  let cTokenCollateral: CTokenFiatCollateral
  let rTokenAsset: RTokenAsset

  // Aave / Compound / Chainlink
  let compoundMock: ComptrollerMock

  // Config
  let config: IConfig

  // Main
  let backingManager: TestIBackingManager

  // Oracle
  let oracleLib: OracleLib

  // Facade
  let facade: Facade

  // Factories
  let FiatCollateralFactory: ContractFactory
  let ATokenFiatCollateralFactory: ContractFactory
  let CTokenFiatCollateralFactory: ContractFactory

  let loadFixture: ReturnType<typeof createFixtureLoader>
  let wallet: Wallet

  const amt = bn('100e18')

  before('create fixture loader', async () => {
    ;[wallet] = (await ethers.getSigners()) as unknown as Wallet[]
    loadFixture = createFixtureLoader([wallet])
  })

  beforeEach(async () => {
    ;[owner] = await ethers.getSigners()

    let basket: Collateral[]

      // Deploy fixture
    ;({
      compToken,
      compoundMock,
      aaveToken,
      basket,
      config,
      backingManager,
      rToken,
      facade,
      oracleLib,
      rTokenAsset,
    } = await loadFixture(defaultFixture))

    // Get assets and tokens
    tokenCollateral = <FiatCollateral>basket[0]
    usdcCollateral = <FiatCollateral>basket[1]
    aTokenCollateral = <ATokenFiatCollateral>basket[2]
    cTokenCollateral = <CTokenFiatCollateral>basket[3]
    token = <ERC20Mock>await ethers.getContractAt('ERC20Mock', await tokenCollateral.erc20())
    usdc = <USDCMock>await ethers.getContractAt('USDCMock', await usdcCollateral.erc20())
    aToken = <StaticATokenMock>(
      await ethers.getContractAt('StaticATokenMock', await aTokenCollateral.erc20())
    )
    cToken = <CTokenMock>await ethers.getContractAt('CTokenMock', await cTokenCollateral.erc20())

    await token.connect(owner).mint(owner.address, amt)
    await usdc.connect(owner).mint(owner.address, amt.div(bn('1e12')))
    await aToken.connect(owner).mint(owner.address, amt)
    await cToken.connect(owner).mint(owner.address, amt.div(bn('1e10')).mul(50))

    // Issue RToken to enable RToken.price
    await token.connect(owner).approve(rToken.address, amt)
    await usdc.connect(owner).approve(rToken.address, amt.div(bn('1e12')))
    await aToken.connect(owner).approve(rToken.address, amt)
    await cToken.connect(owner).approve(rToken.address, amt.div(bn('1e10')).mul(50))
    await rToken.connect(owner).issue(amt)

    // Factories
    FiatCollateralFactory = await ethers.getContractFactory('FiatCollateral', {
      libraries: { OracleLib: oracleLib.address },
    })

    ATokenFiatCollateralFactory = await ethers.getContractFactory('ATokenFiatCollateral', {
      libraries: { OracleLib: oracleLib.address },
    })

    CTokenFiatCollateralFactory = await ethers.getContractFactory('CTokenFiatCollateral', {
      libraries: { OracleLib: oracleLib.address },
    })
  })

  describe('Deployment', () => {
    it('Deployment should setup collateral correctly #fast', async () => {
      // Fiat Token Asset
      expect(await tokenCollateral.isCollateral()).to.equal(true)
      expect(await tokenCollateral.erc20()).to.equal(token.address)
      expect(await token.decimals()).to.equal(18)
      expect(await tokenCollateral.targetName()).to.equal(ethers.utils.formatBytes32String('USD'))
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await tokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await tokenCollateral.defaultThreshold()).to.equal(DEFAULT_THRESHOLD)
      expect(await tokenCollateral.delayUntilDefault()).to.equal(DELAY_UNTIL_DEFAULT)
      expect(await tokenCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await tokenCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)
      expect(await tokenCollateral.oracleTimeout()).to.equal(ORACLE_TIMEOUT)
      expect(await tokenCollateral.refPerTok()).to.equal(fp('1'))
      expect(await tokenCollateral.targetPerRef()).to.equal(fp('1'))
      expect(await tokenCollateral.pricePerTarget()).to.equal(fp('1'))
      expect(await tokenCollateral.bal(owner.address)).to.equal(amt.mul(3).div(4))
      expect(await tokenCollateral.price()).to.equal(fp('1'))
      expect(await tokenCollateral.getClaimCalldata()).to.eql([ZERO_ADDRESS, '0x'])
      expect(await tokenCollateral.rewardERC20()).to.equal(ZERO_ADDRESS)

      // USDC Fiat Token
      expect(await usdcCollateral.isCollateral()).to.equal(true)
      expect(await usdcCollateral.erc20()).to.equal(usdc.address)
      expect(await usdc.decimals()).to.equal(6)
      expect(await usdcCollateral.targetName()).to.equal(ethers.utils.formatBytes32String('USD'))
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await usdcCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await usdcCollateral.defaultThreshold()).to.equal(DEFAULT_THRESHOLD)
      expect(await usdcCollateral.delayUntilDefault()).to.equal(DELAY_UNTIL_DEFAULT)
      expect(await usdcCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await usdcCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)
      expect(await usdcCollateral.oracleTimeout()).to.equal(ORACLE_TIMEOUT)
      expect(await usdcCollateral.bal(owner.address)).to.equal(amt.mul(3).div(4))
      expect(await usdcCollateral.refPerTok()).to.equal(fp('1'))
      expect(await usdcCollateral.targetPerRef()).to.equal(fp('1'))
      expect(await usdcCollateral.pricePerTarget()).to.equal(fp('1'))
      expect(await usdcCollateral.price()).to.equal(fp('1'))
      expect(await usdcCollateral.getClaimCalldata()).to.eql([ZERO_ADDRESS, '0x'])
      expect(await usdcCollateral.rewardERC20()).to.equal(ZERO_ADDRESS)

      // AToken
      expect(await aTokenCollateral.isCollateral()).to.equal(true)
      expect(await aTokenCollateral.erc20()).to.equal(aToken.address)
      expect(await aToken.decimals()).to.equal(18)
      expect(await aTokenCollateral.targetName()).to.equal(ethers.utils.formatBytes32String('USD'))
      expect(await aTokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await aTokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await aTokenCollateral.defaultThreshold()).to.equal(DEFAULT_THRESHOLD)
      expect(await aTokenCollateral.delayUntilDefault()).to.equal(DELAY_UNTIL_DEFAULT)
      expect(await aTokenCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await aTokenCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)
      expect(await aTokenCollateral.oracleTimeout()).to.equal(ORACLE_TIMEOUT)
      expect(await aTokenCollateral.bal(owner.address)).to.equal(amt.mul(3).div(4))
      expect(await aTokenCollateral.refPerTok()).to.equal(fp('1'))
      expect(await aTokenCollateral.targetPerRef()).to.equal(fp('1'))
      expect(await aTokenCollateral.pricePerTarget()).to.equal(fp('1'))
      expect(await aTokenCollateral.prevReferencePrice()).to.equal(
        await aTokenCollateral.refPerTok()
      )
      expect(await aTokenCollateral.price()).to.equal(fp('1'))
      let calldata = aToken.interface.encodeFunctionData('claimRewardsToSelf', [true])
      expect(await aTokenCollateral.getClaimCalldata()).to.eql([aToken.address, calldata])
      expect(await aTokenCollateral.rewardERC20()).to.equal(aaveToken.address)

      // CToken
      expect(await cTokenCollateral.isCollateral()).to.equal(true)
      expect(await cTokenCollateral.referenceERC20Decimals()).to.equal(18)
      expect(await cTokenCollateral.erc20()).to.equal(cToken.address)
      expect(await cToken.decimals()).to.equal(8)
      expect(await cTokenCollateral.targetName()).to.equal(ethers.utils.formatBytes32String('USD'))
      expect(await cTokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await cTokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await cTokenCollateral.defaultThreshold()).to.equal(DEFAULT_THRESHOLD)
      expect(await cTokenCollateral.delayUntilDefault()).to.equal(DELAY_UNTIL_DEFAULT)
      expect(await cTokenCollateral.minTradeSize()).to.equal(
        bn(50).mul(config.rTokenTradingRange.minAmt)
      )
      expect(await cTokenCollateral.maxTradeSize()).to.equal(
        bn(50).mul(config.rTokenTradingRange.maxAmt)
      )
      expect(await cTokenCollateral.oracleTimeout()).to.equal(ORACLE_TIMEOUT)
      expect(await cTokenCollateral.bal(owner.address)).to.equal(amt.mul(3).div(4).mul(50))
      expect(await cTokenCollateral.refPerTok()).to.equal(fp('0.02'))
      expect(await cTokenCollateral.targetPerRef()).to.equal(fp('1'))
      expect(await cTokenCollateral.pricePerTarget()).to.equal(fp('1'))
      expect(await cTokenCollateral.prevReferencePrice()).to.equal(
        await cTokenCollateral.refPerTok()
      )
      expect(await cTokenCollateral.price()).to.equal(fp('0.02'))
      calldata = compoundMock.interface.encodeFunctionData('claimComp', [owner.address])
      expect(await cTokenCollateral.connect(owner).getClaimCalldata()).to.eql([
        compoundMock.address,
        calldata,
      ])
      expect(await cTokenCollateral.rewardERC20()).to.equal(compToken.address)
    })
  })

  describe('Constructor validation', () => {
    it('Should validate targetName correctly', async () => {
      await expect(
        FiatCollateralFactory.deploy(
          await tokenCollateral.chainlinkFeed(),
          token.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.constants.HashZero,
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      ).to.be.revertedWith('targetName missing')
    })

    it('Should not allow missing defaultThreshold', async () => {
      // FiatCollateral
      await expect(
        FiatCollateralFactory.deploy(
          await tokenCollateral.chainlinkFeed(),
          token.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          bn(0),
          DELAY_UNTIL_DEFAULT
        )
      ).to.be.revertedWith('defaultThreshold zero')

      // ATokenFiatCollateral
      await expect(
        ATokenFiatCollateralFactory.deploy(
          await aTokenCollateral.chainlinkFeed(),
          aToken.address,
          aaveToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          bn(0),
          DELAY_UNTIL_DEFAULT
        )
      ).to.be.revertedWith('defaultThreshold zero')

      // CTokenFiatCollateral
      await expect(
        CTokenFiatCollateralFactory.deploy(
          await cTokenCollateral.chainlinkFeed(),
          cToken.address,
          compToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          bn(0),
          DELAY_UNTIL_DEFAULT,
          18,
          compoundMock.address
        )
      ).to.be.revertedWith('defaultThreshold zero')
    })

    it('Should not allow missing delayUntilDefault', async () => {
      await expect(
        FiatCollateralFactory.deploy(
          await tokenCollateral.chainlinkFeed(),
          token.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          bn(0)
        )
      ).to.be.revertedWith('delayUntilDefault zero')

      // ATokenFiatCollateral
      await expect(
        ATokenFiatCollateralFactory.deploy(
          await aTokenCollateral.chainlinkFeed(),
          aToken.address,
          aaveToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          bn(0)
        )
      ).to.be.revertedWith('delayUntilDefault zero')

      // CTokenFiatCollateral
      await expect(
        CTokenFiatCollateralFactory.deploy(
          await cTokenCollateral.chainlinkFeed(),
          cToken.address,
          compToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          bn(0),
          18,
          compoundMock.address
        )
      ).to.be.revertedWith('delayUntilDefault zero')
    })

    it('Should not allow missing rewardERC20 - CTokens/ATokens', async () => {
      // ATokenFiatCollateral
      await expect(
        ATokenFiatCollateralFactory.deploy(
          await aTokenCollateral.chainlinkFeed(),
          aToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      ).to.be.revertedWith('rewardERC20 missing')

      await expect(
        CTokenFiatCollateralFactory.deploy(
          await cTokenCollateral.chainlinkFeed(),
          cToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          18,
          compoundMock.address
        )
      ).to.be.revertedWith('rewardERC20 missing')
    })

    it('Should not allow missing referenceERC20Decimals - CTokens', async () => {
      // CTokenFiatCollateral
      await expect(
        CTokenFiatCollateralFactory.deploy(
          await cTokenCollateral.chainlinkFeed(),
          cToken.address,
          compToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          0,
          compoundMock.address
        )
      ).to.be.revertedWith('referenceERC20Decimals missing')
    })

    it('Should not allow missing comptrollerAddr - CTokens', async () => {
      // CTokenFiatCollateral
      await expect(
        CTokenFiatCollateralFactory.deploy(
          await cTokenCollateral.chainlinkFeed(),
          cToken.address,
          compToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          18,
          ZERO_ADDRESS
        )
      ).to.be.revertedWith('comptrollerAddr missing')
    })
  })

  describe('Prices #fast', () => {
    it('Should calculate prices correctly', async () => {
      // Check initial prices
      expect(await tokenCollateral.price()).to.equal(fp('1'))
      expect(await usdcCollateral.price()).to.equal(fp('1'))
      expect(await aTokenCollateral.price()).to.equal(fp('1'))
      expect(await cTokenCollateral.price()).to.equal(fp('0.02'))

      // Check refPerTok initial values
      expect(await tokenCollateral.refPerTok()).to.equal(fp('1'))
      expect(await usdcCollateral.refPerTok()).to.equal(fp('1'))
      expect(await aTokenCollateral.refPerTok()).to.equal(fp('1'))
      expect(await cTokenCollateral.refPerTok()).to.equal(fp('0.02'))

      // Update values in Oracles increase by 10-20%
      await setOraclePrice(tokenCollateral.address, bn('1.1e8')) // 10%
      await setOraclePrice(usdcCollateral.address, bn('1.1e8')) // 10%

      // Check new prices
      expect(await tokenCollateral.price()).to.equal(fp('1.1'))
      expect(await usdcCollateral.price()).to.equal(fp('1.1'))
      expect(await aTokenCollateral.price()).to.equal(fp('1.1'))
      expect(await cTokenCollateral.price()).to.equal(fp('0.022'))

      // Check refPerTok remains the same
      expect(await tokenCollateral.refPerTok()).to.equal(fp('1'))
      expect(await usdcCollateral.refPerTok()).to.equal(fp('1'))
      expect(await aTokenCollateral.refPerTok()).to.equal(fp('1'))
      expect(await cTokenCollateral.refPerTok()).to.equal(fp('0.02'))

      // Check RToken price
      expect(await rTokenAsset.price()).to.equal(fp('1.1'))
    })

    it('Should calculate price correctly when ATokens and CTokens appreciate', async () => {
      // Check initial prices
      expect(await aTokenCollateral.price()).to.equal(fp('1'))
      expect(await cTokenCollateral.price()).to.equal(fp('0.02'))

      // Check refPerTok initial values
      expect(await aTokenCollateral.refPerTok()).to.equal(fp('1'))
      expect(await cTokenCollateral.refPerTok()).to.equal(fp('0.02'))

      // Increase rate for Ctoken and AToken to double
      await aToken.setExchangeRate(fp(2))
      await cToken.setExchangeRate(fp(2))

      // Check prices doubled
      expect(await aTokenCollateral.price()).to.equal(fp('2'))
      expect(await cTokenCollateral.price()).to.equal(fp('0.04'))

      // RefPerTok also doubles in this case
      expect(await aTokenCollateral.refPerTok()).to.equal(fp('2'))
      expect(await cTokenCollateral.refPerTok()).to.equal(fp('0.04'))

      // Check RToken price - Remains the same until Revenues are processed
      expect(await rTokenAsset.price()).to.equal(fp('1'))
    })

    it('Should revert if price is zero', async () => {
      // Set price of token to 0 in Aave
      await setOraclePrice(tokenCollateral.address, bn('0'))

      // Check price of token
      await expect(tokenCollateral.price()).to.be.revertedWith('PriceOutsideRange()')

      // When refreshed, sets status to Unpriced
      await tokenCollateral.refresh()
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.UNPRICED)
    })

    it('Should revert in case of invalid timestamp', async () => {
      await setInvalidOracleTimestamp(tokenCollateral.address)

      // Check price of token
      await expect(tokenCollateral.price()).to.be.revertedWith('StalePrice()')

      // When refreshed, sets status to Unpriced
      await tokenCollateral.refresh()
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.UNPRICED)
    })

    it('Should calculate trade min/max correctly - Fiatcoin', async () => {
      // Check initial values
      expect(await tokenCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await tokenCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      // Update values in Oracles to 0
      await setOraclePrice(tokenCollateral.address, bn('0'))
      expect(await tokenCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await tokenCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      //  Reduce price in half - doubles min size, maintains max size
      await setOraclePrice(tokenCollateral.address, bn('0.5e8')) // half
      expect(await tokenCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt.mul(2))
      expect(await tokenCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      // Double price - still maintains min size, max size reduces in half
      await setOraclePrice(tokenCollateral.address, bn('2e8')) // double
      expect(await tokenCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await tokenCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt.div(2))

      // Handle overflow if minVal is too large
      await setOraclePrice(tokenCollateral.address, bn('0.5e8')) // half
      const invalidTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      invalidTradingRange.minVal = MAX_UINT192
      invalidTradingRange.maxVal = MAX_UINT192
      let newFiatCollateral = <FiatCollateral>(
        await FiatCollateralFactory.deploy(
          await tokenCollateral.chainlinkFeed(),
          token.address,
          ZERO_ADDRESS,
          invalidTradingRange,
          await tokenCollateral.oracleTimeout(),
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      )

      await expect(newFiatCollateral.minTradeSize()).to.be.reverted
      await expect(newFiatCollateral.maxTradeSize()).to.be.reverted

      // Check with reduced range
      const reducedTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      reducedTradingRange.maxAmt = reducedTradingRange.minAmt
      reducedTradingRange.maxVal = reducedTradingRange.minVal
      newFiatCollateral = <FiatCollateral>(
        await FiatCollateralFactory.deploy(
          await tokenCollateral.chainlinkFeed(),
          token.address,
          ZERO_ADDRESS,
          reducedTradingRange,
          await tokenCollateral.oracleTimeout(),
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      )

      // Reduce to half original price, maintains range
      await setOraclePrice(newFiatCollateral.address, bn('0.5e8')) // half
      expect(await newFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)

      // Double original price, maintains range
      await setOraclePrice(newFiatCollateral.address, bn('2e8')) // double
      expect(await newFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)
    })

    it('Should calculate trade min/max correctly - AToken', async () => {
      // Check initial values
      expect(await aTokenCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await aTokenCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      // Update values in Oracles to 0
      await setOraclePrice(aTokenCollateral.address, bn('0'))
      expect(await aTokenCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await aTokenCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      //  Reduce price in half - doubles min size, maintains max size
      await setOraclePrice(aTokenCollateral.address, bn('0.5e8')) // half
      expect(await aTokenCollateral.minTradeSize()).to.equal(
        config.rTokenTradingRange.minAmt.mul(2)
      )
      expect(await aTokenCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      // Double price - still maintains min size, max size reduces in half
      await setOraclePrice(aTokenCollateral.address, bn('2e8')) // double
      expect(await aTokenCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await aTokenCollateral.maxTradeSize()).to.equal(
        config.rTokenTradingRange.maxAmt.div(2)
      )

      // Handle overflow if minVal is too large
      await setOraclePrice(aTokenCollateral.address, bn('0.5e8')) // half
      const invalidTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      invalidTradingRange.minVal = MAX_UINT192
      invalidTradingRange.maxVal = MAX_UINT192
      let newATokenFiatCollateral = <ATokenFiatCollateral>(
        await ATokenFiatCollateralFactory.deploy(
          await aTokenCollateral.chainlinkFeed(),
          aToken.address,
          aaveToken.address,
          invalidTradingRange,
          await aTokenCollateral.oracleTimeout(),
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      )

      await expect(newATokenFiatCollateral.minTradeSize()).to.be.reverted
      await expect(newATokenFiatCollateral.maxTradeSize()).to.be.reverted

      // Check with reduced range
      const reducedTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      reducedTradingRange.maxAmt = reducedTradingRange.minAmt
      reducedTradingRange.maxVal = reducedTradingRange.minVal
      newATokenFiatCollateral = <ATokenFiatCollateral>(
        await ATokenFiatCollateralFactory.deploy(
          await aTokenCollateral.chainlinkFeed(),
          aToken.address,
          aaveToken.address,
          reducedTradingRange,
          await aTokenCollateral.oracleTimeout(),
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      )

      // Reduce to half original price, maintains range
      await setOraclePrice(newATokenFiatCollateral.address, bn('0.5e8')) // half
      expect(await newATokenFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newATokenFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)

      // Double original price, maintains range
      await setOraclePrice(newATokenFiatCollateral.address, bn('2e8')) // double
      expect(await newATokenFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newATokenFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)
    })

    it('Should calculate trade min/max correctly - CToken', async () => {
      // Set initial values used in deployment
      const cTokenTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      cTokenTradingRange.minAmt = bn(50).mul(cTokenTradingRange.minAmt)
      cTokenTradingRange.maxAmt = bn(50).mul(cTokenTradingRange.maxAmt)

      // Check initial values
      expect(await cTokenCollateral.minTradeSize()).to.equal(cTokenTradingRange.minAmt)
      expect(await cTokenCollateral.maxTradeSize()).to.equal(cTokenTradingRange.maxAmt)

      // Update values in Oracles to 0
      await setOraclePrice(cTokenCollateral.address, bn('0'))
      expect(await cTokenCollateral.minTradeSize()).to.equal(cTokenTradingRange.minAmt)
      expect(await cTokenCollateral.maxTradeSize()).to.equal(cTokenTradingRange.maxAmt)

      //  Reduce price in half - doubles min size, maintains max size
      await setOraclePrice(cTokenCollateral.address, bn('0.5e8')) // half
      expect(await cTokenCollateral.minTradeSize()).to.equal(cTokenTradingRange.minAmt.mul(2))
      expect(await cTokenCollateral.maxTradeSize()).to.equal(cTokenTradingRange.maxAmt)

      // Double price - still maintains min size, max size reduces in half
      await setOraclePrice(cTokenCollateral.address, bn('2e8')) // double
      expect(await cTokenCollateral.minTradeSize()).to.equal(cTokenTradingRange.minAmt)
      expect(await cTokenCollateral.maxTradeSize()).to.equal(cTokenTradingRange.maxAmt.div(2))

      // Handle overflow if minVal is too large
      await setOraclePrice(cTokenCollateral.address, bn('0.5e8')) // half
      const invalidTradingRange = JSON.parse(JSON.stringify(cTokenTradingRange))
      invalidTradingRange.minVal = MAX_UINT192
      invalidTradingRange.maxVal = MAX_UINT192
      let newCTokenFiatCollateral = <CTokenFiatCollateral>(
        await CTokenFiatCollateralFactory.deploy(
          await cTokenCollateral.chainlinkFeed(),
          cToken.address,
          compToken.address,
          invalidTradingRange,
          await cTokenCollateral.oracleTimeout(),
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          18,
          compoundMock.address
        )
      )

      await expect(newCTokenFiatCollateral.minTradeSize()).to.be.reverted
      await expect(newCTokenFiatCollateral.maxTradeSize()).to.be.reverted

      // Check with reduced range
      const reducedTradingRange = JSON.parse(JSON.stringify(cTokenTradingRange))
      reducedTradingRange.maxAmt = reducedTradingRange.minAmt
      reducedTradingRange.maxVal = reducedTradingRange.minVal
      newCTokenFiatCollateral = <CTokenFiatCollateral>(
        await CTokenFiatCollateralFactory.deploy(
          await cTokenCollateral.chainlinkFeed(),
          cToken.address,
          compToken.address,
          reducedTradingRange,
          await cTokenCollateral.oracleTimeout(),
          ethers.utils.formatBytes32String('USD'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          18,
          compoundMock.address
        )
      )

      // Reduce to half original price, maintains range
      await setOraclePrice(newCTokenFiatCollateral.address, bn('0.5e8')) // half
      expect(await newCTokenFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newCTokenFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)

      // Double original price, maintains range
      await setOraclePrice(newCTokenFiatCollateral.address, bn('2e8')) // double
      expect(await newCTokenFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newCTokenFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)
    })
  })

  describe('Status', () => {
    it('Should maintain status in normal situations', async () => {
      // Check initial state
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await aTokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await cTokenCollateral.status()).to.equal(CollateralStatus.SOUND)

      expect(await tokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await usdcCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await aTokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await cTokenCollateral.whenDefault()).to.equal(MAX_UINT256)

      // Force updates (with no changes)
      await expect(tokenCollateral.refresh()).to.not.emit(tokenCollateral, 'DefaultStatusChanged')
      await expect(usdcCollateral.refresh()).to.not.emit(usdcCollateral, 'DefaultStatusChanged')
      await expect(aTokenCollateral.refresh()).to.not.emit(aTokenCollateral, 'DefaultStatusChanged')
      await expect(cTokenCollateral.refresh()).to.not.emit(cTokenCollateral, 'DefaultStatusChanged')

      // State remains the same
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await aTokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await cTokenCollateral.status()).to.equal(CollateralStatus.SOUND)

      expect(await tokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await usdcCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await aTokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await cTokenCollateral.whenDefault()).to.equal(MAX_UINT256)
    })

    it('Updates status in case of soft default', async () => {
      const delayUntilDefault: BigNumber = await tokenCollateral.delayUntilDefault()

      // Check initial state
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await aTokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await cTokenCollateral.status()).to.equal(CollateralStatus.SOUND)

      expect(await tokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await usdcCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await aTokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await cTokenCollateral.whenDefault()).to.equal(MAX_UINT256)

      // Depeg one of the underlying tokens - Reducing price 20%
      // Should also impact on the aToken and cToken
      await setOraclePrice(tokenCollateral.address, bn('8e7')) // -20%

      // Force updates - Should update whenDefault and status
      let expectedDefaultTimestamp: BigNumber

      await expect(usdcCollateral.refresh()).to.not.emit(usdcCollateral, 'DefaultStatusChanged')
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await usdcCollateral.whenDefault()).to.equal(MAX_UINT256)

      const softDefaultCollaterals = [tokenCollateral, aTokenCollateral, cTokenCollateral]
      for (const coll of softDefaultCollaterals) {
        // Set next block timestamp - for deterministic result
        await setNextBlockTimestamp((await getLatestBlockTimestamp()) + 1)

        expectedDefaultTimestamp = bn(await getLatestBlockTimestamp())
          .add(1)
          .add(delayUntilDefault)

        await expect(coll.refresh())
          .to.emit(coll, 'DefaultStatusChanged')
          .withArgs(CollateralStatus.SOUND, CollateralStatus.IFFY)
        expect(await coll.status()).to.equal(CollateralStatus.IFFY)
        expect(await coll.whenDefault()).to.equal(expectedDefaultTimestamp)
      }

      // Move time forward past delayUntilDefault
      await advanceTime(Number(delayUntilDefault))
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.DISABLED)
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await aTokenCollateral.status()).to.equal(CollateralStatus.DISABLED)
      expect(await cTokenCollateral.status()).to.equal(CollateralStatus.DISABLED)

      // Nothing changes if attempt to refresh after default for ATokens/CTokens
      // AToken
      let prevWhenDefault: BigNumber = await aTokenCollateral.whenDefault()
      await expect(aTokenCollateral.refresh()).to.not.emit(aTokenCollateral, 'DefaultStatusChanged')
      expect(await aTokenCollateral.status()).to.equal(CollateralStatus.DISABLED)
      expect(await aTokenCollateral.whenDefault()).to.equal(prevWhenDefault)

      // CToken
      prevWhenDefault = await cTokenCollateral.whenDefault()
      await expect(cTokenCollateral.refresh()).to.not.emit(cTokenCollateral, 'DefaultStatusChanged')
      expect(await cTokenCollateral.status()).to.equal(CollateralStatus.DISABLED)
      expect(await cTokenCollateral.whenDefault()).to.equal(prevWhenDefault)
    })

    it('Updates status in case of hard default', async () => {
      // Check initial state
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await aTokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await cTokenCollateral.status()).to.equal(CollateralStatus.SOUND)

      expect(await tokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await usdcCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await aTokenCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await cTokenCollateral.whenDefault()).to.equal(MAX_UINT256)

      // Decrease rate for AToken and CToken, will disable collateral immediately
      await aToken.setExchangeRate(fp('0.99'))
      await cToken.setExchangeRate(fp('0.95'))

      // Force updates - Should update whenDefault and status for Atokens/CTokens
      await expect(tokenCollateral.refresh()).to.not.emit(tokenCollateral, 'DefaultStatusChanged')
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await tokenCollateral.whenDefault()).to.equal(MAX_UINT256)

      await expect(usdcCollateral.refresh()).to.not.emit(usdcCollateral, 'DefaultStatusChanged')
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await usdcCollateral.whenDefault()).to.equal(MAX_UINT256)

      const hardDefaultCollaterals = [aTokenCollateral, cTokenCollateral]
      for (const coll of hardDefaultCollaterals) {
        // Set next block timestamp - for deterministic result
        await setNextBlockTimestamp((await getLatestBlockTimestamp()) + 1)

        const expectedDefaultTimestamp: BigNumber = bn(await getLatestBlockTimestamp()).add(1)
        await expect(coll.refresh())
          .to.emit(coll, 'DefaultStatusChanged')
          .withArgs(CollateralStatus.SOUND, CollateralStatus.DISABLED)
        expect(await coll.status()).to.equal(CollateralStatus.DISABLED)
        expect(await coll.whenDefault()).to.equal(expectedDefaultTimestamp)
      }
    })

    it('Reverts if price is stale', async () => {
      await advanceTime(ORACLE_TIMEOUT.toString())

      // Check new prices
      await expect(usdcCollateral.price()).to.be.revertedWith('StalePrice()')
      await expect(tokenCollateral.price()).to.be.revertedWith('StalePrice()')
      await expect(cTokenCollateral.price()).to.be.revertedWith('StalePrice()')
      await expect(aTokenCollateral.price()).to.be.revertedWith('StalePrice()')
    })

    it('Enters UNPRICED state when price becomes stale', async () => {
      await advanceTime(ORACLE_TIMEOUT.toString())
      await usdcCollateral.refresh()
      await tokenCollateral.refresh()
      await cTokenCollateral.refresh()
      await aTokenCollateral.refresh()
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.UNPRICED)
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.UNPRICED)
      expect(await cTokenCollateral.status()).to.equal(CollateralStatus.UNPRICED)
      expect(await aTokenCollateral.status()).to.equal(CollateralStatus.UNPRICED)
    })
  })

  describe('Rewards', () => {
    it('Should claim and sweep rewards for ATokens/CTokens', async function () {
      // Set COMP and AAVE rewards for Main
      const rewardAmountCOMP: BigNumber = bn('100e18')
      const rewardAmountAAVE: BigNumber = bn('20e18')
      await compoundMock.setRewards(backingManager.address, rewardAmountCOMP)
      await aToken.setRewards(backingManager.address, rewardAmountAAVE)

      // Check funds not yet swept
      expect(await compToken.balanceOf(backingManager.address)).to.equal(0)
      expect(await aaveToken.balanceOf(backingManager.address)).to.equal(0)

      // Claim and Sweep rewards - From Main
      await facade.claimRewards(rToken.address)

      // Check rewards were transfered to BackingManager
      expect(await compToken.balanceOf(backingManager.address)).to.equal(rewardAmountCOMP)
      expect(await aaveToken.balanceOf(backingManager.address)).to.equal(rewardAmountAAVE)
    })

    it('Should handle failure in the Rewards call', async function () {
      // Set COMP reward for Main
      const rewardAmountCOMP: BigNumber = bn('100e18')
      await compoundMock.setRewards(backingManager.address, rewardAmountCOMP)

      // Check funds not yet swept
      expect(await compToken.balanceOf(backingManager.address)).to.equal(0)

      // Force call to fail, set an invalid COMP token in Comptroller
      await compoundMock.connect(owner).setCompToken(cTokenCollateral.address)
      await expect(facade.claimRewards(rToken.address)).to.be.revertedWith('rewards claim failed')

      // Check funds not yet swept
      expect(await compToken.balanceOf(backingManager.address)).to.equal(0)
      expect(await aaveToken.balanceOf(backingManager.address)).to.equal(0)
    })
  })

  // Tests specific to NonFiatCollateral.sol contract, not used by default in fixture
  describe('Non-fiat Collateral #fast', () => {
    let NonFiatCollFactory: ContractFactory
    let nonFiatCollateral: NonFiatCollateral
    let nonFiatToken: ERC20Mock
    let targetUnitOracle: MockV3Aggregator
    let referenceUnitOracle: MockV3Aggregator

    beforeEach(async () => {
      nonFiatToken = await (
        await ethers.getContractFactory('ERC20Mock')
      ).deploy('WBTC Token', 'WBTC')
      targetUnitOracle = <MockV3Aggregator>(
        await (await ethers.getContractFactory('MockV3Aggregator')).deploy(8, bn('20000e8')) // $20k
      )
      referenceUnitOracle = <MockV3Aggregator>(
        await (await ethers.getContractFactory('MockV3Aggregator')).deploy(8, bn('1e8')) // 1 WBTC/BTC
      )

      NonFiatCollFactory = await ethers.getContractFactory('NonFiatCollateral', {
        libraries: { OracleLib: oracleLib.address },
      })

      nonFiatCollateral = <NonFiatCollateral>(
        await NonFiatCollFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          nonFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      )

      // Mint some tokens
      await nonFiatToken.connect(owner).mint(owner.address, amt)
    })

    it('Should not allow missing defaultThreshold', async () => {
      await expect(
        NonFiatCollFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          nonFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          bn(0),
          DELAY_UNTIL_DEFAULT
        )
      ).to.be.revertedWith('defaultThreshold zero')
    })

    it('Should not allow missing delayUntilDefault', async () => {
      await expect(
        NonFiatCollFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          nonFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          bn(0)
        )
      ).to.be.revertedWith('delayUntilDefault zero')
    })

    it('Should not allow missing uoaPerTargetFeed', async () => {
      await expect(
        NonFiatCollFactory.deploy(
          referenceUnitOracle.address,
          ZERO_ADDRESS,
          nonFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      ).to.be.revertedWith('missing uoaPerTarget feed')
    })

    it('Should not allow missing targetPerRefFeed', async () => {
      await expect(
        NonFiatCollFactory.deploy(
          ZERO_ADDRESS,
          targetUnitOracle.address,
          nonFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      ).to.be.revertedWith('missing chainlink feed')
    })

    it('Should setup collateral correctly', async function () {
      // Non-Fiat Token
      expect(await nonFiatCollateral.isCollateral()).to.equal(true)
      expect(await nonFiatCollateral.uoaPerTargetFeed()).to.equal(targetUnitOracle.address)
      expect(await nonFiatCollateral.chainlinkFeed()).to.equal(referenceUnitOracle.address)
      expect(await nonFiatCollateral.erc20()).to.equal(nonFiatToken.address)
      expect(await nonFiatToken.decimals()).to.equal(18) // Due to Mock, wbtc has 8 decimals (covered in integration test)
      expect(await nonFiatCollateral.targetName()).to.equal(ethers.utils.formatBytes32String('BTC'))
      // Get priceable info
      await nonFiatCollateral.refresh()
      expect(await nonFiatCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await nonFiatCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await nonFiatCollateral.defaultThreshold()).to.equal(DEFAULT_THRESHOLD)
      expect(await nonFiatCollateral.delayUntilDefault()).to.equal(DELAY_UNTIL_DEFAULT)
      expect(await nonFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await nonFiatCollateral.maxTradeSize()).to.equal(
        config.rTokenTradingRange.maxAmt.div(20000)
      )
      expect(await nonFiatCollateral.oracleTimeout()).to.equal(ORACLE_TIMEOUT)
      expect(await nonFiatCollateral.bal(owner.address)).to.equal(amt)
      expect(await nonFiatCollateral.refPerTok()).to.equal(fp('1'))
      expect(await nonFiatCollateral.targetPerRef()).to.equal(fp('1'))
      expect(await nonFiatCollateral.pricePerTarget()).to.equal(fp('20000'))
      expect(await nonFiatCollateral.price()).to.equal(fp('20000'))
      expect(await nonFiatCollateral.getClaimCalldata()).to.eql([ZERO_ADDRESS, '0x'])
      expect(await nonFiatCollateral.rewardERC20()).to.equal(ZERO_ADDRESS)
    })

    it('Should calculate prices correctly', async function () {
      // Check initial prices
      expect(await nonFiatCollateral.price()).to.equal(fp('20000'))

      // Update values in Oracle increase by 10%
      await targetUnitOracle.updateAnswer(bn('22000e8')) // $22k

      // Check new prices
      expect(await nonFiatCollateral.price()).to.equal(fp('22000'))

      // Revert if price is zero - Update Oracles and check prices
      await targetUnitOracle.updateAnswer(bn('0'))
      await expect(nonFiatCollateral.price()).to.be.revertedWith('PriceOutsideRange()')

      // When refreshed, sets status to Unpriced
      await nonFiatCollateral.refresh()
      expect(await nonFiatCollateral.status()).to.equal(CollateralStatus.UNPRICED)

      // Restore price
      await targetUnitOracle.updateAnswer(bn('20000e8'))
      await nonFiatCollateral.refresh()
      expect(await nonFiatCollateral.status()).to.equal(CollateralStatus.SOUND)

      // Check the other oracle
      await referenceUnitOracle.updateAnswer(bn('0'))
      await expect(nonFiatCollateral.price()).to.be.revertedWith('PriceOutsideRange()')

      // When refreshed, sets status to Unpriced
      await nonFiatCollateral.refresh()
      expect(await nonFiatCollateral.status()).to.equal(CollateralStatus.UNPRICED)
    })

    it('Should calculate trade min/max correctly', async () => {
      // Check initial values
      expect(await nonFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt) // minVal for 20K is below minAmt
      expect(await nonFiatCollateral.maxTradeSize()).to.equal(
        config.rTokenTradingRange.maxVal.mul(BN_SCALE_FACTOR).div(fp('20000'))
      )

      //  Update values in Oracles to 0
      await referenceUnitOracle.updateAnswer(bn('0'))
      expect(await nonFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await nonFiatCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)
      await referenceUnitOracle.updateAnswer(bn('1e8'))

      await targetUnitOracle.updateAnswer(bn('0'))
      expect(await nonFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await nonFiatCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      // Reduce price significantly for calculations
      await targetUnitOracle.updateAnswer(bn('1e8'))
      expect(await nonFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await nonFiatCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      // Reduce previous price in half - still keeping it low for calculations
      await targetUnitOracle.updateAnswer(bn('0.5e8'))
      expect(await nonFiatCollateral.minTradeSize()).to.equal(
        config.rTokenTradingRange.minAmt.mul(2)
      )
      expect(await nonFiatCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      //  Double price - still keeping it low to check validations
      await targetUnitOracle.updateAnswer(bn('2e8'))
      expect(await nonFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await nonFiatCollateral.maxTradeSize()).to.equal(
        config.rTokenTradingRange.maxAmt.div(2)
      )

      // Handle overflow if minVal is too large
      await targetUnitOracle.updateAnswer(bn('0.5e8'))
      const invalidTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      invalidTradingRange.minVal = MAX_UINT192
      invalidTradingRange.maxVal = MAX_UINT192
      let newNonFiatCollateral = <NonFiatCollateral>(
        await NonFiatCollFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          nonFiatToken.address,
          ZERO_ADDRESS,
          invalidTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      )
      await expect(newNonFiatCollateral.minTradeSize()).to.be.reverted
      await expect(newNonFiatCollateral.maxTradeSize()).to.be.reverted

      // Check with reduced range
      const reducedTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      reducedTradingRange.maxAmt = reducedTradingRange.minAmt
      reducedTradingRange.maxVal = reducedTradingRange.minVal
      newNonFiatCollateral = <NonFiatCollateral>(
        await NonFiatCollFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          nonFiatToken.address,
          ZERO_ADDRESS,
          reducedTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      )

      // Adapt price for calculations
      await targetUnitOracle.updateAnswer(bn('0.5e8'))
      expect(await newNonFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newNonFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)

      // Double price, maintains range
      await targetUnitOracle.updateAnswer(bn('2e8'))
      expect(await newNonFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newNonFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)
    })
  })

  // Tests specific to CTokenNonFiatCollateral.sol contract, not used by default in fixture
  describe('CToken Non-fiat Collateral #fast', () => {
    let CTokenNonFiatFactory: ContractFactory
    let cTokenNonFiatCollateral: CTokenNonFiatCollateral
    let nonFiatToken: ERC20Mock
    let cNonFiatToken: CTokenMock
    let targetUnitOracle: MockV3Aggregator
    let referenceUnitOracle: MockV3Aggregator
    let cTokenTradingRange: TradingRange

    beforeEach(async () => {
      nonFiatToken = await (
        await ethers.getContractFactory('ERC20Mock')
      ).deploy('WBTC Token', 'WBTC')

      targetUnitOracle = <MockV3Aggregator>(
        await (await ethers.getContractFactory('MockV3Aggregator')).deploy(8, bn('20000e8')) // $20k
      )
      referenceUnitOracle = <MockV3Aggregator>(
        await (await ethers.getContractFactory('MockV3Aggregator')).deploy(8, bn('1e8')) // 1 WBTC/BTC
      )
      // cToken
      cNonFiatToken = await (
        await ethers.getContractFactory('CTokenMock')
      ).deploy('cWBTC Token', 'cWBTC', nonFiatToken.address)

      cTokenTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      cTokenTradingRange.minAmt = bn(50).mul(cTokenTradingRange.minAmt)
      cTokenTradingRange.maxAmt = bn(50).mul(cTokenTradingRange.maxAmt)

      CTokenNonFiatFactory = await ethers.getContractFactory('CTokenNonFiatCollateral', {
        libraries: { OracleLib: oracleLib.address },
      })

      cTokenNonFiatCollateral = <CTokenNonFiatCollateral>(
        await CTokenNonFiatFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          cNonFiatToken.address,
          compToken.address,
          cTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          await nonFiatToken.decimals(),
          compoundMock.address
        )
      )

      // Mint some tokens
      await cNonFiatToken.connect(owner).mint(owner.address, amt.div(bn('1e10')))
    })

    it('Should not allow missing defaultThreshold', async () => {
      await expect(
        CTokenNonFiatFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          cNonFiatToken.address,
          compToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          bn(0),
          DELAY_UNTIL_DEFAULT,
          18,
          compoundMock.address
        )
      ).to.be.revertedWith('defaultThreshold zero')
    })

    it('Should not allow missing delayUntilDefault', async () => {
      await expect(
        CTokenNonFiatFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          cNonFiatToken.address,
          compToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          bn(0),
          18,
          compoundMock.address
        )
      ).to.be.revertedWith('delayUntilDefault zero')
    })

    it('Should not allow missing refUnitChainlinkFeed', async () => {
      await expect(
        CTokenNonFiatFactory.deploy(
          ZERO_ADDRESS,
          targetUnitOracle.address,
          cNonFiatToken.address,
          compToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          18,
          compoundMock.address
        )
      ).to.be.revertedWith('missing chainlink feed')
    })

    it('Should not allow missing targetUnitChainlinkFeed', async () => {
      await expect(
        CTokenNonFiatFactory.deploy(
          referenceUnitOracle.address,
          ZERO_ADDRESS,
          cNonFiatToken.address,
          compToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          18,
          compoundMock.address
        )
      ).to.be.revertedWith('missing target unit chainlink feed')
    })

    it('Should not allow missing rewardERC20', async () => {
      await expect(
        CTokenNonFiatFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          cNonFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          await nonFiatToken.decimals(),
          compoundMock.address
        )
      ).to.be.revertedWith('rewardERC20 missing')
    })

    it('Should not allow missing referenceERC20Decimals', async () => {
      await expect(
        CTokenNonFiatFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          cNonFiatToken.address,
          compToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          0,
          compoundMock.address
        )
      ).to.be.revertedWith('referenceERC20Decimals missing')
    })

    it('Should not allow missing comptrollerAddr', async () => {
      await expect(
        CTokenNonFiatFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,

          cNonFiatToken.address,
          compToken.address,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          18,
          ZERO_ADDRESS
        )
      ).to.be.revertedWith('comptrollerAddr missing')
    })

    it('Should setup collateral correctly', async function () {
      // Non-Fiat Token
      expect(await cTokenNonFiatCollateral.isCollateral()).to.equal(true)
      expect(await cTokenNonFiatCollateral.targetUnitChainlinkFeed()).to.equal(
        targetUnitOracle.address
      )
      expect(await cTokenNonFiatCollateral.chainlinkFeed()).to.equal(referenceUnitOracle.address)
      expect(await cTokenNonFiatCollateral.referenceERC20Decimals()).to.equal(18)
      expect(await cTokenNonFiatCollateral.erc20()).to.equal(cNonFiatToken.address)
      expect(await cNonFiatToken.decimals()).to.equal(8)
      expect(await cTokenNonFiatCollateral.targetName()).to.equal(
        ethers.utils.formatBytes32String('BTC')
      )

      // Get priceable info
      await cTokenNonFiatCollateral.refresh()

      expect(await cTokenNonFiatCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await cTokenNonFiatCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await cTokenNonFiatCollateral.defaultThreshold()).to.equal(DEFAULT_THRESHOLD)
      expect(await cTokenNonFiatCollateral.delayUntilDefault()).to.equal(DELAY_UNTIL_DEFAULT)
      expect(await cTokenNonFiatCollateral.minTradeSize()).to.equal(
        bn(50).mul(config.rTokenTradingRange.minAmt)
      )
      expect(await cTokenNonFiatCollateral.maxTradeSize()).to.equal(
        bn(50).mul(config.rTokenTradingRange.maxVal).div(20000)
      )
      expect(await cTokenNonFiatCollateral.oracleTimeout()).to.equal(ORACLE_TIMEOUT)
      expect(await cTokenNonFiatCollateral.bal(owner.address)).to.equal(amt)
      expect(await cTokenNonFiatCollateral.refPerTok()).to.equal(fp('0.02'))
      expect(await cTokenNonFiatCollateral.targetPerRef()).to.equal(fp('1'))
      expect(await cTokenNonFiatCollateral.pricePerTarget()).to.equal(fp('20000'))
      expect(await cTokenNonFiatCollateral.prevReferencePrice()).to.equal(
        await cTokenNonFiatCollateral.refPerTok()
      )

      expect(await cTokenNonFiatCollateral.price()).to.equal(fp('400')) // 0.02 of 20K
      const calldata = compoundMock.interface.encodeFunctionData('claimComp', [owner.address])
      expect(await cTokenNonFiatCollateral.connect(owner).getClaimCalldata()).to.eql([
        compoundMock.address,
        calldata,
      ])
      expect(await cTokenNonFiatCollateral.rewardERC20()).to.equal(compToken.address)
    })

    it('Should calculate prices correctly', async function () {
      expect(await cTokenNonFiatCollateral.price()).to.equal(fp('400'))

      // Check refPerTok initial values
      expect(await cTokenNonFiatCollateral.refPerTok()).to.equal(fp('0.02'))

      // Increase rate to double
      await cNonFiatToken.setExchangeRate(fp(2))

      // Check price doubled
      expect(await cTokenNonFiatCollateral.price()).to.equal(fp('800'))

      // RefPerTok also doubles in this case
      expect(await cTokenNonFiatCollateral.refPerTok()).to.equal(fp('0.04'))

      // Update values in Oracle increase by 10%
      await targetUnitOracle.updateAnswer(bn('22000e8')) // $22k

      // Check new price
      expect(await cTokenNonFiatCollateral.price()).to.equal(fp('880'))

      // Revert if price is zero - Update Oracles and check prices
      await targetUnitOracle.updateAnswer(bn('0'))
      await expect(cTokenNonFiatCollateral.price()).to.be.revertedWith('PriceOutsideRange()')

      // When refreshed, sets status to Unpriced
      await cTokenNonFiatCollateral.refresh()
      expect(await cTokenNonFiatCollateral.status()).to.equal(CollateralStatus.UNPRICED)
      // Restore
      await targetUnitOracle.updateAnswer(bn('22000e8'))
      await cTokenNonFiatCollateral.refresh()
      expect(await cTokenNonFiatCollateral.status()).to.equal(CollateralStatus.SOUND)

      // Revert if price is zero - Update the other Oracle
      await referenceUnitOracle.updateAnswer(bn('0'))
      await expect(cTokenNonFiatCollateral.price()).to.be.revertedWith('PriceOutsideRange()')

      // When refreshed, sets status to Unpriced
      await cTokenNonFiatCollateral.refresh()
      expect(await cTokenNonFiatCollateral.status()).to.equal(CollateralStatus.UNPRICED)
    })

    it('Should calculate trade min/max correctly', async () => {
      // Check initial values
      expect(await cTokenNonFiatCollateral.minTradeSize()).to.equal(cTokenTradingRange.minAmt)
      expect(await cTokenNonFiatCollateral.maxTradeSize()).to.equal(
        cTokenTradingRange.maxAmt.mul(BN_SCALE_FACTOR).div(fp('20000'))
      )

      //  Update values in Oracles to 0
      await referenceUnitOracle.updateAnswer(bn('0'))
      expect(await cTokenNonFiatCollateral.minTradeSize()).to.equal(cTokenTradingRange.minAmt)
      expect(await cTokenNonFiatCollateral.maxTradeSize()).to.equal(cTokenTradingRange.maxAmt)
      await referenceUnitOracle.updateAnswer(bn('1e8'))

      await targetUnitOracle.updateAnswer(bn('0'))
      expect(await cTokenNonFiatCollateral.minTradeSize()).to.equal(cTokenTradingRange.minAmt)
      expect(await cTokenNonFiatCollateral.maxTradeSize()).to.equal(cTokenTradingRange.maxAmt)

      // Reduce price significantly for calculations
      await targetUnitOracle.updateAnswer(bn('1e8'))
      expect(await cTokenNonFiatCollateral.minTradeSize()).to.equal(cTokenTradingRange.minAmt)
      expect(await cTokenNonFiatCollateral.maxTradeSize()).to.equal(cTokenTradingRange.maxAmt)

      // Reduce price in half - still keeping it low for calculations
      await targetUnitOracle.updateAnswer(bn('0.5e8'))
      expect(await cTokenNonFiatCollateral.minTradeSize()).to.equal(
        cTokenTradingRange.minAmt.mul(2)
      )
      expect(await cTokenNonFiatCollateral.maxTradeSize()).to.equal(cTokenTradingRange.maxAmt)

      //  Double price - still keeping it low to check validations
      await targetUnitOracle.updateAnswer(bn('2e8'))
      expect(await cTokenNonFiatCollateral.minTradeSize()).to.equal(cTokenTradingRange.minAmt)
      expect(await cTokenNonFiatCollateral.maxTradeSize()).to.equal(
        cTokenTradingRange.maxAmt.div(2)
      )

      // Handle overflow if minVal is too large
      await targetUnitOracle.updateAnswer(bn('0.5e8'))
      const invalidTradingRange = JSON.parse(JSON.stringify(cTokenTradingRange))
      invalidTradingRange.minVal = MAX_UINT192
      invalidTradingRange.maxVal = MAX_UINT192
      let newCTokenNonFiatCollateral = <CTokenNonFiatCollateral>(
        await CTokenNonFiatFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          cNonFiatToken.address,
          compToken.address,
          invalidTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          await nonFiatToken.decimals(),
          compoundMock.address
        )
      )
      await expect(newCTokenNonFiatCollateral.minTradeSize()).to.be.reverted
      await expect(newCTokenNonFiatCollateral.maxTradeSize()).to.be.reverted

      // Check with reduced range
      const reducedTradingRange = JSON.parse(JSON.stringify(cTokenTradingRange))
      reducedTradingRange.maxAmt = reducedTradingRange.minAmt
      reducedTradingRange.maxVal = reducedTradingRange.minVal
      newCTokenNonFiatCollateral = <CTokenNonFiatCollateral>(
        await CTokenNonFiatFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          cNonFiatToken.address,
          compToken.address,
          reducedTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('BTC'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT,
          await nonFiatToken.decimals(),
          compoundMock.address
        )
      )

      // Adapt price for calculations
      await targetUnitOracle.updateAnswer(bn('0.5e8'))
      expect(await newCTokenNonFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newCTokenNonFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)

      // Double price, maintains range
      await targetUnitOracle.updateAnswer(bn('2e8'))
      expect(await newCTokenNonFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newCTokenNonFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)
    })
  })

  // Tests specific to SelfReferentialCollateral.sol contract, not used by default in fixture
  describe('Self-Referential Collateral #fast', () => {
    let SelfRefCollateralFactory: ContractFactory
    let selfReferentialCollateral: SelfReferentialCollateral
    let selfRefToken: WETH9
    let chainlinkFeed: MockV3Aggregator
    beforeEach(async () => {
      selfRefToken = await (await ethers.getContractFactory('WETH9')).deploy()
      chainlinkFeed = <MockV3Aggregator>(
        await (await ethers.getContractFactory('MockV3Aggregator')).deploy(8, bn('1e8'))
      )

      SelfRefCollateralFactory = await ethers.getContractFactory('SelfReferentialCollateral', {
        libraries: { OracleLib: oracleLib.address },
      })

      selfReferentialCollateral = <SelfReferentialCollateral>(
        await SelfRefCollateralFactory.deploy(
          chainlinkFeed.address,
          selfRefToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('ETH')
        )
      )
    })

    it('Should setup collateral correctly', async function () {
      // Self-referential Collateral
      expect(await selfReferentialCollateral.isCollateral()).to.equal(true)
      expect(await selfReferentialCollateral.chainlinkFeed()).to.equal(chainlinkFeed.address)
      expect(await selfReferentialCollateral.erc20()).to.equal(selfRefToken.address)
      expect(await selfRefToken.decimals()).to.equal(18)
      expect(await selfReferentialCollateral.targetName()).to.equal(
        ethers.utils.formatBytes32String('ETH')
      )
      // Get priceable info
      await selfReferentialCollateral.refresh()
      expect(await selfReferentialCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await selfReferentialCollateral.minTradeSize()).to.equal(
        config.rTokenTradingRange.minAmt
      )
      expect(await selfReferentialCollateral.maxTradeSize()).to.equal(
        config.rTokenTradingRange.maxAmt
      )
      expect(await selfReferentialCollateral.oracleTimeout()).to.equal(ORACLE_TIMEOUT)
      expect(await selfReferentialCollateral.bal(owner.address)).to.equal(0)
      expect(await selfReferentialCollateral.refPerTok()).to.equal(fp('1'))
      expect(await selfReferentialCollateral.targetPerRef()).to.equal(fp('1'))
      expect(await selfReferentialCollateral.pricePerTarget()).to.equal(fp('1'))
      expect(await selfReferentialCollateral.price()).to.equal(fp('1'))
      expect(await selfReferentialCollateral.getClaimCalldata()).to.eql([ZERO_ADDRESS, '0x'])
      expect(await selfReferentialCollateral.rewardERC20()).to.equal(ZERO_ADDRESS)
    })

    it('Should calculate prices correctly', async function () {
      // Check initial prices
      expect(await selfReferentialCollateral.price()).to.equal(fp('1'))

      // Update values in Oracle increase by 10%
      await setOraclePrice(selfReferentialCollateral.address, bn('1.1e8'))

      // Check new prices
      expect(await selfReferentialCollateral.price()).to.equal(fp('1.1'))

      // Revert if price is zero - Update Oracles and check prices
      await setOraclePrice(selfReferentialCollateral.address, bn(0))
      await expect(selfReferentialCollateral.price()).to.be.revertedWith('PriceOutsideRange()')

      // When refreshed, sets status to Unpriced
      await selfReferentialCollateral.refresh()
      expect(await selfReferentialCollateral.status()).to.equal(CollateralStatus.UNPRICED)
    })

    it('Should calculate trade min/max correctly', async () => {
      // Check initial values
      expect(await selfReferentialCollateral.minTradeSize()).to.equal(
        config.rTokenTradingRange.minAmt
      )
      expect(await selfReferentialCollateral.maxTradeSize()).to.equal(
        config.rTokenTradingRange.maxAmt
      )

      //  Update values in Oracle to 0
      await setOraclePrice(selfReferentialCollateral.address, bn('0'))
      expect(await selfReferentialCollateral.minTradeSize()).to.equal(
        config.rTokenTradingRange.minAmt
      )
      expect(await selfReferentialCollateral.maxTradeSize()).to.equal(
        config.rTokenTradingRange.maxAmt
      )

      // Reduce previous price in half
      await setOraclePrice(selfReferentialCollateral.address, bn('0.5e8'))
      expect(await selfReferentialCollateral.minTradeSize()).to.equal(
        config.rTokenTradingRange.minAmt.mul(2)
      )
      expect(await selfReferentialCollateral.maxTradeSize()).to.equal(
        config.rTokenTradingRange.maxAmt
      )

      //  Double price
      await setOraclePrice(selfReferentialCollateral.address, bn('2e8'))
      expect(await selfReferentialCollateral.minTradeSize()).to.equal(
        config.rTokenTradingRange.minAmt
      )
      expect(await selfReferentialCollateral.maxTradeSize()).to.equal(
        config.rTokenTradingRange.maxAmt.div(2)
      )

      // Handle overflow if minVal is too large
      await setOraclePrice(selfReferentialCollateral.address, bn('0.5e8'))
      const invalidTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      invalidTradingRange.minVal = MAX_UINT192
      invalidTradingRange.maxVal = MAX_UINT192
      let newSelfRefCollateral = <SelfReferentialCollateral>(
        await SelfRefCollateralFactory.deploy(
          chainlinkFeed.address,
          selfRefToken.address,
          ZERO_ADDRESS,
          invalidTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('ETH')
        )
      )
      await expect(newSelfRefCollateral.minTradeSize()).to.be.reverted
      await expect(newSelfRefCollateral.maxTradeSize()).to.be.reverted

      // Check with reduced range
      const reducedTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      reducedTradingRange.maxAmt = reducedTradingRange.minAmt
      reducedTradingRange.maxVal = reducedTradingRange.minVal
      newSelfRefCollateral = <SelfReferentialCollateral>(
        await SelfRefCollateralFactory.deploy(
          chainlinkFeed.address,
          selfRefToken.address,
          ZERO_ADDRESS,
          reducedTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('ETH')
        )
      )

      // Set price for calculations
      await setOraclePrice(newSelfRefCollateral.address, bn('0.5e8'))
      expect(await newSelfRefCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newSelfRefCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)

      // Double price, maintains range
      await setOraclePrice(newSelfRefCollateral.address, bn('2e8'))
      expect(await newSelfRefCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newSelfRefCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)
    })
  })

  // Tests specific to CTokenSelfReferentialCollateral.sol contract, not used by default in fixture
  describe('CToken Self-Referential Collateral #fast', () => {
    let CTokenSelfReferentialFactory: ContractFactory
    let cTokenSelfReferentialCollateral: CTokenSelfReferentialCollateral
    let selfRefToken: WETH9
    let cSelfRefToken: CTokenMock
    let chainlinkFeed: MockV3Aggregator
    let cTokenTradingRange: TradingRange

    beforeEach(async () => {
      selfRefToken = await (await ethers.getContractFactory('WETH9')).deploy()
      chainlinkFeed = <MockV3Aggregator>(
        await (await ethers.getContractFactory('MockV3Aggregator')).deploy(8, bn('1e8'))
      )

      cTokenTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      cTokenTradingRange.minAmt = bn(50).mul(cTokenTradingRange.minAmt)
      cTokenTradingRange.maxAmt = bn(50).mul(cTokenTradingRange.maxAmt)

      // cToken Self Ref
      cSelfRefToken = await (
        await ethers.getContractFactory('CTokenMock')
      ).deploy('cETH Token', 'cETH', selfRefToken.address)

      CTokenSelfReferentialFactory = await ethers.getContractFactory(
        'CTokenSelfReferentialCollateral',
        {
          libraries: { OracleLib: oracleLib.address },
        }
      )

      cTokenSelfReferentialCollateral = <CTokenSelfReferentialCollateral>(
        await CTokenSelfReferentialFactory.deploy(
          chainlinkFeed.address,
          cSelfRefToken.address,
          compToken.address,
          cTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('ETH'),
          await selfRefToken.decimals(),
          compoundMock.address
        )
      )

      // Mint some tokens
      await cSelfRefToken.connect(owner).mint(owner.address, amt.div(bn('1e10')))
    })

    it('Should not allow missing rewardERC20', async () => {
      await expect(
        CTokenSelfReferentialFactory.deploy(
          chainlinkFeed.address,
          cSelfRefToken.address,
          ZERO_ADDRESS,
          cTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('ETH'),
          await selfRefToken.decimals(),
          compoundMock.address
        )
      ).to.be.revertedWith('rewardERC20 missing')
    })

    it('Should not allow missing referenceERC20Decimals', async () => {
      await expect(
        CTokenSelfReferentialFactory.deploy(
          chainlinkFeed.address,
          cSelfRefToken.address,
          compToken.address,
          cTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('ETH'),
          0,
          compoundMock.address
        )
      ).to.be.revertedWith('referenceERC20Decimals missing')
    })

    it('Should not allow missing comptrollerAddr', async () => {
      await expect(
        CTokenSelfReferentialFactory.deploy(
          chainlinkFeed.address,
          cSelfRefToken.address,
          compToken.address,
          cTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('ETH'),
          18,
          ZERO_ADDRESS
        )
      ).to.be.revertedWith('comptrollerAddr missing')
    })

    it('Should setup collateral correctly', async function () {
      // Self-referential Collateral
      expect(await cTokenSelfReferentialCollateral.isCollateral()).to.equal(true)
      expect(await cTokenSelfReferentialCollateral.chainlinkFeed()).to.equal(chainlinkFeed.address)
      expect(await cTokenSelfReferentialCollateral.referenceERC20Decimals()).to.equal(18)
      expect(await cTokenSelfReferentialCollateral.erc20()).to.equal(cSelfRefToken.address)
      expect(await cSelfRefToken.decimals()).to.equal(8)
      expect(await cTokenSelfReferentialCollateral.targetName()).to.equal(
        ethers.utils.formatBytes32String('ETH')
      )
      // Get priceable info
      await cTokenSelfReferentialCollateral.refresh()
      expect(await cTokenSelfReferentialCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await cTokenSelfReferentialCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await cTokenSelfReferentialCollateral.minTradeSize()).to.equal(
        bn(50).mul(config.rTokenTradingRange.minAmt)
      )
      expect(await cTokenSelfReferentialCollateral.maxTradeSize()).to.equal(
        bn(50).mul(config.rTokenTradingRange.maxAmt)
      )
      expect(await cTokenSelfReferentialCollateral.oracleTimeout()).to.equal(ORACLE_TIMEOUT)
      expect(await cTokenSelfReferentialCollateral.bal(owner.address)).to.equal(amt)
      expect(await cTokenSelfReferentialCollateral.refPerTok()).to.equal(fp('0.02'))
      expect(await cTokenSelfReferentialCollateral.targetPerRef()).to.equal(fp('1'))
      expect(await cTokenSelfReferentialCollateral.pricePerTarget()).to.equal(fp('1'))
      expect(await cTokenSelfReferentialCollateral.prevReferencePrice()).to.equal(
        await cTokenSelfReferentialCollateral.refPerTok()
      )

      expect(await cTokenSelfReferentialCollateral.price()).to.equal(fp('0.02'))
      const calldata = compoundMock.interface.encodeFunctionData('claimComp', [owner.address])
      expect(await cTokenSelfReferentialCollateral.connect(owner).getClaimCalldata()).to.eql([
        compoundMock.address,
        calldata,
      ])
      expect(await cTokenSelfReferentialCollateral.rewardERC20()).to.equal(compToken.address)
    })

    it('Should calculate prices correctly', async function () {
      expect(await cTokenSelfReferentialCollateral.price()).to.equal(fp('0.02'))

      // Check refPerTok initial values
      expect(await cTokenSelfReferentialCollateral.refPerTok()).to.equal(fp('0.02'))

      // Increase rate to double
      await cSelfRefToken.setExchangeRate(fp(2))

      // Check price doubled
      expect(await cTokenSelfReferentialCollateral.price()).to.equal(fp('0.04'))

      // RefPerTok also doubles in this case
      expect(await cTokenSelfReferentialCollateral.refPerTok()).to.equal(fp('0.04'))

      // Update values in Oracle increase by 10%
      await setOraclePrice(cTokenSelfReferentialCollateral.address, bn('1.1e8'))

      // Check new prices
      expect(await cTokenSelfReferentialCollateral.price()).to.equal(fp('0.044'))

      // Revert if price is zero - Update Oracles and check prices
      await setOraclePrice(cTokenSelfReferentialCollateral.address, bn(0))
      await expect(cTokenSelfReferentialCollateral.price()).to.be.revertedWith(
        'PriceOutsideRange()'
      )

      // When refreshed, sets status to Unpriced
      await cTokenSelfReferentialCollateral.refresh()
      expect(await cTokenSelfReferentialCollateral.status()).to.equal(CollateralStatus.UNPRICED)
    })

    it('Should calculate trade min/max correctly', async () => {
      // Check initial values
      expect(await cTokenSelfReferentialCollateral.minTradeSize()).to.equal(
        cTokenTradingRange.minAmt
      )
      expect(await cTokenSelfReferentialCollateral.maxTradeSize()).to.equal(
        cTokenTradingRange.maxAmt
      )

      // Update values in Oracles to 0
      await setOraclePrice(cTokenSelfReferentialCollateral.address, bn('0'))
      expect(await cTokenSelfReferentialCollateral.minTradeSize()).to.equal(
        cTokenTradingRange.minAmt
      )
      expect(await cTokenSelfReferentialCollateral.maxTradeSize()).to.equal(
        cTokenTradingRange.maxAmt
      )

      // Set price
      await setOraclePrice(cTokenSelfReferentialCollateral.address, bn('1e8'))
      expect(await cTokenSelfReferentialCollateral.minTradeSize()).to.equal(
        cTokenTradingRange.minAmt
      )
      expect(await cTokenSelfReferentialCollateral.maxTradeSize()).to.equal(
        cTokenTradingRange.maxAmt
      )

      // Reduce price in half
      await setOraclePrice(cTokenSelfReferentialCollateral.address, bn('0.5e8'))
      expect(await cTokenSelfReferentialCollateral.minTradeSize()).to.equal(
        cTokenTradingRange.minAmt.mul(2)
      )
      expect(await cTokenSelfReferentialCollateral.maxTradeSize()).to.equal(
        cTokenTradingRange.maxAmt
      )

      //  Double price
      await setOraclePrice(cTokenSelfReferentialCollateral.address, bn('2e8'))
      expect(await cTokenSelfReferentialCollateral.minTradeSize()).to.equal(
        cTokenTradingRange.minAmt
      )
      expect(await cTokenSelfReferentialCollateral.maxTradeSize()).to.equal(
        cTokenTradingRange.maxAmt.div(2)
      )

      // Handle overflow if minVal is too large
      await setOraclePrice(cTokenSelfReferentialCollateral.address, bn('0.5e8'))
      const invalidTradingRange = JSON.parse(JSON.stringify(cTokenTradingRange))
      invalidTradingRange.minVal = MAX_UINT192
      invalidTradingRange.maxVal = MAX_UINT192
      let newCTokenSelfRefCollateral = <CTokenSelfReferentialCollateral>(
        await CTokenSelfReferentialFactory.deploy(
          chainlinkFeed.address,
          cSelfRefToken.address,
          compToken.address,
          invalidTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('ETH'),
          await selfRefToken.decimals(),
          compoundMock.address
        )
      )
      await expect(newCTokenSelfRefCollateral.minTradeSize()).to.be.reverted
      await expect(newCTokenSelfRefCollateral.maxTradeSize()).to.be.reverted

      // Check with reduced range
      const reducedTradingRange = JSON.parse(JSON.stringify(cTokenTradingRange))
      reducedTradingRange.maxAmt = reducedTradingRange.minAmt
      reducedTradingRange.maxVal = reducedTradingRange.minVal
      newCTokenSelfRefCollateral = <CTokenSelfReferentialCollateral>(
        await CTokenSelfReferentialFactory.deploy(
          chainlinkFeed.address,
          cSelfRefToken.address,
          compToken.address,
          reducedTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('ETH'),
          await selfRefToken.decimals(),
          compoundMock.address
        )
      )

      // Adapt price for calculations
      await setOraclePrice(newCTokenSelfRefCollateral.address, bn('0.5e8'))
      expect(await newCTokenSelfRefCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newCTokenSelfRefCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)

      // Double price, maintains range
      await setOraclePrice(newCTokenSelfRefCollateral.address, bn('2e8'))
      expect(await newCTokenSelfRefCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newCTokenSelfRefCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)
    })
  })

  // Tests specific to EURFiatCollateral.sol contract, not used by default in fixture
  describe('EUR fiat Collateral #fast', () => {
    let EURFiatCollateralFactory: ContractFactory
    let eurFiatCollateral: EURFiatCollateral
    let eurFiatToken: ERC20Mock
    let targetUnitOracle: MockV3Aggregator
    let referenceUnitOracle: MockV3Aggregator

    beforeEach(async () => {
      eurFiatToken = await (
        await ethers.getContractFactory('ERC20Mock')
      ).deploy('EUR Token', 'EURT')
      targetUnitOracle = <MockV3Aggregator>(
        await (await ethers.getContractFactory('MockV3Aggregator')).deploy(8, bn('1e8')) // $1
      )
      referenceUnitOracle = <MockV3Aggregator>(
        await (await ethers.getContractFactory('MockV3Aggregator')).deploy(8, bn('1e8')) // $1
      )

      EURFiatCollateralFactory = await ethers.getContractFactory('EURFiatCollateral', {
        libraries: { OracleLib: oracleLib.address },
      })

      eurFiatCollateral = <EURFiatCollateral>(
        await EURFiatCollateralFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          eurFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('EUR'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      )

      // Mint some tokens
      await eurFiatToken.connect(owner).mint(owner.address, amt)
    })

    it('Should not allow missing defaultThreshold', async () => {
      await expect(
        EURFiatCollateralFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          eurFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('EUR'),
          bn(0),
          DELAY_UNTIL_DEFAULT
        )
      ).to.be.revertedWith('defaultThreshold zero')
    })

    it('Should not allow missing delayUntilDefault', async () => {
      await expect(
        EURFiatCollateralFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          eurFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('EUR'),
          DEFAULT_THRESHOLD,
          bn(0)
        )
      ).to.be.revertedWith('delayUntilDefault zero')
    })

    it('Should not allow missing uoaPerTarget feed', async () => {
      await expect(
        EURFiatCollateralFactory.deploy(
          referenceUnitOracle.address,
          ZERO_ADDRESS,
          eurFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('EUR'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      ).to.be.revertedWith('missing uoaPerTarget feed')
    })

    it('Should not allow missing uoaPerRef feed', async () => {
      await expect(
        EURFiatCollateralFactory.deploy(
          ZERO_ADDRESS,
          targetUnitOracle.address,
          eurFiatToken.address,
          ZERO_ADDRESS,
          config.rTokenTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('EUR'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      ).to.be.revertedWith('missing chainlink feed')
    })

    it('Should setup collateral correctly', async function () {
      // Non-Fiat Token
      expect(await eurFiatCollateral.isCollateral()).to.equal(true)
      expect(await eurFiatCollateral.uoaPerTargetFeed()).to.equal(targetUnitOracle.address)
      expect(await eurFiatCollateral.chainlinkFeed()).to.equal(referenceUnitOracle.address)
      expect(await eurFiatCollateral.erc20()).to.equal(eurFiatToken.address)
      expect(await eurFiatToken.decimals()).to.equal(18)
      expect(await eurFiatCollateral.targetName()).to.equal(ethers.utils.formatBytes32String('EUR'))
      // Get priceable info
      await eurFiatCollateral.refresh()
      expect(await eurFiatCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await eurFiatCollateral.whenDefault()).to.equal(MAX_UINT256)
      expect(await eurFiatCollateral.defaultThreshold()).to.equal(DEFAULT_THRESHOLD)
      expect(await eurFiatCollateral.delayUntilDefault()).to.equal(DELAY_UNTIL_DEFAULT)
      expect(await eurFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await eurFiatCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)
      expect(await eurFiatCollateral.oracleTimeout()).to.equal(ORACLE_TIMEOUT)
      expect(await eurFiatCollateral.bal(owner.address)).to.equal(amt)
      expect(await eurFiatCollateral.refPerTok()).to.equal(fp('1'))
      expect(await eurFiatCollateral.targetPerRef()).to.equal(fp('1'))
      expect(await eurFiatCollateral.pricePerTarget()).to.equal(fp('1'))
      expect(await eurFiatCollateral.price()).to.equal(fp('1'))
      expect(await eurFiatCollateral.getClaimCalldata()).to.eql([ZERO_ADDRESS, '0x'])
      expect(await eurFiatCollateral.rewardERC20()).to.equal(ZERO_ADDRESS)
    })

    it('Should calculate prices correctly', async function () {
      // Check initial prices
      expect(await eurFiatCollateral.price()).to.equal(fp('1'))

      // Update values in Oracle = double price
      await referenceUnitOracle.updateAnswer(bn('2e8'))
      await targetUnitOracle.updateAnswer(bn('2e8'))

      // Check new prices
      expect(await eurFiatCollateral.price()).to.equal(fp('2'))

      // Revert if price is zero - Update Oracles and check prices
      await referenceUnitOracle.updateAnswer(bn('0'))
      await expect(eurFiatCollateral.price()).to.be.revertedWith('PriceOutsideRange()')

      // When refreshed, sets status to Unpriced
      await eurFiatCollateral.refresh()
      expect(await eurFiatCollateral.status()).to.equal(CollateralStatus.UNPRICED)

      // Restore
      await referenceUnitOracle.updateAnswer(bn('2e8'))
      await eurFiatCollateral.refresh()
      expect(await eurFiatCollateral.status()).to.equal(CollateralStatus.SOUND)

      // Check the other oracle - When refreshed, sets status to Unpriced
      await targetUnitOracle.updateAnswer(bn('0'))
      await eurFiatCollateral.refresh()
      expect(await eurFiatCollateral.status()).to.equal(CollateralStatus.UNPRICED)
    })

    it('Should calculate trade min/max correctly', async () => {
      // Check initial values
      expect(await eurFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await eurFiatCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      //  Update values in Oracles to 0
      await referenceUnitOracle.updateAnswer(bn('0'))
      expect(await eurFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await eurFiatCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)
      await referenceUnitOracle.updateAnswer(bn('1e8'))

      await targetUnitOracle.updateAnswer(bn('0'))
      expect(await eurFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await eurFiatCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      // Reduce previous price in half
      await referenceUnitOracle.updateAnswer(bn('0.5e8'))
      await targetUnitOracle.updateAnswer(bn('0.5e8'))
      expect(await eurFiatCollateral.minTradeSize()).to.equal(
        config.rTokenTradingRange.minAmt.mul(2)
      )
      expect(await eurFiatCollateral.maxTradeSize()).to.equal(config.rTokenTradingRange.maxAmt)

      //  Double price
      await referenceUnitOracle.updateAnswer(bn('2e8'))
      await targetUnitOracle.updateAnswer(bn('2e8'))
      expect(await eurFiatCollateral.minTradeSize()).to.equal(config.rTokenTradingRange.minAmt)
      expect(await eurFiatCollateral.maxTradeSize()).to.equal(
        config.rTokenTradingRange.maxAmt.div(2)
      )

      // Handle overflow if minVal is too large
      await referenceUnitOracle.updateAnswer(bn('0.5e8'))
      await targetUnitOracle.updateAnswer(bn('0.5e8'))
      const invalidTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      invalidTradingRange.minVal = MAX_UINT192
      invalidTradingRange.maxVal = MAX_UINT192
      let newEURFiatCollateral = <EURFiatCollateral>(
        await EURFiatCollateralFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          eurFiatToken.address,
          ZERO_ADDRESS,
          invalidTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('EUR'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      )
      await expect(newEURFiatCollateral.minTradeSize()).to.be.reverted
      await expect(newEURFiatCollateral.maxTradeSize()).to.be.reverted

      // Check with reduced range
      const reducedTradingRange = JSON.parse(JSON.stringify(config.rTokenTradingRange))
      reducedTradingRange.maxAmt = reducedTradingRange.minAmt
      reducedTradingRange.maxVal = reducedTradingRange.minVal
      newEURFiatCollateral = <EURFiatCollateral>(
        await EURFiatCollateralFactory.deploy(
          referenceUnitOracle.address,
          targetUnitOracle.address,
          eurFiatToken.address,
          ZERO_ADDRESS,
          reducedTradingRange,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('EUR'),
          DEFAULT_THRESHOLD,
          DELAY_UNTIL_DEFAULT
        )
      )

      // Adapt price significantly to force calculations
      await referenceUnitOracle.updateAnswer(bn('0.5e8'))
      await targetUnitOracle.updateAnswer(bn('0.5e8'))
      expect(await newEURFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newEURFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)

      // Double price, maintains range
      await referenceUnitOracle.updateAnswer(bn('2e8'))
      await targetUnitOracle.updateAnswer(bn('2e8'))

      expect(await newEURFiatCollateral.minTradeSize()).to.equal(reducedTradingRange.minAmt)
      expect(await newEURFiatCollateral.maxTradeSize()).to.equal(reducedTradingRange.maxAmt)
    })
  })

  describeGas('Gas Reporting', () => {
    it('Force Updates - Soft Default', async function () {
      const delayUntilDefault: BigNumber = await tokenCollateral.delayUntilDefault()

      // Depeg one of the underlying tokens - Reducing price 20%
      // Should also impact on the aToken and cToken
      await setOraclePrice(tokenCollateral.address, bn('7e7'))

      // Force updates - Should update whenDefault and status
      await snapshotGasCost(tokenCollateral.refresh())
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.IFFY)

      // Adance half the delay
      await advanceTime(Number(delayUntilDefault.div(2)) + 1)

      // Force updates - Nothing occurs
      await snapshotGasCost(tokenCollateral.refresh())
      await snapshotGasCost(usdcCollateral.refresh())
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.IFFY)

      // Adance the other half
      await advanceTime(Number(delayUntilDefault.div(2)) + 1)

      // Move time forward past delayUntilDefault
      expect(await tokenCollateral.status()).to.equal(CollateralStatus.DISABLED)
      expect(await usdcCollateral.status()).to.equal(CollateralStatus.SOUND)
    })

    it('Force Updates - Hard Default - ATokens/CTokens', async function () {
      // Decrease rate for AToken and CToken, will disable collateral immediately
      await aToken.setExchangeRate(fp('0.99'))
      await cToken.setExchangeRate(fp('0.95'))

      // Force updates - Should update whenDefault and status for Atokens/CTokens
      await snapshotGasCost(aTokenCollateral.refresh())
      expect(await aTokenCollateral.status()).to.equal(CollateralStatus.DISABLED)

      await snapshotGasCost(cTokenCollateral.refresh())
      expect(await cTokenCollateral.status()).to.equal(CollateralStatus.DISABLED)
    })
  })
})
