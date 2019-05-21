import gql from 'graphql-tag'
import { Observable } from 'rxjs'
import { first } from 'rxjs/operators'
import Web3 = require('web3')
import { Arc, IApolloQueryOptions } from './arc'
import { DAO } from './dao'
import { Logger } from './logger'
import { Operation } from './operation'
import { IQueueState } from './queue'
import { IRewardQueryOptions, IRewardState, Reward } from './reward'
import { ISchemeState } from './scheme'
import { IContributionReward } from './schemes/contributionReward'
import * as ContributionReward from './schemes/contributionReward'
import { IGenericScheme } from './schemes/genericScheme'
import * as GenericScheme from './schemes/genericScheme'
import { ISchemeRegistrar } from './schemes/schemeRegistrar'
import * as SchemeRegistrar from './schemes/schemeRegistrar'
import { IStake, IStakeQueryOptions, Stake } from './stake'
import { Token } from './token'
import { Address, Date, ICommonQueryOptions, IStateful } from './types'
import { BN } from './utils'
import { NULL_ADDRESS, realMathToNumber } from './utils'
import { IVote, IVoteQueryOptions, Vote } from './vote'

export const IProposalType = {
  ...ContributionReward.IProposalType,
  ...GenericScheme.IProposalType,
  ...SchemeRegistrar.IProposalType
}
type IProposalType = (
  ContributionReward.IProposalType |
  GenericScheme.IProposalType |
  SchemeRegistrar.IProposalType
)

export enum IProposalOutcome {
  None,
  Pass,
  Fail
}

export enum IProposalStage {
  ExpiredInQueue,
  Executed,
  Queued,
  PreBoosted,
  Boosted,
  QuietEndingPeriod
}

export enum IExecutionState {
  None,
  QueueBarCrossed,
  QueueTimeOut,
  PreBoostedBarCrossed,
  BoostedTimeOut,
  BoostedBarCrossed
}

export interface IProposalState {
  accountsWithUnclaimedRewards: Address[],
  activationTime: number
  boostedAt: Date
  boostedVotePeriodLimit: number
  contributionReward: IContributionReward|null
  confidenceThreshold: number
  createdAt: Date
  dao: DAO
  daoBountyConst: number // ?
  descriptionHash?: string
  description?: string
  downStakeNeededToQueue: typeof BN
  executedAt: Date
  executionState: IExecutionState
  expiresInQueueAt: Date
  genericScheme: IGenericScheme|null
  id: string
  limitExponentValue: number
  organizationId: string
  paramsHash: string
  preBoostedAt: Date
  preBoostedVotePeriodLimit: number
  proposer: Address
  proposingRepReward: typeof BN // in REP
  queuedVoteRequiredPercentage: number
  queuedVotePeriodLimit: number // in seconds (?)
  queue: IQueueState
  quietEndingPeriod: number
  quietEndingPeriodBeganAt: Date
  schemeRegistrar: ISchemeRegistrar|null
  resolvedAt: Date
  scheme: ISchemeState
  stage: IProposalStage
  stakesFor: typeof BN
  stakesAgainst: typeof BN
  thresholdConst: number
  title?: string
  totalRepWhenExecuted: typeof BN
  type: IProposalType,
  upstakeNeededToPreBoost: typeof BN
  url?: string
  votesFor: typeof BN
  votesAgainst: typeof BN
  votesCount: number
  voteOnBehalf: Address
  winningOutcome: IProposalOutcome
  votersReputationLossRatio: number // in 1000's
  minimumDaoBounty: typeof BN // in GEN
}

export interface IContributionReward {
  beneficiary: Address
  externalTokenReward: typeof BN
  externalToken: Address
  ethReward: typeof BN
  nativeTokenReward: typeof BN
  periods: number
  periodLength: number
  reputationReward: typeof BN
}

export interface IGenericScheme {
  id: string
  contractToCall: Address
  callData: string
  executed: boolean
  returnValue: string
}

export interface ISchemeRegistrar {
  id: string
  schemeToRegister: Address
  schemeToRegisterParamsHash: string
  schemeToRegisterPermission: string
  schemeToRemove: string
  decision: number
  schemeRegistered: boolean
  schemeRemoved: boolean
}

export class Proposal implements IStateful<IProposalState> {

