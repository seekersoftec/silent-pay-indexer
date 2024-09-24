import { OperationStateService } from '@/operation-state/operation-state.service';
import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import {
    IndexerService,
    TransactionInput,
    TransactionOutput,
} from '@/indexer/indexer.service';

export abstract class BaseBlockDataProvider<OperationState> {
    protected readonly eventEmitter: EventEmitter = new EventEmitter();
    protected abstract readonly logger: Logger;
    protected abstract readonly operationStateKey: string;

    protected constructor(
        private readonly indexerService: IndexerService,
        private readonly operationStateService: OperationStateService,
    ) {}

    onBlockIndexed(
        listener: (data: { blockHeight: number; blockHash: string }) => void,
    ): void {
        this.eventEmitter.on('blockIndexed', listener);
    }

    async indexTransaction(
        txid: string,
        vin: TransactionInput[],
        vout: TransactionOutput[],
        blockHeight: number,
        blockHash: string,
    ): Promise<void> {
        await this.indexerService.index(
            txid,
            vin,
            vout,
            blockHeight,
            blockHash,
        );
        this.eventEmitter.emit('blockIndexed', { blockHeight, blockHash });
    }

    async getState(): Promise<OperationState> {
        return (
            await this.operationStateService.getOperationState(
                this.operationStateKey,
            )
        )?.state;
    }

    async setState(state: OperationState): Promise<void> {
        await this.operationStateService.setOperationState(
            this.operationStateKey,
            state,
        );
    }
}
