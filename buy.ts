import {
  BigNumberish,
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  Commitment,
} from '@solana/web3.js';
import { getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './liquidity';
import { retry } from './utils';
import { retrieveEnvVariable, retrieveTokenValueByAddress} from './utils';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market';
import { MintLayout } from './types';
import pino from 'pino';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';

const transport = pino.transport({
  targets: [
    // {
    //   level: 'trace',
    //   target: 'pino/file',
    //   options: {
    //     destination: 'buy.log',
    //   },
    // },

    {
      level: 'trace',
      target: 'pino-pretty',
      options: {},
    },
  ],
});

export const logger = pino(
  {
    level: 'trace',
    redact: ['poolKeys'],
    serializers: {
      error: pino.stdSerializers.err,
    },
    base: undefined,
  },
  transport,
);

const network = 'mainnet-beta';
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

export type MinimalTokenAccountData = {
  mint: PublicKey;
  address: PublicKey;
  buyValue?: number;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
};

let existingLiquidityPools: Set<string> = new Set<string>();
let existingOpenBookMarkets: Set<string> = new Set<string>();
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteMinPoolSizeAmount: TokenAmount;
let commitment: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;

const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
const STOP_LOSS = Number(retrieveEnvVariable('STOP_LOSS', logger));
const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED', logger) === 'true';
const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);

let snipeList: string[] = [];

async function init(): Promise<void> {
  // get wallet
  const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // get quote mint and amount
  const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
  const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      break;
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      );
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
      break;
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`);
    }
  }

  logger.info(`Snipe list: ${USE_SNIPE_LIST}`);
  logger.info(`Check mint renounced: ${CHECK_IF_MINT_IS_RENOUNCED}`);
  logger.info(
    `Min pool size: ${quoteMinPoolSizeAmount.isZero() ? 'false' : quoteMinPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
  );
  logger.info(`Buy amount: ${quoteAmount.toFixed()} ${quoteToken.symbol}`);
  logger.info(`Auto sell: ${AUTO_SELL}`);

  // check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    });
  }

  const tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString())!;

  if (!tokenAccount) {
    throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
  }

  quoteTokenAssociatedAddress = tokenAccount.pubkey;

  // load tokens to snipe
  loadSnipeList();
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata,
    mint: mint,
    market: <MinimalMarketLayoutV3>{
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  };
  existingTokenAccounts.set(mint.toString(), tokenAccount);
  return tokenAccount;
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  if (!shouldBuy(poolState.baseMint.toString())) {
    return;
  }

  if (CHECK_IF_MINT_IS_RENOUNCED) {
    const mintOption = await checkMintable(poolState.baseMint);

    if (mintOption !== true) {
      logger.warn({ mint: poolState.baseMint }, 'Skipping, owner can mint tokens!');
      return;
    }
  }

  await buy(id, poolState);
}

export async function checkMintable(vault: PublicKey): Promise<boolean | undefined> {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {};
    if (!data) {
      return;
    }
    const deserialize = MintLayout.decode(data);
    return deserialize.mintAuthorityOption === 0;
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: vault }, `Failed to check if mint is renounced`);
  }
}

export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);

    // to be competitive, we collect market data before buying the token...
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }

    saveTokenAccount(accountData.baseMint, accountData);
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: accountData?.baseMint }, `Failed to process market`);
  }
}