  /**
   * Proposal.create() creates a new proposal
   * @param  options cf. IProposalCreateOptions
   * @param  context [description]
   * @return  an observable that streams the various states
   */
  public static create(options: IProposalCreateOptions, context: Arc): Operation<Proposal> {

    let msg: string // used for error messages
    if (!options.dao) {
      throw Error(`Proposal.create(options): options must include an address for "dao"`)
    }

    let ipfsDataToSave: object = {}

    const saveIPFSData = async () => {
      if (options.title || options.url || options.description) {
        if (!context.ipfsProvider) {
          throw Error(`No ipfsProvider set on Arc instance - cannot save data on IPFS`)
        }
        ipfsDataToSave = {
          description: options.description,
          title: options.title,
          url: options.url
        }
        if (options.descriptionHash) {
          msg = `Proposal.create() takes a descriptionHash, or values for title, url and description; not both`
          throw Error(msg)
        }
      }
      if (ipfsDataToSave !== {}) {
        Logger.debug('Saving data on IPFS...')
        let descriptionHash: string = ''
        try {
          const ipfsResponse = await context.ipfs.add(Buffer.from(JSON.stringify(ipfsDataToSave)))
          descriptionHash = ipfsResponse[0].path
          // pin the file
          await context.ipfs.pin.add(descriptionHash)
        } catch (error) {
          throw error
        }
        Logger.debug(`Data saved successfully as ${options.descriptionHash}`)
        return descriptionHash
      }
    }

    let createTransaction: () => any = () => null

    let eventName: string
    switch (options.type) {
    // ContributionReward
      case IProposalType.ContributionReward:
        eventName = 'NewContributionProposal'
        const contributionReward = context.getContract('ContributionReward')

        createTransaction = async () => {
          options.descriptionHash = await saveIPFSData()
          const transaction = contributionReward.methods.proposeContributionReward(
              options.dao,
              options.descriptionHash || '',
              options.reputationReward && options.reputationReward.toString() || 0,
              [
                options.nativeTokenReward && options.nativeTokenReward.toString() || 0,
                options.ethReward && options.ethReward.toString() || 0,
                options.externalTokenReward && options.externalTokenReward.toString() || 0,
                options.periodLength || 0,
                options.periods || 1
              ],
              options.externalTokenAddress || NULL_ADDRESS,
              options.beneficiary
          )
          return transaction
        }
        break

      // GenericScheme
      case IProposalType.GenericScheme:
        eventName = 'NewCallProposal'
        if (!options.callData) {
          throw new Error(`Missing argument "callData" for GenericScheme in Proposal.create()`)
        }
        if (options.value === undefined) {
          throw new Error(`Missing argument "value" for GenericScheme in Proposal.create()`)
        }
        createTransaction = async () => {
          options.descriptionHash = await saveIPFSData()

          const genericScheme = context.getContract('GenericScheme')
          const transaction = genericScheme.methods.proposeCall(
            options.dao,
            options.callData,
            options.value,
            options.descriptionHash
          )
          return transaction
        }
        break

      // SchemeRegistrar
      case IProposalType.SchemeRegistrarAdd:
      case IProposalType.SchemeRegistrarEdit:
        eventName = 'NewSchemeProposal'
        if (!options.scheme) {
          msg = `Missing argument "scheme" for SchemeRegistrar in Proposal.create()`
          throw Error(msg)
        }
        if (!options.parametersHash) {
          msg = `Missing argument "parametersHash" for SchemeRegistrar in Proposal.create()`
          throw Error(msg)
        }
        if (!options.permissions) {
          msg = `Missing argument "permissions" for SchemeRegistrar in Proposal.create()`
          throw Error(msg)
        }
        createTransaction = async () => {
          const schemeRegistrar = context.getContract('SchemeRegistrar')
          options.descriptionHash = await saveIPFSData()

          const transaction = schemeRegistrar.methods.proposeScheme(
            options.dao,
            options.scheme,
            options.parametersHash,
            options.permissions,
            options.descriptionHash
          )
          return transaction
        }
        break
      case IProposalType.SchemeRegistrarRemove:
        eventName = 'RemoveSchemeProposal'
        if (!options.scheme) {
          msg = `Missing argument "scheme" for SchemeRegistrar`
          throw Error(msg)
        }
        createTransaction = async () => {
          const schemeRegistrar = context.getContract('SchemeRegistrar')
          options.descriptionHash = await saveIPFSData()
          const transaction = schemeRegistrar.methods.proposeToRemoveScheme(
            options.dao,
            options.scheme,
            options.descriptionHash
          )
          return transaction
        }
        break
      default:
        msg = `Unknown proposal type: "${options.type}" (did you use IProposalType.TypeOfProposal?)`
        throw Error(msg)
    }

    const map = (receipt: any) => {
      const proposalId = receipt.events[eventName].returnValues._proposalId
      const votingMachineAddress = receipt.events[eventName].returnValues._intVoteInterface
      return new Proposal(proposalId, options.dao as string, votingMachineAddress, context)
    }

    return context.sendTransaction(createTransaction, map)
  }

