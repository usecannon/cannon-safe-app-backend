import _ from 'lodash'
import express from 'express'
import morgan from 'morgan'
import { ethers } from 'ethers'
import * as viemChains from 'viem/chains'

const chains = Object.values(viemChains)

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SafeABI = require('./abi/Safe.json')

type SafeTransaction = {
  to: string
  value: string
  data: string
  operation: string
  safeTxGas: string
  baseGas: string
  gasPrice: string
  gasToken: string
  refundReceiver: string
  _nonce: number
}

type StagedTransaction = {
  txn: SafeTransaction
  sigs: string[]
}

async function start() {
  const txdb = new Map<string, StagedTransaction[]>()
  const providers = new Map<number, ethers.Provider>()

  for (const rpcUrl of process.env.RPC_URLS?.split(',') || []) {
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const { chainId } = await provider.getNetwork()
    providers.set(Number(`${chainId}`), provider)
  }

  function getProvider(chainId: string | number | bigint) {
    const id = Number(`${chainId}`)
    const provider = providers.get(id)

    if (provider) return provider

    const chain = chains.find((chain) => chain.id === id)
    if (!chain) return null
    const rpcUrl = chain.rpcUrls.default.http[0]
    if (!rpcUrl) return null

    const newProvider = new ethers.JsonRpcProvider(rpcUrl)

    providers.set(id, newProvider)

    return newProvider
  }

  function getSafeKey(chainId: number, safeAddress: string) {
    return `${chainId}-${safeAddress.toLowerCase()}`
  }

  const app = express()

  app.use(morgan('tiny'))
  app.use(express.json())

  app.use((_req, res, next) => {
    res.appendHeader('Access-Control-Allow-Origin', '*')
    res.appendHeader('Access-Control-Allow-Methods', '*')
    res.appendHeader('Access-Control-Allow-Headers', '*')
    next()
  })

  function parseSafeParams(params: { chainId: string, safeAddress: string }) {
    const chainId = Number.parseInt(params.chainId)
    if (!Number.isSafeInteger(chainId) || chainId < 1) return {};
    if (!ethers.isAddress(params.safeAddress)) return {};
    const safeAddress = ethers.getAddress(params.safeAddress.toLowerCase())
    return { chainId, safeAddress };
  }

  app.get('/:chainId/:safeAddress', (req, res) => {
    const { chainId, safeAddress } = parseSafeParams(req.params)

    if (!chainId || !safeAddress) {
      return res.status(400).send('invalid chain id or safe address')
    }

    res.send(txdb.get(getSafeKey(chainId, safeAddress)) || [])
  })

  app.post('/:chainId/:safeAddress', async (req, res) => {
    const { chainId, safeAddress } = parseSafeParams(req.params)

    if (!chainId || !safeAddress) {
      return res.status(400).send('invalid chain id or safe address')
    }

    try {
      const signedTransactionInfo: StagedTransaction = req.body
      const provider = getProvider(chainId)

      if (!provider) {
        return res.status(400).send('chain id not supported')
      }

      const safe = new ethers.Contract(
        safeAddress,
        SafeABI,
        provider
      )

      const txs = txdb.get(getSafeKey(chainId, safeAddress)) || []

      const existingTx = txs.find(
        (tx) => JSON.stringify(tx.txn) == JSON.stringify(signedTransactionInfo)
      )

      const currentNonce: bigint = await safe.nonce()

      if (!existingTx) {
        // verify the new txn will work on what we know about the safe right now

        if (signedTransactionInfo.txn._nonce < currentNonce) {
          return res
            .status(400)
            .send('proposed nonce is lower than current safe nonce')
        }

        if (
          signedTransactionInfo.txn._nonce > currentNonce &&
          !txs.find(
            (tx) => tx.txn._nonce === signedTransactionInfo.txn._nonce - 1
          )
        ) {
          return res
            .status(400)
            .send(
              'proposed nonce is higher than current safe nonce with missing staged'
            )
        }
      } else {
        // verify that new signers list is longer than old signers list
        if (existingTx.sigs.length >= signedTransactionInfo.sigs.length) {
          return res
            .status(400)
            .send('new sigs count must be greater than old sigs count')
        }
      }

      // verify all sigs are valid
      const hashData = await safe.encodeTransactionData(
        signedTransactionInfo.txn.to,
        signedTransactionInfo.txn.value,
        signedTransactionInfo.txn.data,
        signedTransactionInfo.txn.operation,
        signedTransactionInfo.txn.safeTxGas,
        signedTransactionInfo.txn.baseGas,
        signedTransactionInfo.txn.gasPrice,
        signedTransactionInfo.txn.gasToken,
        signedTransactionInfo.txn.refundReceiver,
        signedTransactionInfo.txn._nonce
      )

      try {
        await safe.checkNSignatures(
          ethers.keccak256(hashData),
          hashData,
          ethers.concat(signedTransactionInfo.sigs),
          signedTransactionInfo.sigs.length
        )
      } catch (err) {
        console.log('failed checking n signatures', err)
        return res.status(400).send('invalid signature')
      }

      txs.push(signedTransactionInfo)

      txdb.set(
        getSafeKey(chainId, safeAddress),
        // briefly clean up any txns that are less than current nonce, and any transactions with dup hashes to this one
        txs.filter((t) =>
        t.txn._nonce >= currentNonce &&
        (t === signedTransactionInfo || !_.isEqual(t.txn, signedTransactionInfo.txn)))
      )

      res.send(txs)
    } catch (err) {
      console.error('caught failure in transaction post', err)
      res.status(500).end('unexpected error, please check server logs')
    }
  })

  app.listen(parseInt(process.env.PORT || '3000'), () => {
    console.log('started')
    console.log('registered networks:', Array.from(providers.keys()).join(' '))
  })
}

start()
