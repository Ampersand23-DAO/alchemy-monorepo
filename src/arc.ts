import gql from 'graphql-tag'
import { Observable, Observer, of, Subscription } from 'rxjs'
import { map } from 'rxjs/operators'
import { DAO } from './dao'
import { GraphNodeObserver } from './graphnode'
import { Logger } from './logger'
import { Operation, sendTransaction, web3receipt } from './operation'
import { Token } from './token'
import { Address, IPFSProvider, Web3Provider } from './types'
import { BN } from './utils'
import { isAddress } from './utils'
const IPFSClient = require('ipfs-http-client')
const Web3 = require('web3')

/**
 * The Arc class holds all configuration.
 * Any useage of the library typically will start with instantiating a new Arc instance
 * @return an instance of Arc
 */
export class Arc extends GraphNodeObserver {
  public web3Provider: Web3Provider = ''
  public ipfsProvider: IPFSProvider

  public pendingOperations: Observable<Array<Operation<any>>> = of()

  public ipfs: any
  public web3: any
  /**
   * a mapping of contrct names to contract addresses
   */
  public contractAddresses: IContractAddresses
  public contracts: {[key: string]: any} = {}

  // accounts obseved by ethBalance
  public blockHeaderSubscription: Subscription|undefined = undefined
  public observedAccounts: { [address: string]: {
      observable?: Observable<typeof BN>,
      observer?: Observer<typeof BN>,
      lastBalance?: number
      subscriptionsCount: number
    }
  } = {}

  constructor(options: {
    contractAddresses: IContractAddresses
    graphqlHttpProvider: string
    graphqlWsProvider: string
    ipfsProvider: IPFSProvider
    web3Provider: string
  }) {
    super({
      graphqlHttpProvider: options.graphqlHttpProvider,
      graphqlWsProvider: options.graphqlWsProvider
    })
    this.ipfsProvider = options.ipfsProvider

    const web3provider = options.web3Provider

    if (web3provider) {
      this.web3 = new Web3(web3provider)
    }

    this.contractAddresses = options.contractAddresses
    if (!this.contractAddresses) {
      Logger.warn('No contract addresses given to the Arc.constructor: expect most write operations to fail!')
    }

    if (this.ipfsProvider) {
      this.ipfs = IPFSClient(this.ipfsProvider)
    }
  }

  /**
   * [dao description]
   * @param  address address of the dao Avatar
   * @return an instance of a DAO
   */
  public dao(address: Address): DAO {
    isAddress(address)
    return new DAO(address, this)
  }

  public daos(): Observable < DAO[] > {
    const query = gql`
      {
        daos {
          id
        }
      }
    `
    return this.getObservableList(
      query,
      (r: any) => new DAO(r.id, this)
    ) as Observable<DAO[]>
  }

  public ethBalance(owner: Address): Observable<typeof BN> {
    if (!this.observedAccounts[owner]) {
      this.observedAccounts[owner] = {
        subscriptionsCount: 1
       }
    }
    if (this.observedAccounts[owner].observable) {
        this.observedAccounts[owner].subscriptionsCount += 1
        return this.observedAccounts[owner].observable as Observable<typeof BN>
    }

    const observable = Observable.create((observer: Observer<typeof BN>) => {
      this.observedAccounts[owner].observer = observer

      // get the current balance and return it
      this.web3.eth.getBalance(owner).then((currentBalance: number) => {
        const accInfo = this.observedAccounts[owner];
        (accInfo.observer as Observer<typeof BN>).next(new BN(currentBalance))
        accInfo.lastBalance = currentBalance
      })

      // set up the blockheadersubscription if it does not exist yet
      if (!this.blockHeaderSubscription) {
        this.blockHeaderSubscription = this.web3.eth.subscribe('newBlockHeaders', (err: Error) => {
          Object.keys(this.observedAccounts).forEach((addr) => {
            const accInfo = this.observedAccounts[addr]
            if (err) {
              (accInfo.observer as Observer<typeof BN>).error(err)
            } else {
              this.web3.eth.getBalance(addr).then((balance: any) => {
                if (balance !== accInfo.lastBalance) {
                  (accInfo.observer as Observer<typeof BN>).next(new BN(balance))
                  accInfo.lastBalance = balance
                }
              })
            }
          })
        })
      }
      // unsubscribe
      return( ) => {
        this.observedAccounts[owner].subscriptionsCount -= 1
        if (this.observedAccounts[owner].subscriptionsCount <= 0) {
          delete this.observedAccounts[owner]
        }
        if (Object.keys(this.observedAccounts).length === 0 && this.blockHeaderSubscription) {
          this.blockHeaderSubscription.unsubscribe()
          this.blockHeaderSubscription = undefined
        }
      }
    })

    this.observedAccounts[owner].observable = observable
    return observable
      .pipe(map((item: any) => new BN(item)))
  }