  /**
   * Search for proposals
   * @param  options            Search options, must implemeent IProposalQueryOptions
   * @param  context            An instance of Arc
   * @param  apolloQueryOptions [description]
   * @return                    An observable of lists of results
   *
   * For example:
   *    Proposal.search({ stage: IProposalStage.Queued})
   */
  public static search(
    options: IProposalQueryOptions,
    context: Arc,
    apolloQueryOptions: IApolloQueryOptions = {}
  ): Observable<Proposal[]> {
    let where = ''

    // default options
    options.type = options.type || IProposalType.ContributionReward

    for (const key of Object.keys(options)) {
      const value = options[key]
      if (key === 'stage' && value !== undefined) {
        where += `stage: "${IProposalStage[value as IProposalStage]}"\n`
      } else if (key === 'stage_in' && Array.isArray(value)) {
        const stageValues = value.map((stage: number) => '"' + IProposalStage[stage as IProposalStage] + '"')
        where += `stage_in: [${stageValues.join(',')}]\n`
      } else if (key === 'type') {
        // TODO: we are not distinguishing between the schemeregisterpropose
        // and SchemeRegistrarProposeToRemove proposals
        if (value.toString().includes('SchemeRegistrar')) {
          where += `schemeRegistrar_not: null\n`
        } else {
          const apolloKey = IProposalType[value][0].toLowerCase() + IProposalType[value].slice(1)
          where += `${apolloKey}_not: null\n`
        }
      } else if (Array.isArray(options[key])) {
        // Support for operators like _in
        const values = options[key].map((val: number) => '"' + val + '"')
        where += `${key}: [${values.join(',')}]\n`
      } else {
        if (key === 'proposer' || key === 'beneficiary' || key === 'dao') {
          where += `${key}: "${(options[key] as string).toLowerCase()}"\n`
        } else {
          where += `${key}: "${options[key] as string}"\n`

        }
      }
    }

    const query = gql`
      {
        proposals(where: {
          ${where}
        }) {
          id
          dao {
            id
          }
          votingMachine
        }
      }
    `

    return context.getObservableList(
      query,
      (r: any) => new Proposal(r.id, r.dao.id, r.votingMachine, context),
      apolloQueryOptions
    ) as Observable<Proposal[]>
  }
  /**
   * `state` is an observable of the proposal state
   */
  public context: Arc
  public dao: DAO

constructor(
    public id: string,
    daoAddress: Address,
    public votingMachineAddress: Address,
    context: Arc
  ) {
    this.id = id
    this.context = context
    this.dao = new DAO(daoAddress, context)
  }
  public state(): Observable < IProposalState > {
    const query = gql`
      {
        proposal(id: "${this.id}") {
          id
          activationTime
          accountsWithUnclaimedRewards
          boostedAt
          boostedVotePeriodLimit
          confidenceThreshold
          contributionReward {
            id
            beneficiary
            ethReward
            externalToken
            externalTokenReward
            externalToken
            nativeTokenReward
            periods
            periodLength
            reputationReward
          }
          createdAt
          dao {
            id
            schemes {
              id
              address
            }
          }
          daoBountyConst
          description
          descriptionHash
          executedAt
          executionState
          expiresInQueueAt
          genericScheme {
            id
            contractToCall
            callData
            executed
            returnValue
          }
          gpRewards {
            id
          }
          scheme {
            id
            paramsHash
            name
            address
            canDelegateCall
            canManageGlobalConstraints
            canRegisterSchemes
            canUpgradeController
            name
          }
          gpQueue {
            id
            threshold
            votingMachine
          }
          limitExponentValue
          minimumDaoBounty
          organizationId
          preBoostedAt
          preBoostedVotePeriodLimit
          proposer
          proposingRepReward
          queuedVotePeriodLimit
          queuedVoteRequiredPercentage
          quietEndingPeriod
          thresholdConst
          quietEndingPeriodBeganAt
          schemeRegistrar {
            id
            schemeToRegister
            schemeToRegisterParamsHash
            schemeToRegisterPermission
            schemeToRemove
            decision
            schemeRegistered
            schemeRemoved
          }
          stage
          stakes {
            id
          }
          stakesFor
          stakesAgainst
          totalRepWhenExecuted
          title
          url
          votersReputationLossRatio
          votes {
            id
          }
          votesAgainst
          votesFor
          winningOutcome
        }
      }
    `

    const itemMap = (item: any): IProposalState|null => {
      if (item === null) {
        // no proposal was found - we return null
        return null
      }

      let contributionReward: IContributionReward|null = null
      let type: IProposalType
      let genericScheme: IGenericScheme|null = null
      let schemeRegistrar: ISchemeRegistrar|null = null
      if (item.contributionReward) {
        type = IProposalType.ContributionReward
        contributionReward = {
          beneficiary: item.contributionReward.beneficiary,
          ethReward: new BN(item.contributionReward.ethReward),
          externalToken: item.contributionReward.externalToken,
          externalTokenReward: new BN(item.contributionReward.externalTokenReward),
          nativeTokenReward: new BN(item.contributionReward.nativeTokenReward),
          periodLength: Number(item.contributionReward.periodLength),
          periods: Number(item.contributionReward.periods),
          reputationReward: new BN(item.contributionReward.reputationReward)
        }
      } else if (item.genericScheme) {
        type = IProposalType.GenericScheme
        genericScheme = {
          callData: item.genericScheme.callData,
          contractToCall: item.genericScheme.contractToCall,
          executed: item.genericScheme.executed,
          id: item.genericScheme.id,
          returnValue: item.genericScheme.returnValue
        }
      } else if (item.schemeRegistrar) {
        if (item.schemeRegistrar.schemeToRegister) {
          // TODO: this is failing bc of https://github.com/daostack/subgraph/issues/224
          if (item.dao.schemes.map((s: any) => s.address.toLowerCase())
            .includes(item.schemeRegistrar.schemeToRegister.toLowerCase())) {
            type = IProposalType.SchemeRegistrarEdit
          } else {
            type = IProposalType.SchemeRegistrarAdd
          }
        } else if (item.schemeRegistrar.schemeToRemove) {
          type = IProposalType.SchemeRegistrarRemove
        } else {
          throw Error(`Unknown proposal type: schemeRegistrar without a scheme to register or to remove`)
        }
        schemeRegistrar =  {
          decision: item.schemeRegistrar.decision,
          id: item.schemeRegistrar.id,
          schemeRegistered: item.schemeRegistrar.schemeRegistered,
          schemeRemoved: item.schemeRegistrar.schemeRemoved,
          schemeToRegister: item.schemeRegistrar.schemeToRegister,
          schemeToRegisterParamsHash: item.schemeRegistrar.schemeToRegisterParamsHash,
          schemeToRegisterPermission: item.schemeRegistrar.schemeToRegisterPermission,
          schemeToRemove: item.schemeRegistrar.schemeToRemove
        }
      } else {
        throw Error(`Unknown proposal type`)
      }
      // the  formule to enter into the preboosted state is:
      // (S+/S-) > AlphaConstant^NumberOfBoostedProposal.
      // (stakesFor/stakesAgainst) > gpQueue.threshold
      const stage: any = IProposalStage[item.stage]
      const threshold = realMathToNumber(new BN(item.gpQueue.threshold))
      const stakesFor = new BN(item.stakesFor)
      const stakesAgainst = new BN(item.stakesAgainst)

      // upstakeNeededToPreBoost is the amount of tokens needed to upstake to move to the preboost queue
      // this is only non-zero for Queued proposals
      // note that the number can be negative!
      let upstakeNeededToPreBoost: typeof BN = new BN(0)
      const PRECISION = Math.pow(2, 40)
      if (stage === IProposalStage.Queued) {

        upstakeNeededToPreBoost = new BN(threshold * PRECISION)
          .mul(stakesAgainst)
          .div(new BN(PRECISION))
          .sub(stakesFor)
      }
      // upstakeNeededToPreBoost is the amount of tokens needed to upstake to move to the Queued queue
      // this is only non-zero for Preboosted proposals
      // note that the number can be negative!
      let downStakeNeededToQueue: typeof BN = new BN(0)
      if (stage === IProposalStage.PreBoosted) {
        downStakeNeededToQueue = stakesFor.mul(new BN(PRECISION))
          .div(new BN(threshold * PRECISION))
          .sub(stakesAgainst)
      }
      const thresholdConst = realMathToNumber(new BN(item.thresholdConst))
      const scheme = item.scheme
      const schemeName = scheme.name || this.context.getContractName(scheme.address)
      const gpQueue = item.gpQueue

      const schemeState: ISchemeState = {
        address: scheme.address,
        canDelegateCall: scheme.canDelegateCall,
        canManageGlobalConstraints: scheme.canManageGlobalConstraints,
        canRegisterSchemes: scheme.canRegisterSchemes,
        canUpgradeController: scheme.canUpgradeController,
        dao: item.dao.id,
        id: scheme.id,
        name: schemeName,
        paramsHash: scheme.paramsHash
      }
      const queueState: IQueueState = {
        dao: item.dao.id,
        id: gpQueue.id,
        name: schemeName,
        scheme: schemeState,
        threshold,
        votingMachine: gpQueue.votingMachine
      }

      return {
        accountsWithUnclaimedRewards: item.accountsWithUnclaimedRewards,
        activationTime: Number(item.activationTime),
        boostedAt: Number(item.boostedAt),
        boostedVotePeriodLimit: Number(item.boostedVotePeriodLimit),
        confidenceThreshold: Number(item.confidenceThreshold),
        contributionReward,
        createdAt: Number(item.createdAt),
        dao: new DAO(item.dao.id, this.context),
        daoBountyConst: Number(item.daoBountyConst),
        description: item.description,
        descriptionHash: item.descriptionHash,
        downStakeNeededToQueue,
        executedAt: Number(item.executedAt),
        executionState: IExecutionState[item.executionState] as any,
        expiresInQueueAt: Number(item.expiresInQueueAt),
        genericScheme,
        id: item.id,
        limitExponentValue: Number(item.limitExponentValue),
        minimumDaoBounty: new BN(item.minimumDaoBounty),
        organizationId: item.organizationId,
        paramsHash: item.paramsHash,
        preBoostedAt: Number(item.preBoostedAt),
        preBoostedVotePeriodLimit: Number(item.preBoostedVotePeriodLimit),
        proposer: item.proposer,
        proposingRepReward: new BN(item.proposingRepReward),
        queue: queueState,
        queuedVotePeriodLimit: Number(item.queuedVotePeriodLimit),
        queuedVoteRequiredPercentage: Number(item.queuedVoteRequiredPercentage),
        quietEndingPeriod: Number(item.quietEndingPeriod),
        quietEndingPeriodBeganAt: Number(item.quietEndingPeriodBeganAt),
        resolvedAt: item.resolvedAt !== undefined ? Number(item.resolvedAt) : 0,
        scheme: schemeState,
        schemeRegistrar,
        stage,
        stakesAgainst,
        stakesFor,
        thresholdConst,
        title: item.title,
        totalRepWhenExecuted: new BN(item.totalRepWhenExecuted),
        type,
        upstakeNeededToPreBoost,
        url: item.url,
        voteOnBehalf: item.voteOnBehalf,
        votersReputationLossRatio: Number(item.votersReputationLossRatio),
        votesAgainst: new BN(item.votesAgainst),
        votesCount: item.votes.length,
        votesFor: new BN(item.votesFor),
        winningOutcome: IProposalOutcome[item.winningOutcome] as any
      }
    }

    return this.context.getObservableObject(query, itemMap) as Observable<IProposalState>
  }

