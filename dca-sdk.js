/**
 * DCA Service JavaScript SDK
 *
 * Easy integration for any website to use the DCA service.
 * Users just need Waves Keeper installed.
 *
 * Usage:
 *   const dca = new DCAService('3P...contract-address...');
 *   await dca.start({ fromAsset: 'WAVES', toAsset: 'USDT', ... });
 *   await dca.stop(sessionId);
 *   const info = await dca.getInfo(sessionId);
 */

class DCAService {
    constructor(contractAddress, network = 'mainnet') {
        this.contractAddress = contractAddress;
        this.network = network;
        this.nodeUrl = network === 'mainnet'
            ? 'https://nodes.wx.network'
            : 'https://nodes-testnet.wavesnodes.com';

        // Asset precision cache
        this.precisionCache = { 'WAVES': 8 };
    }

    /**
     * Wait for Waves Keeper to load
     */
    async waitForWavesKeeper(maxAttempts = 10) {
        console.log(window.WavesKeeper);
        for (let i = 0; i < maxAttempts; i++) {
            if (typeof WavesKeeper !== 'undefined') {
                return true;
            }
            await this.sleep(500);
        }
        return false;
    }

    /**
     * Check if Waves Keeper is installed
     */
    async checkWavesKeeper() {
        // Wait for Waves Keeper to load
        const loaded = await this.waitForWavesKeeper();

        if (!loaded || typeof WavesKeeper === 'undefined') {
            throw new Error(
                'Waves Keeper not found. ' +
                'Please install: https://waveskeeper.com/'
            );
        }

        try {
            const state = await WavesKeeper.publicState();

            if (!state.account) {
                throw new Error('Please unlock Waves Keeper and select an account');
            }

            const expectedNetwork = this.network === 'mainnet' ? 'W' : 'T';
            if (state.network.code !== expectedNetwork) {
                throw new Error(`Please switch to ${this.network} in Waves Keeper`);
            }

            return {
                address: state.account.address,
                publicKey: state.account.publicKey,
                network: state.network.code
            };

        } catch (error) {
            if (error.message && error.message.includes('User rejection')) {
                throw new Error('Please approve connection in Waves Keeper');
            }
            throw error;
        }
    }

    /**
     * Get asset precision (decimals)
     */
    async getAssetPrecision(assetId) {
        if (this.precisionCache[assetId]) {
            return this.precisionCache[assetId];
        }

        if (assetId === 'WAVES') {
            return 8;
        }

        try {
            const response = await fetch(`${this.nodeUrl}/assets/details/${assetId}`);
            const data = await response.json();
            const precision = data.decimals || 8;

            this.precisionCache[assetId] = precision;
            return precision;

        } catch (error) {
            console.warn(`Could not get precision for ${assetId}, using 8`);
            return 8;
        }
    }

