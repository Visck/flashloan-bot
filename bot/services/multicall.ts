import { ethers, Contract, Provider } from 'ethers';

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
    'function aggregate3Value(tuple(address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])'
];

export interface Call {
    target: string;
    allowFailure: boolean;
    callData: string;
}

export interface CallResult {
    success: boolean;
    returnData: string;
}

export class Multicall {
    private contract: Contract;
    private provider: Provider;

    constructor(provider: Provider) {
        this.provider = provider;
        this.contract = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
    }

    async aggregate(calls: Call[], retries: number = 2): Promise<CallResult[]> {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const results = await this.contract.aggregate3.staticCall(calls);
                return results.map((r: any) => ({
                    success: r.success,
                    returnData: r.returnData
                }));
            } catch (error) {
                if (attempt === retries) {
                    // Retorna resultados vazios ao invés de lançar erro
                    // Permite que o bot continue funcionando
                    return calls.map(() => ({ success: false, returnData: '0x' }));
                }
                // Espera 500ms antes de tentar novamente
                await new Promise(r => setTimeout(r, 500));
            }
        }
        return calls.map(() => ({ success: false, returnData: '0x' }));
    }

    async callMultiple<T>(
        contracts: { contract: Contract; method: string; args: any[] }[]
    ): Promise<(T | null)[]> {
        const calls: Call[] = contracts.map(({ contract, method, args }) => ({
            target: contract.target as string,
            allowFailure: true,
            callData: contract.interface.encodeFunctionData(method, args)
        }));

        const results = await this.aggregate(calls);

        return results.map((result, i) => {
            if (!result.success) return null;
            try {
                const decoded = contracts[i].contract.interface.decodeFunctionResult(
                    contracts[i].method,
                    result.returnData
                );
                return decoded.length === 1 ? decoded[0] : decoded;
            } catch {
                return null;
            }
        });
    }
}

export async function batchGetUserAccountData(
    multicall: Multicall,
    poolContract: Contract,
    users: string[]
): Promise<Map<string, any>> {
    const calls = users.map(user => ({
        contract: poolContract,
        method: 'getUserAccountData',
        args: [user]
    }));

    const results = await multicall.callMultiple(calls);
    const userDataMap = new Map<string, any>();

    results.forEach((result, index) => {
        if (result) {
            userDataMap.set(users[index], result);
        }
    });

    return userDataMap;
}