  /**
   * [votingMachine description]
   * @return [description]
   */
  public votingMachine() {
    const votingMachineAddress = this.votingMachineAddress
    if (!votingMachineAddress) {
      throw Error('No votingmachine address known for this proposal')
    }
    const contractClass = require('@daostack/arc/build/contracts/GenesisProtocol.json')
    return new this.context.web3.eth.Contract(contractClass.abi, votingMachineAddress)
  }

  public redeemerContract() {
    return this.context.getContract('Redeemer')
  }

  public votes(options: IVoteQueryOptions = {}): Observable < IVote[] > {
    options.proposal = this.id
    return Vote.search(options, this.context)
  }

  /**
   * Vote for this proposal
   * @param  outcome one of IProposalOutcome.Pass (0) or IProposalOutcome.FAIL (1)
   * @param  amount the amount of reputation to vote with. Defaults to 0 - in that case,
   *  all the sender's rep will be used
   * @return  an observable Operation<Vote>
   */
  public vote(outcome: IProposalOutcome, amount: number = 0): Operation<Vote|null> {

    const votingMachine = this.votingMachine()

    const voteMethod = votingMachine.methods.vote(
      this.id,  // proposalId
      outcome, // a value between 0 to and the proposal number of choices.
      amount.toString(), // amount of reputation to vote with . if _amount == 0 it will use all voter reputation.
      NULL_ADDRESS
    )

    const map = (receipt: any) => {
      const event = receipt.events.VoteProposal
      if (!event) {
        // no vote was cast
        return null
      }
      const voteId = undefined

      return new Vote(
        voteId,
        event.returnValues._voter,
        // createdAt is "about now", but we cannot calculate the data that will be indexed by the subgraph
        0, // createdAt -
        outcome,
        event.returnValues._reputation, // amount
        this.id, // proposalID
        this.dao.address
      )
    }
    const errorHandler = async (error: Error) => {
      if (error.message.match(/revert/)) {
        const proposal = this
        const proposalDataFromVotingMachine = await votingMachine.methods.proposals(proposal.id).call()
        if (proposalDataFromVotingMachine.proposer === NULL_ADDRESS ) {
          return Error(`Error in vote(): unknown proposal with id ${proposal.id}`)
        }

        if (proposalDataFromVotingMachine.state === '2') {
          const msg = `Error in vote(): proposal ${proposal.id} already executed`
          return Error(msg)
        }
      }
      // if we have found no known error, we return the original error
      return error
    }
    return this.context.sendTransaction(voteMethod, map, errorHandler)
  }

