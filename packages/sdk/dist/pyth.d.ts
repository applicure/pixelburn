import * as _pythnetwork_pyth_solana_receiver from '@pythnetwork/pyth-solana-receiver';
import { PublicKey, Connection, TransactionInstruction, VersionedTransaction, Signer } from '@solana/web3.js';
import { P as PythPrice } from './client-DheabJpC.js';
import 'bn.js';
import './quote-Dr1cW5Ot.js';

/** Minimal wallet shape accepted by the Pyth receiver client. */
interface PythWallet {
    publicKey: PublicKey;
    signTransaction: (tx: any) => Promise<any>;
    signAllTransactions: (txs: any[]) => Promise<any[]>;
}
/** Latest SOL/USD from Hermes REST: base64 accumulator payloads (for posting) + the parsed price (for quotes). */
declare function fetchHermesSolUsd(hermesUrl?: string, fetchImpl?: typeof fetch, 
/** Hermes now answers 401 without `Authorization: Bearer <key>`. */
apiKey?: string): Promise<{
    updateData: string[];
    price: PythPrice;
}>;
/**
 * Post-price-update instructions (fully verified). Returns the instructions with their ephemeral signers,
 * the PriceUpdateV2 account to pass to `buy_with_*`, and close instructions to reclaim rent afterwards.
 */
declare function buildPostPriceUpdateIxs(p: {
    connection: Connection;
    wallet: PythWallet;
    hermesUrl?: string;
    hermesApiKey?: string;
}): Promise<{
    postInstructions: _pythnetwork_pyth_solana_receiver.InstructionWithEphemeralSigners[];
    priceUpdateAccount: PublicKey;
    closeInstructions: _pythnetwork_pyth_solana_receiver.InstructionWithEphemeralSigners[];
}>;
/**
 * Full flow: post a fresh SOL/USD update, then `makeIxs(priceUpdateAccount)` (e.g. `buyWithSolIx`), then close the
 * update accounts. Returns versioned transactions + ephemeral signers for `signAllTransactions`.
 */
declare function buildTransactionsWithFreshPrice(p: {
    connection: Connection;
    wallet: PythWallet;
    makeIxs: (priceUpdate: PublicKey) => Promise<TransactionInstruction[]> | TransactionInstruction[];
    hermesUrl?: string;
    hermesApiKey?: string;
    closeUpdateAccounts?: boolean;
    computeUnitPriceMicroLamports?: number;
}): Promise<{
    tx: VersionedTransaction;
    signers: Signer[];
}[]>;

export { type PythWallet, buildPostPriceUpdateIxs, buildTransactionsWithFreshPrice, fetchHermesSolUsd };
