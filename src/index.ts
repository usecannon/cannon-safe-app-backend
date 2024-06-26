import _ from "lodash";
import express from "express";
import morgan from "morgan";
import { ethers } from "ethers";
import * as viemChains from "viem/chains";

import SafeABI from "./abi/Safe.json";

const chains = Object.values(viemChains);

type SafeTransaction = {
	to: string;
	value: string;
	data: string;
	operation: string;
	safeTxGas: string;
	baseGas: string;
	gasPrice: string;
	gasToken: string;
	refundReceiver: string;
	_nonce: number;
};

type StagedTransaction = {
	txn: SafeTransaction;
	sigs: string[];
};

// arbitrary limits to harden the server a bit
const MAX_SIGS = 100;
const MAX_TXNS_STAGED = 100;
const MAX_TXDATA_SIZE = 1000000;

async function start() {
	const txdb = new Map<string, Map<string, StagedTransaction>>();
	const providers = new Map<number, ethers.Provider>();

	for (const rpcUrl of process.env.RPC_URLS?.split(",") || []) {
		const provider = new ethers.JsonRpcProvider(rpcUrl);
		const { chainId } = await provider.getNetwork();
		providers.set(Number(`${chainId}`), provider);
	}

	function getProvider(chainId: string | number | bigint) {
		const id = Number(`${chainId}`);
		const provider = providers.get(id);

		if (provider) return provider;

		const chain = chains.find((chain) => chain.id === id);
		if (!chain) return null;
		const rpcUrl = chain.rpcUrls.default.http[0];
		if (!rpcUrl) return null;

		const newProvider = new ethers.JsonRpcProvider(rpcUrl);

		providers.set(id, newProvider);

		return newProvider;
	}

	function getSafeKey(chainId: number, safeAddress: string) {
		return `${chainId}-${safeAddress.toLowerCase()}`;
	}

	const app = express();

	app.use(morgan("tiny"));
	app.use(express.json());

	app.use((_req, res, next) => {
		res.appendHeader("Access-Control-Allow-Origin", "*");
		res.appendHeader("Access-Control-Allow-Methods", "*");
		res.appendHeader("Access-Control-Allow-Headers", "*");
		next();
	});

	function parseSafeParams(params: { chainId: string; safeAddress: string }) {
		const chainId = Number.parseInt(params.chainId);
		if (!Number.isSafeInteger(chainId) || chainId < 1) return {};
		if (!ethers.isAddress(params.safeAddress)) return {};
		const safeAddress = ethers.getAddress(params.safeAddress.toLowerCase());
		return { chainId, safeAddress };
	}

	app.get("/:chainId/:safeAddress", (req, res) => {
		const { chainId, safeAddress } = parseSafeParams(req.params);

		if (!chainId || !safeAddress) {
			return res.status(400).send("invalid chain id or safe address");
		}

		res.send(
			_.sortBy(
				Array.from(txdb.get(getSafeKey(chainId, safeAddress))?.values() ?? []),
				(t) => t.txn._nonce,
			),
		);
	});

	app.post("/:chainId/:safeAddress", async (req, res) => {
		const { chainId, safeAddress } = parseSafeParams(req.params);

		if (!chainId || !safeAddress) {
			return res.status(400).send("invalid chain id or safe address");
		}

		if (JSON.stringify(req.body).length > MAX_TXDATA_SIZE) {
			return res.status(400).send("txn too large");
		}

		try {
			const signedTransactionInfo: StagedTransaction = req.body;
			const provider = getProvider(chainId);

			if (!provider) {
				return res.status(400).send("chain id not supported");
			}

			const safe = new ethers.Contract(safeAddress, SafeABI, provider);

			const txs = txdb.get(getSafeKey(chainId, safeAddress)) || new Map();

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
				signedTransactionInfo.txn._nonce,
			);

			const digest = ethers.keccak256(hashData);

			const existingTx = txs.get(digest);

			const currentNonce: bigint = await safe.nonce();

			if (!existingTx) {
				if (txs.size > MAX_TXNS_STAGED) {
					return res.status(400).send("maximum staged signatures for this safe");
				}
				// verify the new txn will work on what we know about the safe right now

				if (signedTransactionInfo.txn._nonce < currentNonce) {
					return res.status(400).send("proposed nonce is lower than current safe nonce");
				}

				if (
					signedTransactionInfo.txn._nonce > currentNonce &&
					!Array.from(txs.values()).find(
						(tx) => tx.txn._nonce === signedTransactionInfo.txn._nonce - 1,
					)
				) {
					return res
						.status(400)
						.send("proposed nonce is higher than current safe nonce with missing staged");
				}
			} else {
				// its possible if two or more people sign transactions at the same time, they will have separate lists, and so they need to be merged together.
				// we also sort the signatures for the user here so that isnt a requirement when submitting signatures to this service
				signedTransactionInfo.sigs = _.sortBy(
					_.union(signedTransactionInfo.sigs, existingTx.sigs),
					(signature) => {
						const signatureBytes = ethers.getBytes(signature);

						// for some reason its often necessary to adjust the version field -4 if its above 30
						if (_.last(signatureBytes)! > 30) {
							signatureBytes[signatureBytes.length - 1] -= 4;
						}

						return ethers
							.recoverAddress(
								ethers.hashMessage(ethers.getBytes(digest)),
								ethers.hexlify(signatureBytes),
							)
							.toLowerCase();
					},
				);

				if (signedTransactionInfo.sigs.length > MAX_SIGS) {
					return res.status(400).send("maximum signatures reached for transaction");
				}
			}

			try {
				await safe.checkNSignatures(
					digest,
					hashData,
					ethers.concat(signedTransactionInfo.sigs),
					signedTransactionInfo.sigs.length,
				);
			} catch (err) {
				console.log("failed checking n signatures", err);
				return res.status(400).send("invalid signature");
			}

			txs.set(digest, signedTransactionInfo);

			// briefly clean up any txns that are less than current nonce, and any transactions with dup hashes to this one
			for (const [h, t] of txs.entries()) {
				if (
					t.txn._nonce < currentNonce ||
					(t !== signedTransactionInfo && _.isEqual(t.txn, signedTransactionInfo.txn))
				) {
					txs.delete(h);
				}
			}

			txdb.set(getSafeKey(chainId, safeAddress), txs);

			res.send(_.sortBy(Array.from(txs.values()), (t) => t._nonce));
		} catch (err) {
			console.error("caught failure in transaction post", err);
			res.status(500).end("unexpected error, please check server logs");
		}
	});

	const port = parseInt(process.env.PORT || "3000");

	app.listen(port, () => {
		console.log(`started on port ${port}`);
		console.log("registered networks:", Array.from(providers.keys()).join(" "));
	});
}

start();