  public stakingToken() {
    return new Token(this.context.getContract('GEN').options.address, this.context)
  }

  public stakes(options: IStakeQueryOptions = {}): Observable < IStake[] > {
    options.proposal = this.id
    return Stake.search(options, this.context)
  }

  public stake(outcome: IProposalOutcome, amount: typeof BN ): Operation < Stake > {
    const stakeMethod = this.votingMachine().methods.stake(
      this.id,  // proposalId
      outcome, // a value between 0 to and the proposal number of choices.
      amount.toString() // the amount of tokens to stake
    )

    const map = (receipt: any) => { // map extracts Stake instance from receipt
        const event = receipt.events.Stake
        if (!event) {
          // for some reason, a transaction was mined but no error was raised before
          throw new Error(`Error staking: no "Stake" event was found - ${Object.keys(receipt.events)}`)
        }
        const stakeId = undefined

        return new Stake(
          stakeId,
          event.returnValues._staker,
          // createdAt is "about now", but we cannot calculate the data that will be indexed by the subgraph
          undefined,
          outcome,
          event.returnValues._reputation, // amount
          this.id // proposalID
        )
    }

    const errorHandler =  async (error: Error) => {
      if (error.message.match(/revert/)) {
        const proposal = this
        const stakingToken = this.stakingToken()
        const prop = await this.votingMachine().methods.proposals(proposal.id).call()
        if (prop.proposer === NULL_ADDRESS ) {
          return new Error(`Unknown proposal with id ${proposal.id}`)
        }

        // staker has sufficient balance
        const defaultAccount = await this.context.getAccount().pipe(first()).toPromise()
        const balance = new BN(await stakingToken.contract().methods.balanceOf(defaultAccount).call())
        const amountBN = new BN(amount)
        if (balance.lt(amountBN)) {
          const msg = `Staker ${defaultAccount} has insufficient balance to stake ${amount.toString()}
            (balance is ${balance.toString()})`
          return new Error(msg)
        }

        // staker has approved the token spend
        const allowance = new BN(await stakingToken.contract().methods.allowance(
          defaultAccount, this.votingMachine().options.address
        ).call())
        if (allowance.lt(amountBN)) {
          return new Error(`Staker has insufficient allowance to stake ${amount.toString()}
            (allowance is ${allowance.toString()})`)
        }
      }
      // if we have found no known error, we return the original error
      return error
    }
    return this.context.sendTransaction(stakeMethod, map, errorHandler)
  }