    /**
     * Start a new DCA session
     *
     * @param {Object} config - DCA configuration
     * @param {string} config.fromAsset - Asset to swap from (e.g., 'WAVES')
     * @param {string} config.toAsset - Asset to swap to (asset ID)
     * @param {number} config.amount - Amount per swap (human-readable, e.g., 1.5)
     * @param {number} config.blocks - Blocks between swaps (e.g., 4)
     * @param {number} config.swaps - Total number of swaps (e.g., 10)
     * @param {number} config.minOut - Minimum output per swap (optional, human-readable)
     *
     * @returns {Promise<Object>} { sessionId, txId }
     */
    async start(config) {
        // Check Waves Keeper
        const wallet = await this.checkWavesKeeper();

        // Validate config
        if (!config.fromAsset || !config.toAsset) {
            throw new Error('fromAsset and toAsset are required');
        }
        if (!config.amount || config.amount <= 0) {
            throw new Error('amount must be positive');
        }
        if (!config.blocks || config.blocks <= 0) {
            throw new Error('blocks must be positive');
        }
        if (!config.swaps || config.swaps <= 0) {
            throw new Error('swaps must be positive');
        }

        // Get asset precision
        const fromPrecision = await this.getAssetPrecision(config.fromAsset);
        const toPrecision = await this.getAssetPrecision(config.toAsset);

        // Convert to smallest units
        const amountPerSwap = Math.floor(config.amount * Math.pow(10, fromPrecision));
        const totalAmount = amountPerSwap * config.swaps;
        const minimumOut = config.minOut
            ? Math.floor(config.minOut * Math.pow(10, toPrecision))
            : 0;

        // Calculate required WAVES for execution fees
        // 0.01 WAVES per swap (executeSwap involves nested PuzzleSwap invoke) + 0.005 WAVES reserve
        const executionFeePerSwap = 1000000; // 0.01 WAVES in smallest units
        const reserveFee = 500000; // 0.005 WAVES reserve
        const totalWavesRequired = (config.swaps * executionFeePerSwap) + reserveFee;

        // Prepare payments: [tokens to swap, WAVES for execution]
        const tokenPayment = {
            assetId: config.fromAsset === 'WAVES' ? null : config.fromAsset,
            amount: totalAmount
        };

        const wavesPayment = {
            assetId: null, // WAVES
            amount: totalWavesRequired
        };

        // Prepare transaction with TWO payments
        const txData = {
            type: 16, // InvokeScript
            data: {
                dApp: this.contractAddress,
                call: {
                    function: 'start',
                    args: [
                        { type: 'string', value: config.toAsset },
                        { type: 'integer', value: config.blocks },
                        { type: 'integer', value: minimumOut },
                        { type: 'integer', value: amountPerSwap },
                        { type: 'integer', value: config.swaps }
                    ]
                },
                payment: [tokenPayment, wavesPayment]
            }
        };

        console.log('Starting DCA session:', txData);

        try {
            // Sign and publish via Waves Keeper
            const result = await WavesKeeper.signAndPublishTransaction(txData);

            console.log('Transaction result:', result);

            // Extract session ID from state changes
            let sessionId = null;
            if (result.stateChanges && result.stateChanges.data) {
                const latestEntry = result.stateChanges.data.find(
                    entry => entry.key.startsWith('latest_')
                );
                if (latestEntry) {
                    sessionId = latestEntry.value;
                }
            }

            // If not in state changes, wait and query
            if (!sessionId) {
                await this.sleep(2000);
                sessionId = await this.getUserLatestSession(wallet.address);
            }

            return {
                success: true,
                sessionId: sessionId,
                txId: result.id,
                userAddress: wallet.address
            };

        } catch (error) {
            console.error('Error starting DCA:', error);
            throw new Error('Failed to start DCA: ' + error.message);
        }
    }

    /**
     * Stop a DCA session
     *
     * @param {string} sessionId - Session ID to stop
     * @returns {Promise<Object>} { txId }
     */
    async stop(sessionId) {
        // Check Waves Keeper
        await this.checkWavesKeeper();

        if (!sessionId) {
            throw new Error('sessionId is required');
        }

        // Prepare transaction
        const txData = {
            type: 16, // InvokeScript
            data: {
                dApp: this.contractAddress,
                call: {
                    function: 'stop',
                    args: [
                        { type: 'string', value: sessionId }
                    ]
                },
                payment: []
            }
        };

        console.log('Stopping DCA session:', sessionId);

        try {
            // Sign and publish via Waves Keeper
            const result = await WavesKeeper.signAndPublishTransaction(txData);

            console.log('Stop transaction result:', result);

            return {
                success: true,
                txId: result.id
            };

        } catch (error) {
            console.error('Error stopping DCA:', error);
            throw new Error('Failed to stop DCA: ' + error.message);
        }
    }

    /**
     * Pause a DCA session
     *
     * @param {string} sessionId - Session ID to pause
     * @returns {Promise<Object>} { txId }
     */
    async pause(sessionId) {
        await this.checkWavesKeeper();

        if (!sessionId) {
            throw new Error('sessionId is required');
        }

        const txData = {
            type: 16,
            data: {
                dApp: this.contractAddress,
                call: {
                    function: 'pauseSession',
                    args: [{ type: 'string', value: sessionId }]
                },
                payment: []
            }
        };

        try {
            const result = await WavesKeeper.signAndPublishTransaction(txData);
            return { success: true, txId: result.id };
        } catch (error) {
            throw new Error('Failed to pause session: ' + error.message);
        }
    }

    /**
     * Resume a paused DCA session
     *
     * @param {string} sessionId - Session ID to resume
     * @returns {Promise<Object>} { txId }
     */
    async resume(sessionId) {
        await this.checkWavesKeeper();

        if (!sessionId) {
            throw new Error('sessionId is required');
        }

        const txData = {
            type: 16,
            data: {
                dApp: this.contractAddress,
                call: {
                    function: 'resumeSession',
                    args: [{ type: 'string', value: sessionId }]
                },
                payment: []
            }
        };

        try {
            const result = await WavesKeeper.signAndPublishTransaction(txData);
            return { success: true, txId: result.id };
        } catch (error) {
            throw new Error('Failed to resume session: ' + error.message);
        }
    }

