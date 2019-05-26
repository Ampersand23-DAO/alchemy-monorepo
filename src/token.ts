import gql from 'graphql-tag'
import { Observable, Observer, of, Subscription } from 'rxjs'
import { first } from 'rxjs/operators'
import { Arc, IApolloQueryOptions } from './arc'
import { Address, Hash, IObservableWithFirst, IStateful, Web3Receipt, ICommonQueryOptions } from './types'
import { BN } from './utils'
import { isAddress } from './utils'

export interface ITokenState {
  address: Address
  name: string
  owner: Address
  symbol: string
  totalSupply: typeof BN
}

export interface ITokenQueryOptions extends ICommonQueryOptions {
  address?: Address
  name?: string
  owner?: Address
  symbol?: string
}

export interface IApproval {
  id: Hash
  txHash: Hash
  contract: Address
  owner: Address
  spender: Address
  value: typeof BN
}

export interface IAllowance {
  token: Address
  owner: Address
  spender: Address
  amount: typeof BN
}

export class Token implements IStateful<ITokenState> {

  /**
  * Token.search(context, options) searches for token entities
  * @param  context an Arc instance that provides connection information
  * @param  options the query options, cf. ITokenQueryOptions
  * @return         an observable of IRewardState objects
  */
  public static search(
    options: ITokenQueryOptions,
    context: Arc,
    apolloQueryOptions: IApolloQueryOptions
  ): Observable<Token[]> {
    let where = ''
    for (const key of Object.keys(options)) {
      if (options[key] !== undefined) {
        if (options[key] !== undefined) {
          where += `${key}: "${options[key] as string}"\n`
        }
      }
    }

    const query = gql`{
      tokens(where: {
        ${where}
      }) {
        id
      }
    }`

    return context.getObservableList(
      query,
      (r: any) => new Token(r.id, context),
      apolloQueryOptions
    )
  }

  constructor(public address: Address, public context: Arc) {
    if (!address) {
      throw Error(`No address provided - cannot create Token instance`)
    }
    isAddress(address)
  }

  public state(): Observable<ITokenState> {
    const query = gql`{
      token(id: "${this.address.toLowerCase()}") {
        id,
        dao {
          id
        },
        name,
        symbol,
        totalSupply
      }
    }`

    const itemMap = (item: any): ITokenState => {
      if (item === null) {
        throw Error(`Could not find a token contract with address ${this.address.toLowerCase()}`)
      }
      return {
        address: item.id,
        name: item.name,
        owner: item.dao.id,
        symbol: item.symbol,
        totalSupply: new BN(item.totalSupply)
      }
    }
    return this.context.getObservableObject(query, itemMap) as Observable<ITokenState>
  }

  public balanceOf(owner: string): IObservableWithFirst<typeof BN> {
    const observable = Observable.create(async (observer: Observer<typeof BN>) => {
      const contract = this.contract()
      let subscription: Subscription
      contract.methods.balanceOf(owner).call()
        .then((balance: number) => {
          if (balance === null) {
            observer.error(`balanceOf ${owner} returned null`)
          }
          observer.next(new BN(balance))
          subscription = contract.events.Transfer({ filter: { _to: owner }})
            .on('data', () => {
              // const newBalance = data.returnValues.value
              contract.methods.balanceOf(owner).call().then((newBalance: number) => {
                observer.next(new BN(newBalance))
              })
            })
        })
        .catch((err: Error) => { observer.error(err)})
      return () => {
        if (subscription) { subscription.unsubscribe() }
      }
    })
    observable.first = () => observable.pipe(first()).toPromise()
    return observable
  }

  public allowance(owner: Address, spender: Address): Observable<typeof BN> {
    return Observable.create(async (observer: Observer<typeof BN>) => {
      let subscription: Subscription
      const contract = this.contract()
      contract.methods.allowance(owner, spender).call()
        .then((balance: number) => {
          if (balance === null) {
            observer.error(`balanceOf ${owner} returned null`)
          }
          observer.next(new BN(balance))
          subscription = contract.events.Approval({ filter: { _owner: owner }})
            .on('data', () => {
              // const newBalance = data.returnValues.value
              contract.methods.allowance(owner, spender).call().then((newBalance: number) => {
                observer.next(new BN(newBalance))
            })
          })
        })
        .catch((err: Error) => { observer.error(err)})
      return () => {
        if (subscription) {
          console.log('close allowance subscription')
          subscription.unsubscribe()
        }
      }
    })
  }

  /*
   * get a web3 contract instance for this token
   */
  public contract() {
    const ReputationContractInfo = require('@daostack/arc/build/contracts/DAOToken.json')
    return new this.context.web3.eth.Contract(ReputationContractInfo.abi, this.address)
  }

  public mint(beneficiary: Address, amount: typeof BN) {
    const contract = this.contract()
    const transaction = contract.methods.mint(beneficiary, amount.toString())
    const mapReceipt = (receipt: Web3Receipt) => receipt
    return this.context.sendTransaction(transaction, mapReceipt)
  }

  public transfer(beneficiary: Address, amount: typeof BN) {
    const contract = this.contract()
    const transaction = contract.methods.transfer(beneficiary, amount.toString())
    const mapReceipt = (receipt: Web3Receipt) => receipt
    return this.context.sendTransaction(transaction, mapReceipt)
  }

  public approveForStaking(amount: typeof BN) {
    const stakingToken = this.contract()
    const genesisProtocol = this.context.getContract('GenesisProtocol')

    const transaction = stakingToken.methods.approve(genesisProtocol.options.address, amount.toString())

    const mapReceipt = (receipt: Web3Receipt) => {
      if (Object.keys(receipt.events).length  === 0) {
        // this does not mean that anything failed,
        return receipt
      } else {
        return receipt
      }
    }
    return this.context.sendTransaction(transaction, mapReceipt)
  }
}
