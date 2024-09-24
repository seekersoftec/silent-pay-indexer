import { ConfigService } from '@nestjs/config';
import { BitcoinCoreConfig } from '@/configuration.model';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { BitcoinNetwork } from '@/common/enum';
import {
    BITCOIN_CORE_FULL_VERBOSITY_VERSION,
    SATS_PER_BTC,
    TAPROOT_ACTIVATION_HEIGHT,
} from '@/common/constants';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
    IndexerService,
    TransactionInput,
    TransactionOutput,
} from '@/indexer/indexer.service';
import { OperationStateService } from '@/operation-state/operation-state.service';
import { BaseBlockDataProvider } from '@/block-data-providers/base-block-data-provider.abstract';
import {
    Block,
    BitcoinCoreOperationState,
    BlockTransaction,
    Transaction,
    Output,
    RPCRequestBody,
    Input,
    NetworkInfo,
} from '@/block-data-providers/bitcoin-core/interfaces';
import { AxiosRequestConfig } from 'axios';
import * as currency from 'currency.js';
import { AxiosRetryConfig, makeRequest } from '@/common/request';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class BitcoinCoreProvider
    extends BaseBlockDataProvider<BitcoinCoreOperationState>
    implements OnApplicationBootstrap
{
    protected readonly logger = new Logger(BitcoinCoreProvider.name);
    protected readonly operationStateKey = 'bitcoincore-operation-state';
    private readonly rpcUrl: string;
    private isSyncing = false;
    private retryConfig: AxiosRetryConfig;

    public constructor(
        private readonly configService: ConfigService,
        indexerService: IndexerService,
        operationStateService: OperationStateService,
        private eventEmitter: EventEmitter2,
    ) {
        super(indexerService, operationStateService);

        const { protocol, rpcPort, rpcHost } =
            configService.get<BitcoinCoreConfig>('bitcoinCore');

        this.rpcUrl = `${protocol}://${rpcHost}:${rpcPort}/`;

        this.retryConfig =
            this.configService.get<AxiosRetryConfig>('app.requestRetry');
    }

    async onApplicationBootstrap() {
        const getState = await this.getState();
        if (getState) {
            this.logger.log(
                `Restoring state from previous run: ${JSON.stringify(
                    getState,
                )}`,
            );
        } else {
            this.logger.log('No previous state found. Starting from scratch.');
            const state: BitcoinCoreOperationState = {
                currentBlockHeight: 0,
                indexedBlockHeight:
                    this.configService.get<BitcoinNetwork>('app.network') ===
                    BitcoinNetwork.MAINNET
                        ? TAPROOT_ACTIVATION_HEIGHT - 1
                        : 0,
            };

            await this.setState(state);
        }
    }

    @Cron(CronExpression.EVERY_10_SECONDS)
    async sync() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        const state = await this.getState();
        if (!state) {
            throw new Error('State not found');
        }

        try {
            const tipHeight = await this.getTipHeight();
            if (tipHeight <= state.indexedBlockHeight) {
                this.logger.debug(
                    `No new blocks found. Current tip height: ${tipHeight}`,
                );
                this.isSyncing = false;
                return;
            }

            const networkInfo = await this.getNetworkInfo();
            const verbosityLevel = this.versionToVerbosity(networkInfo.version);

            let height = state.indexedBlockHeight + 1;
            for (height; height <= tipHeight; height++) {
                const transactions = await this.processBlock(
                    height,
                    verbosityLevel,
                );

                for (const transaction of transactions) {
                    const { txid, vin, vout, blockHeight, blockHash } =
                        transaction;
                    await this.indexTransaction(
                        txid,
                        vin,
                        vout,
                        blockHeight,
                        blockHash,
                    );
                }

                state.indexedBlockHeight = height;
                this.eventEmitter.emit('blockIndexed', height);
                await this.setState(state);
            }
        } finally {
            this.isSyncing = false;
        }
    }

    private async getNetworkInfo(): Promise<NetworkInfo> {
        return this.request({
            method: 'getnetworkinfo',
            params: [],
        });
    }

    private async getTipHeight(): Promise<number> {
        return this.request({
            method: 'getblockcount',
            params: [],
        });
    }

    private async getBlockHash(height: number): Promise<string> {
        return this.request({
            method: 'getblockhash',
            params: [height],
        });
    }

    private async getBlock(hash: string, verbosity: number): Promise<Block> {
        return this.request({
            method: 'getblock',
            params: [hash, verbosity],
        });
    }

    private async getRawTransaction(
        txid: string,
        isVerbose: boolean,
    ): Promise<BlockTransaction> {
        return this.request({
            method: 'getrawtransaction',
            params: [txid, isVerbose],
        });
    }

    public async processBlock(
        height: number,
        verbosityLevel: number,
    ): Promise<Transaction[]> {
        const parsedTransactionList: Transaction[] = [];
        const blockHash = await this.getBlockHash(height);
        this.logger.debug(
            `Processing block at height ${height}, hash ${blockHash}`,
        );

        const block = await this.getBlock(blockHash, verbosityLevel);

        for (let i = 1; i < block.tx.length; i++) {
            const parsedTransaction = await this.parseTransaction(
                block.tx[i],
                block.hash,
                block.height,
            );
            parsedTransactionList.push(parsedTransaction);
        }

        return parsedTransactionList;
    }

    private async parseTransaction(
        txn: BlockTransaction,
        blockHash: string,
        blockHeight: number,
    ): Promise<Transaction> {
        const inputs: TransactionInput[] = await Promise.all(
            txn.vin.map(this.parseTransactionInput, this),
        );
        const outputs: TransactionOutput[] = txn.vout.map(
            this.parseTransactionOutput,
            this,
        );

        return {
            txid: txn.txid,
            vin: inputs,
            vout: outputs,
            blockHeight,
            blockHash,
        };
    }

    private async parseTransactionInput(
        txnInput: Input,
    ): Promise<TransactionInput> {
        let prevOutScript: string;
        const vout = txnInput.vout;

        if (txnInput.prevout != undefined) {
            prevOutScript = txnInput.prevout.scriptPubKey.hex;
        } else {
            const prevTransaction = await this.getRawTransaction(
                txnInput.txid,
                true,
            );

            prevOutScript = prevTransaction.vout.find((out) => out.n == vout)
                .scriptPubKey.hex;
        }

        return {
            txid: txnInput.txid,
            vout,
            scriptSig: txnInput.scriptSig.hex,
            witness: txnInput.txinwitness,
            prevOutScript,
        };
    }

    private parseTransactionOutput(txnOutput: Output): TransactionOutput {
        return {
            scriptPubKey: txnOutput.scriptPubKey.hex,
            value: this.convertToSatoshi(txnOutput.value),
        };
    }

    private async request(body: RPCRequestBody): Promise<any> {
        const { rpcUser, rpcPass } =
            this.configService.get<BitcoinCoreConfig>('bitcoinCore');

        const requestConfig: AxiosRequestConfig = {
            url: this.rpcUrl,
            method: 'POST',
            auth: {
                username: rpcUser,
                password: rpcPass,
            },
            data: {
                ...body,
                jsonrpc: '1.0',
                id: 'silent_payment_indexer',
            },
        };

        const response = await makeRequest(
            requestConfig,
            this.retryConfig,
            this.logger,
        );

        return response.result;
    }

    private convertToSatoshi(amount: number): number {
        return currency(amount, { precision: 8 }).multiply(SATS_PER_BTC).value;
    }

    private versionToVerbosity(version: number): 2 | 3 {
        return version >= BITCOIN_CORE_FULL_VERBOSITY_VERSION ? 3 : 2;
    }
}