async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {
  try {
    let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());

    if (!tokenAccount) {
      // it's possible that we didn't have time to fetch open book data
      const market = await getMinimalMarketV3(solanaConnection, accountData.marketId, commitment);
      tokenAccount = saveTokenAccount(accountData.baseMint, market);
    }

    tokenAccount.poolKeys = createPoolKeys(accountId, accountData, tokenAccount.market!);
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: tokenAccount.poolKeys,
        userKeys: {
          tokenAccountIn: quoteTokenAssociatedAddress,
          tokenAccountOut: tokenAccount.address,
          owner: wallet.publicKey,
        },
        amountIn: quoteAmount.raw,
        minAmountOut: 0,
      },
      tokenAccount.poolKeys.version,
    );

    const latestBlockhash = await solanaConnection.getLatestBlockhash({
      commitment: commitment,
    });
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }),
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          tokenAccount.address,
          wallet.publicKey,
          accountData.baseMint,
        ),
        ...innerTransaction.instructions,
      ],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);
    const rawTransaction = transaction.serialize();
    const signature = await retry(
    () =>
      solanaConnection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
      }),
    { retryIntervalMs: 10, retries: 50 }, // TODO handle retries more efficiently
  );
    logger.info({ mint: accountData.baseMint, signature }, `Sent buy tx`);
    const confirmation = await solanaConnection.confirmTransaction(
      {
        signature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
      },
      commitment,
    );
    const basePromise = solanaConnection.getTokenAccountBalance(accountData.baseVault, commitment);
    const quotePromise = solanaConnection.getTokenAccountBalance(accountData.quoteVault, commitment);

    await Promise.all([basePromise, quotePromise]);

    const baseValue = await basePromise;
    const quoteValue = await quotePromise;

    if (baseValue?.value?.uiAmount && quoteValue?.value?.uiAmount)
      tokenAccount.buyValue = quoteValue?.value?.uiAmount / baseValue?.value?.uiAmount;
    if (!confirmation.value.err) {
      logger.info(
        {
          signature,
          url: `https://solscan.io/tx/${signature}?cluster=${network}`,
          dex: `https://dexscreener.com/solana/${accountData.baseMint}?maker=${wallet.publicKey}`,
        },
        `Confirmed buy tx... Bought at: ${tokenAccount.buyValue} SOL`,
      );
    } else {
      logger.debug(confirmation.value.err);
      logger.info({ mint: accountData.baseMint, signature }, `Error confirming buy tx`);
    }
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: accountData.baseMint }, `Failed to buy token`);
  }
}

async function sell(accountId: PublicKey, mint: PublicKey, amount: BigNumberish, value: number): Promise<boolean> {
  let retries = 0;

  do {
    try {
      const tokenAccount = existingTokenAccounts.get(mint.toString());
      if (!tokenAccount) {
        return true;
      }

      if (!tokenAccount.poolKeys) {
        logger.warn({ mint }, 'No pool keys found');
        continue;
      }

      if (amount === 0) {
        logger.info(
          {
            mint: tokenAccount.mint,
          },
          `Empty balance, can't sell`,
        );
        return true;
      }

      // check st/tp
      if (tokenAccount.buyValue === undefined) return true;

      const netChange = (value - tokenAccount.buyValue) / tokenAccount.buyValue;
      if (netChange > STOP_LOSS && netChange < TAKE_PROFIT) return false;

      const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys: tokenAccount.poolKeys!,
          userKeys: {
            tokenAccountOut: quoteTokenAssociatedAddress,
            tokenAccountIn: tokenAccount.address,
            owner: wallet.publicKey,
          },
          amountIn: amount,
          minAmountOut: 0,
        },
        tokenAccount.poolKeys!.version,
      );

      const latestBlockhash = await solanaConnection.getLatestBlockhash({
        commitment: commitment,
      });
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400000 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
          ...innerTransaction.instructions,
          createCloseAccountInstruction(tokenAccount.address, wallet.publicKey, wallet.publicKey),
        ],
      }).compileToV0Message();
      
      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet, ...innerTransaction.signers]);
      const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: commitment,
      });
      logger.info({ mint, signature }, `Sent sell tx`);
      const confirmation = await solanaConnection.confirmTransaction(
        {
          signature,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          blockhash: latestBlockhash.blockhash,
        },
        commitment,
      );
      if (confirmation.value.err) {
        logger.debug(confirmation.value.err);
        logger.info({ mint, signature }, `Error confirming sell tx`);
        continue;
      }

      logger.info(
        {
          mint,
          signature,
          url: `https://solscan.io/tx/${signature}?cluster=${network}`,
          dex: `https://dexscreener.com/solana/${mint}?maker=${wallet.publicKey}`,
        },
        `Confirmed sell tx... Sold at: ${value}\tNet Profit: ${netChange * 100}%`,
      );
      return true;
    } catch (e: any) {
      retries++;
      logger.debug(e);
      logger.error({ mint }, `Failed to sell token, retry: ${retries}/${MAX_SELL_RETRIES}`);
    }
  } while (retries < MAX_SELL_RETRIES);
  return true;
}