  /**
   * get a web3 contract instance for the deployed contract with the given name
   * @param  name [description]
   * @return a web3 Contract instance
   */
  public getContract(name: string) {
    const addresses = this.contractAddresses
    const opts = {}
    if (this.contracts[name]) {
      return this.contracts[name]
    }
    if (!addresses) {
      throw new Error(`Cannot get contract: no contractAddress set`)
    }
    if (!addresses[name]) {
      throw new Error(`No contract named ${name} could be found in the provided contract addresses`)
    }
    let contractClass
    let contract
    switch (name) {
      case 'AbsoluteVote':
        contractClass = require('@daostack/arc/build/contracts/AbsoluteVote.json')
        contract = new this.web3.eth.Contract(contractClass.abi, addresses.AbsoluteVote, opts)
        this.contracts[name] = contract
        return contract
      case 'ContributionReward':
        contractClass = require('@daostack/arc/build/contracts/ContributionReward.json')
        contract = new this.web3.eth.Contract(contractClass.abi, addresses.ContributionReward, opts)
        this.contracts[name] = contract
        return contract
      case 'GEN':
        contractClass = require('@daostack/arc/build/contracts/DAOToken.json')
        contract = new this.web3.eth.Contract(contractClass.abi, addresses.GEN, opts)
        this.contracts[name] = contract
        return contract
      case 'GenericScheme':
        contractClass = require('@daostack/arc/build/contracts/GenericScheme.json')
        contract = new this.web3.eth.Contract(contractClass.abi, addresses.GenericScheme, opts)
        this.contracts[name] = contract
        return contract
      // case 'GenesisProtocol':
      //   contractClass = require('@daostack/arc/build/contracts/GenesisProtocol.json')
      //   contract = new this.web3.eth.Contract(contractClass.abi, addresses.GenesisProtocol, opts)
      //   return contract
      case 'Redeemer':
        contractClass = require('@daostack/arc/build/contracts/Redeemer.json')
        contract = new this.web3.eth.Contract(contractClass.abi, addresses.Redeemer, opts)
        this.contracts[name] = contract
        return contract
      case 'SchemeRegistrar':
        contractClass = require('@daostack/arc/build/contracts/SchemeRegistrar.json')
        contract = new this.web3.eth.Contract(contractClass.abi, addresses.SchemeRegistrar, opts)
        this.contracts[name] = contract
        return contract
      default:
        throw Error(`Unknown contract: ${name}`)
    }
  }

  /**
   * get the name of the contract, given an address
   * @param  address An ethereum address
   * @return        The name of the contract, if the address is known, undefined otherwise
   */
  public getContractName(address: Address): string|undefined {
    isAddress(address)
    for (const key of Object.keys(this.contractAddresses)) {
      if (this.contractAddresses[key].toLowerCase() === address.toLowerCase()) {
        return key
      }
    }
  }

  public GENToken() {
    if (this.contractAddresses) {
      return new Token(this.contractAddresses.GEN, this)
    } else {
      throw Error(`Cannot get GEN Token because no contract addresses were provided`)
    }
  }

  public getAccount(): Observable<Address> {
    // this complex logic is to get the correct account both from the Web3 as well as from the Metamaask provider
    // Polling is Evil!
    // cf. https://github.com/MetaMask/faq/blob/master/DEVELOPERS.md#ear-listening-for-selected-account-changes
    return Observable.create((observer: any) => {
      const interval = 1000 /// poll once a second
      let account: any
      let prevAccount: any
      const web3 = this.web3
      if (web3.eth.accounts[0]) {
        observer.next(web3.eth.accounts[0].address)
        prevAccount = web3.eth.accounts[0].address
      } else if (web3.eth.defaultAccount ) {
        observer.next(web3.eth.defaultAccount)
        prevAccount = web3.eth.defaultAccount
      }
      const timeout = setInterval(() => {
        web3.eth.getAccounts().then((accounts: any) => {
          if (accounts) {
            account = accounts[0]
          } else if (web3.eth.accounts) {
            account = web3.eth.accounts[0].address
          }
          if (prevAccount !== account && account) {
            web3.eth.defaultAccount = account
            observer.next(account)
            prevAccount = account
          }
        })
      }, interval)
      return() => clearTimeout(timeout)
    })
  }

  public setAccount(address: Address) {
    this.web3.eth.defaultAccount = address
  }

  public approveForStaking(spender: Address, amount: typeof BN) {
    return this.GENToken().approveForStaking(spender, amount)
  }

  /**
   * How much GEN  spander spend on behalve of the owner
   * @param  owner Address of the owner of the tokens
   * @param  spender Address of the spender
   * @return
   */
  public allowance(owner: Address, spender: Address): Observable<typeof BN> {
    return this.GENToken().allowance(owner, spender)
  }

  /**
   * send an Ethereum transaction
   * @param  transaction  [description]
   * @param  mapToObject  [description]
   * @param  errorHandler [description]
   * @return  An observable of
   */
  public sendTransaction<T>(
    transaction: any,
    mapToObject: (receipt: web3receipt) => T,
    errorHandler: (error: Error) => Promise<Error> | Error = (error) => error
  ): Operation<T> {
    return sendTransaction(transaction, mapToObject, errorHandler, this)
  }

}

export interface IApolloQueryOptions {
  fetchPolicy?: 'cache-first' | 'cache-and-network' | 'network-only' | 'cache-only' | 'no-cache' | 'standby'
}

export interface IContractAddresses {
  [key: string]: Address
}