  public rewards(options: IRewardQueryOptions = {}): Observable < IRewardState[] > {
    options.proposal = this.id
    return Reward.search(options, this.context)
  }

  /**
   * [claimRewards description] Execute the proposal and distribute the rewards
   * to the beneficiary.
   * This uses the Redeemer.sol helper contract
   * @param  beneficiary Addresss of the beneficiary, optional,
   *    if undefined will only redeem the ContributionReward rewards
   * @return  an Operation
   */
  public claimRewards(beneficiary ?: Address): Operation < boolean > {
    // const transaction = this.votingMachine().methods.redeem(this.id, account)
    if (!beneficiary) {
      beneficiary = NULL_ADDRESS
    }
    const transaction = this.redeemerContract().methods.redeem(
      this.id,
      this.dao.address,
      beneficiary
    )
    return this.context.sendTransaction(transaction, () => true)
  }

  /**
   * calll the 'execute()' function on the votingMachine.
   * the main purpose of this function is to set the stage of the proposals
   * this call may (or may not) "execute" the proposal itself (i.e. do what the proposal proposes)
   * @return an Operation that, when sucessful, wil lcontain the receipt of the transaction
   */
  public execute(): Operation<any> {
    const transaction = this.votingMachine().methods.execute(this.id)
    const map = (receipt: any) => {
      if (Object.keys(receipt.events).length  === 0) {
        // this does not mean that anything failed
        return receipt
      } else {
        return receipt
      }
    }
    const errorHandler = async (err: Error) => {
      const votingMachine = this.votingMachine()
      const proposalDataFromVotingMachine = await votingMachine.methods.proposals(this.id).call()

      if (proposalDataFromVotingMachine.callbacks === NULL_ADDRESS) {
        const msg = `Error in proposal.execute(): A proposal with id ${this.id} does not exist`
        return Error(msg)
      } else if (proposalDataFromVotingMachine.state === '2') {
        const msg = `Error in proposal.execute(): proposal ${this.id} already executed`
        return Error(msg)
      }
      // require(organizationsProposals[address(proposal.avatar)][_proposalId].beneficiary != address(0));
      // else if (proposalDataOnChain.beneficiary === NULL_ADDRESS) {
      //   const msg = `beneficiary is ${NULL_ADDRESS}`
      // }

      return err
    }
    return this.context.sendTransaction(transaction, map, errorHandler)
  }
}