    /**
     * Get session information
     *
     * @param {string} sessionId - Session ID to query
     * @returns {Promise<Object>} Session details
     */
    async getInfo(sessionId) {
        if (!sessionId) {
            throw new Error('sessionId is required');
        }

        try {
            // Query contract data
            const response = await fetch(
                `${this.nodeUrl}/addresses/data/${this.contractAddress}`
            );

            if (!response.ok) {
                throw new Error('Failed to fetch contract data');
            }

            const data = await response.json();

            // Parse session data
            const sessionData = {};
            data.forEach(entry => {
                const key = entry.key;

                if (key === `active_${sessionId}`) sessionData.active = entry.value;
                if (key === `owner_${sessionId}`) sessionData.owner = entry.value;
                if (key === `from_${sessionId}`) sessionData.fromAsset = entry.value;
                if (key === `to_${sessionId}`) sessionData.toAsset = entry.value;
                if (key === `blocks_${sessionId}`) sessionData.blocksPerTrade = entry.value;
                if (key === `minout_${sessionId}`) sessionData.minOut = entry.value;
                if (key === `amount_${sessionId}`) sessionData.amountPerSwap = entry.value;
                if (key === `remaining_${sessionId}`) sessionData.remaining = entry.value;
                if (key === `total_${sessionId}`) sessionData.total = entry.value;
                if (key === `lastblock_${sessionId}`) sessionData.lastBlock = entry.value;
                if (key === `balance_${sessionId}`) sessionData.balance = entry.value;
                if (key === `wavesbalance_${sessionId}`) sessionData.wavesBalance = entry.value;
                if (key === `created_${sessionId}`) sessionData.created = entry.value;
                if (key === `paused_${sessionId}`) sessionData.paused = entry.value;
                if (key === `received_${sessionId}`) sessionData.totalReceived = entry.value;
            });

            if (!sessionData.owner) {
                throw new Error('Session not found');
            }

            // Get current height
            const heightResponse = await fetch(`${this.nodeUrl}/blocks/height`);
            const heightData = await heightResponse.json();
            const currentHeight = heightData.height;

            // Defaults for completed/stopped sessions (transient keys deleted)
            const blocksPerTrade = sessionData.blocksPerTrade || 0;
            const lastBlock      = sessionData.lastBlock || 0;
            const remaining      = sessionData.remaining || 0;
            const total          = sessionData.total || 0;
            const balance        = sessionData.balance || 0;
            const minOut         = sessionData.minOut || 0;
            const amountPerSwap  = sessionData.amountPerSwap || 0;
            const created        = sessionData.created || 0;

            // Calculate blocks until next swap
            const blocksPassed = currentHeight - lastBlock;
            const blocksUntilNext = blocksPerTrade > 0 ? Math.max(0, blocksPerTrade - blocksPassed) : 0;

            // Get asset precision for human-readable amounts
            const fromPrecision = sessionData.fromAsset ? await this.getAssetPrecision(sessionData.fromAsset) : 0;
            const toPrecision = sessionData.toAsset ? await this.getAssetPrecision(sessionData.toAsset) : 0;

            return {
                id: sessionId,
                active: sessionData.active || false,
                owner: sessionData.owner,
                fromAsset: sessionData.fromAsset || '',
                toAsset: sessionData.toAsset || '',
                blocksPerTrade: blocksPerTrade,
                minOut: toPrecision > 0 ? minOut / Math.pow(10, toPrecision) : minOut,
                amountPerSwap: fromPrecision > 0 ? amountPerSwap / Math.pow(10, fromPrecision) : amountPerSwap,
                remaining: remaining,
                total: total,
                completed: total - remaining,
                progress: total > 0 ? ((total - remaining) / total * 100).toFixed(1) : '0.0',
                lastBlock: lastBlock,
                balance: fromPrecision > 0 ? balance / Math.pow(10, fromPrecision) : balance,
                wavesBalance: (sessionData.wavesBalance || 0) / 1e8,
                created: created > 0 ? new Date(created).toISOString() : '',
                blocksUntilNext: blocksUntilNext,
                currentHeight: currentHeight,
                paused: sessionData.paused || false,
                totalReceived: toPrecision > 0 ? (sessionData.totalReceived || 0) / Math.pow(10, toPrecision) : (sessionData.totalReceived || 0)
            };

        } catch (error) {
            console.error('Error getting session info:', error);
            throw new Error('Failed to get session info: ' + error.message);
        }
    }