// async function getMarkPrice(connection: Connection, baseMint: PublicKey, quoteMint?: PublicKey): Promise<number> {
//   const marketAddress = await Market.findAccountsByMints(
//     solanaConnection,
//     baseMint,
//     quoteMint === undefined ? Token.WSOL.mint : quoteMint,
//     TOKEN_PROGRAM_ID,
//   );

//   const market = await Market.load(solanaConnection, marketAddress[0].publicKey, {}, TOKEN_PROGRAM_ID);

//   const bestBid = (await market.loadBids(solanaConnection)).getL2(1)[0][0];
//   const bestAsk = (await market.loadAsks(solanaConnection)).getL2(1)[0][0];

//   return (bestAsk + bestBid) / 2;
// }

function loadSnipeList() {
  if (!USE_SNIPE_LIST) {
    return;
  }

  const count = snipeList.length;
  const data = fs.readFileSync(path.join(__dirname, 'snipe-list.txt'), 'utf-8');
  snipeList = data
    .split('\n')
    .map((a) => a.trim())
    .filter((a) => a);

  if (snipeList.length != count) {
    logger.info(`Loaded snipe list: ${snipeList.length}`);
  }
}

function shouldBuy(key: string): boolean {
  return USE_SNIPE_LIST ? snipeList.includes(key) : true;
}

const runListener = async () => {
  await init();
  const runTimestamp = Math.floor(new Date().getTime() / 1000);
  const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
      const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
      const existing = existingLiquidityPools.has(key);

      if (poolOpenTime > runTimestamp && !existing) {
        existingLiquidityPools.add(key);
        const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
      }
    },
    commitment,
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
          bytes: OPENBOOK_PROGRAM_ID.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
          bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
        },
      },
    ],
  );

  const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingOpenBookMarkets.has(key);
      if (!existing) {
        existingOpenBookMarkets.add(key);
        const _ = processOpenBookMarket(updatedAccountInfo);
      }
    },
    commitment,
    [
      { dataSize: MARKET_STATE_LAYOUT_V3.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
    ],
  );

  if (AUTO_SELL) {
    const walletSubscriptionId = solanaConnection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data);
        if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
          return;
        }
        let completed = false;
        while (!completed) {
          setTimeout(() => {}, 1000);
          const currValue = await retrieveTokenValueByAddress(accountData.mint.toBase58());
          if (currValue) {
            logger.info(accountData.mint, `Current Price: ${currValue} SOL`);
            completed = await sell(updatedAccountInfo.accountId, accountData.mint, accountData.amount, currValue);
          } 
        }
      },
      commitment,
      [
        {
          dataSize: 165,
        },
        {
          memcmp: {
            offset: 32,
            bytes: wallet.publicKey.toBase58(),
          },
        },
      ],
    );

    logger.info(`Listening for wallet changes: ${walletSubscriptionId}`);
  }

  logger.info(`Listening for raydium changes: ${raydiumSubscriptionId}`);
  logger.info(`Listening for open book changes: ${openBookSubscriptionId}`);

  if (USE_SNIPE_LIST) {
    setInterval(loadSnipeList, SNIPE_LIST_REFRESH_INTERVAL);
  }
};

runListener();