enum ProposalQuerySortOptions {
  resolvesAt = 'resolvesAt',
  preBoostedAt = 'preBoostedAt'
}

export interface IProposalQueryOptions extends ICommonQueryOptions {
  accountsWithUnclaimedRewards_contains?: Address[]
  active?: boolean
  boosted?: boolean
  dao?: Address
  expiresInQueueAt?: Date
  expiresInQueueAt_gte?: Date
  expiresInQueueAt_lte?: Date
  expiresInQueueAt_gt?: Date
  executedAfter?: Date
  executedBefore?: Date
  id?: string
  proposer?: Address
  proposalId?: string
  stage?: IProposalStage
  stage_in?: IProposalStage[]
  orderBy?: ProposalQuerySortOptions
  type?: IProposalType
}

// TODO: refactor out the options that belong to different schemes
export interface IProposalCreateOptions {
  beneficiary?: Address  // for ContributionRewardProposal
  dao?: Address
  description?: string
  descriptionHash?: string
  callData?: string // for GenericSchemeProposal
  nativeTokenReward?: typeof BN // for ContributionRewardProposal
  reputationReward?: typeof BN // for ContributionRewardProposal
  ethReward?: typeof BN // for ContributionRewardProposal
  externalTokenReward?: typeof BN // for ContributionRewardProposal
  externalTokenAddress?: Address // for ContributionRewardProposal
  periodLength?: number // for ContributionRewardProposal
  periods?: any  // for ContributionRewardProposal
  parametersHash?: string // for schemeRegistrar Proposal
  permissions?: string // for schemeRegistrar Proposal
  scheme?: Address // for schemeRegistrar Proposal
  title?: string
  type: IProposalType
  url?: string
  value?: number // for GenericSchemeProposal
}