    /**
     * Get user's latest session ID
     */
    async getUserLatestSession(userAddress) {
        try {
            const response = await fetch(
                `${this.nodeUrl}/addresses/data/${this.contractAddress}/latest_${userAddress}`
            );

            if (!response.ok) {
                throw new Error('No sessions found for user');
            }

            const data = await response.json();
            return data.value;

        } catch (error) {
            console.error('Error getting latest session:', error);
            return null;
        }
    }

    /**
     * Get all sessions for a user (scans contract data directly)
     */
    async getUserSessions(userAddress) {
        try {
            console.log('[SDK] Fetching sessions for:', userAddress);
            console.log('[SDK] Contract:', this.contractAddress);

            // Fetch all contract data
            const url = `${this.nodeUrl}/addresses/data/${this.contractAddress}`;
            const response = await fetch(url);

            if (!response.ok) {
                console.error('[SDK] Failed to fetch contract data');
                return [];
            }

            const allData = await response.json();
            const sessionIds = new Set();

            // Find all session IDs where owner matches this user
            allData.forEach(entry => {
                if (entry.key.startsWith('owner_') && entry.value === userAddress) {
                    const sessionId = entry.key.replace('owner_', '');
                    sessionIds.add(sessionId);
                    console.log(`[SDK] Found session: ${sessionId.substring(0, 8)}...`);
                }
            });

            console.log(`[SDK] Found ${sessionIds.size} sessions`);

            // Get info for each session
            const sessions = [];
            for (const sessionId of sessionIds) {
                try {
                    const info = await this.getInfo(sessionId);
                    sessions.push(info);
                    console.log(`[SDK] Session ${sessionId.substring(0, 8)}... - ${info.active ? 'ACTIVE' : 'INACTIVE'}`);
                } catch (error) {
                    console.warn(`[SDK] Could not get info for session ${sessionId}:`, error.message);
                }
            }

            console.log(`[SDK] Returning ${sessions.length} sessions`);
            return sessions;

        } catch (error) {
            console.error('[SDK] Error getting user sessions:', error);
            throw new Error('Failed to get user sessions: ' + error.message);
        }
    }


    /**
     * Update the minimum output per swap for an active session
     *
     * @param {string} sessionId - Session ID
     * @param {number} newMinOut - New minimum output (human-readable)
     * @returns {Promise<Object>} { txId }
     */
    async updateMinOut(sessionId, newMinOut) {
        await this.checkWavesKeeper();

        if (!sessionId) throw new Error('sessionId is required');
        if (!newMinOut || newMinOut <= 0) throw new Error('newMinOut must be positive');

        const info = await this.getInfo(sessionId);
        const toPrecision = await this.getAssetPrecision(info.toAsset);
        const newMinOutRaw = Math.floor(newMinOut * Math.pow(10, toPrecision));

        const txData = {
            type: 16,
            data: {
                dApp: this.contractAddress,
                call: {
                    function: 'updateMinOut',
                    args: [
                        { type: 'string',  value: sessionId },
                        { type: 'integer', value: newMinOutRaw }
                    ]
                },
                payment: []
            }
        };

        try {
            const result = await WavesKeeper.signAndPublishTransaction(txData);
            return { success: true, txId: result.id };
        } catch (error) {
            throw new Error('Failed to update minOut: ' + error.message);
        }
    }

    /**
     * Helper: Sleep
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get transaction details
     */
    async getTransaction(txId) {
        try {
            const response = await fetch(`${this.nodeUrl}/transactions/info/${txId}`);

            if (!response.ok) {
                throw new Error('Transaction not found');
            }

            return await response.json();

        } catch (error) {
            console.error('Error getting transaction:', error);
            return null;
        }
    }

    /**
     * Wait for transaction confirmation
     */
    async waitForTransaction(txId, maxAttempts = 30) {
        for (let i = 0; i < maxAttempts; i++) {
            const tx = await this.getTransaction(txId);

            if (tx) {
                return tx;
            }

            await this.sleep(2000);
        }

        throw new Error('Transaction confirmation timeout');
    }
}

// Export for use in Node.js or browsers
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DCAService;
}
