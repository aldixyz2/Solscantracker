// Solana Realtime Transaction Notifier
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const TelegramBot = require("node-telegram-bot-api");
const dotenv = require("dotenv");
const winston = require("winston");
const fs = require("fs");

// Load environment variables
dotenv.config();

// Configure logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

// Initialize Telegram bot
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  logger.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required!");
  process.exit(1);
}

const telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
logger.info("Telegram bot initialized");

// RPC configuration with fallbacks
const RPC_ENDPOINTS = [process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "https://solana-api.projectserum.com", "https://rpc.ankr.com/solana"];

// Add more reliable RPC endpoints
if (process.env.ADDITIONAL_RPC_URLS) {
  const additionalUrls = process.env.ADDITIONAL_RPC_URLS.split(",");
  RPC_ENDPOINTS.push(...additionalUrls);
}

// RPC connection management
let currentRpcIndex = 0;
let solanaConnection = null;

// Try to establish initial connection
function initializeRpcConnection() {
  try {
    solanaConnection = new Connection(RPC_ENDPOINTS[currentRpcIndex], {
      commitment: "confirmed",
      disableRetryOnRateLimit: true, // We'll handle retries manually
    });
    logger.info(`Connected to Solana RPC: ${RPC_ENDPOINTS[currentRpcIndex]}`);
    return true;
  } catch (error) {
    logger.error(`Failed to connect to RPC endpoint: ${error.message}`);
    return false;
  }
}

// First initialization
initializeRpcConnection();

// Function to rotate RPC endpoint with better error handling
function rotateRpcEndpoint() {
  // Keep track of our starting point
  const startingIndex = currentRpcIndex;

  do {
    // Move to next endpoint
    currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;

    try {
      solanaConnection = new Connection(RPC_ENDPOINTS[currentRpcIndex], {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
      });
      logger.info(`Switched to Solana RPC: ${RPC_ENDPOINTS[currentRpcIndex]}`);
      return true;
    } catch (error) {
      logger.warn(`Failed to connect to RPC endpoint ${RPC_ENDPOINTS[currentRpcIndex]}: ${error.message}`);

      // If we've tried all endpoints and come back to where we started, break
      if (currentRpcIndex === startingIndex) {
        logger.error("All RPC endpoints are unresponsive!");
        return false;
      }
    }
  } while (currentRpcIndex !== startingIndex);

  return false;
}

// Wallets to monitor - address as key, name as value
const WALLETS = {};

// Load wallet addresses from env vars (single entries)
for (let i = 1; i <= 10; i++) {
  const address = process.env[`WALLET${i}`];
  const name = process.env[`WALLET${i}_NAME`] || `Wallet ${i}`;
  if (address) {
    WALLETS[address] = name;
  }
}

// Load bulk wallet addresses from wallets.txt file
const WALLET_FILE = process.env.WALLET_FILE || "wallets.txt";
if (fs.existsSync(WALLET_FILE)) {
  try {
    const walletContent = fs.readFileSync(WALLET_FILE, "utf8");
    const walletLines = walletContent.split("\n");

    let bulkCount = 0;
    for (const line of walletLines) {
      // Skip empty lines
      if (!line.trim()) continue;

      // Parse each line - format can be:
      // - Just address
      // - address,name
      const parts = line.split(",");
      const address = parts[0].trim();

      // Validate address
      try {
        new PublicKey(address);
        const name = parts[1]?.trim() || `Bulk Wallet ${bulkCount + 1}`;
        WALLETS[address] = name;
        bulkCount++;
      } catch (err) {
        logger.warn(`Invalid wallet address in wallets.txt: ${address}`);
      }
    }

    logger.info(`Loaded ${bulkCount} wallets from ${WALLET_FILE}`);
  } catch (error) {
    logger.error(`Error loading wallets from file: ${error.message}`);
  }
}

if (Object.keys(WALLETS).length === 0) {
  logger.error("No wallet addresses configured. Please add wallet addresses in the .env file or wallets.txt.");
  process.exit(1);
}

logger.info(`Monitoring ${Object.keys(WALLETS).length} wallets for incoming transactions`);

// Store the latest signature for each wallet
const latestSignatures = {};

// Helper function to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Enhanced retry function with incremental backoff
async function withRetry(operation, maxAttempts = 10, initialDelay = 1000) {
  let attempts = 0;
  let lastError = null;

  while (attempts < maxAttempts) {
    try {
      if (!solanaConnection) {
        if (!initializeRpcConnection()) {
          throw new Error("No RPC connection available");
        }
      }

      return await operation();
    } catch (error) {
      lastError = error;
      attempts++;

      // Check if it's a rate limit error
      const isRateLimit = error.message.includes("429") || error.message.includes("Too many requests");

      // Calculate delay with exponential backoff
      const backoffDelay = isRateLimit
        ? Math.min(initialDelay * Math.pow(2, attempts), 60000) // Max 1 minute
        : initialDelay;

      logger.warn(`Operation failed (attempt ${attempts}/${maxAttempts}): ${error.message}`);

      if (attempts < maxAttempts) {
        // Try rotating to a new RPC endpoint
        rotateRpcEndpoint();

        logger.info(`Waiting ${backoffDelay / 1000} seconds before retrying...`);
        await delay(backoffDelay);
      }
    }
  }

  throw new Error(`Operation failed after ${maxAttempts} attempts. Last error: ${lastError?.message}`);
}

// Get signatures with better retry mechanism
async function getSignaturesWithRetry(publicKey, limit) {
  return withRetry(async () => {
    return await solanaConnection.getSignaturesForAddress(publicKey, { limit });
  });
}

// Get transaction with better retry mechanism
async function getTransactionWithRetry(signature) {
  return withRetry(async () => {
    return await solanaConnection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
  });
}

// Check if transaction is an incoming one (where our wallet is the destination)
async function isIncomingTransaction(txSignature, walletAddress) {
  try {
    const tx = await getTransactionWithRetry(txSignature);
    if (!tx || !tx.meta || !tx.meta.postBalances || !tx.meta.preBalances) {
      return { incoming: false };
    }

    // Find our wallet's index in the account keys
    const accountKeys = tx.transaction.message.accountKeys;
    const walletIndex = accountKeys.findIndex((key) => key.toBase58() === walletAddress);

    if (walletIndex === -1) return { incoming: false };

    // Check if wallet balance increased
    const preBalance = tx.meta.preBalances[walletIndex];
    const postBalance = tx.meta.postBalances[walletIndex];

    // If balance increased, it's an incoming transaction
    if (postBalance > preBalance) {
      const amountReceived = (postBalance - preBalance) / LAMPORTS_PER_SOL;
      return { incoming: true, amount: amountReceived };
    }

    return { incoming: false };
  } catch (error) {
    logger.error(`Error checking transaction ${txSignature}: ${error.message}`);
    return { incoming: false };
  }
}

// Format and send notification
async function sendTransactionAlert(address, txInfo, txDetails) {
  const walletName = WALLETS[address];

  let message = `
🔔 *Incoming SOL Detected*
Wallet: ${walletName}
Address: \`${address}\`
`;

  if (txDetails && txDetails.amount) {
    message += `Amount: *${txDetails.amount.toFixed(5)} SOL*\n`;
  }

  if (txInfo.blockTime) {
    message += `Time: ${new Date(txInfo.blockTime * 1000).toLocaleString()}\n`;
  }

  message += `Signature: \`${txInfo.signature.substring(0, 20)}...\`\n`;
  message += `[View on Explorer](https://solscan.io/tx/${txInfo.signature})`;

  try {
    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, message, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    logger.info(`Alert sent for incoming transaction to ${walletName}`);
    return true;
  } catch (error) {
    logger.error(`Failed to send alert: ${error.message}`);
    return false;
  }
}

// Check for new transactions
async function checkWallet(address) {
  try {
    logger.info(`Checking wallet: ${WALLETS[address]} (${address.substring(0, 10)}...)`);

    const publicKey = new PublicKey(address);
    const signatures = await getSignaturesWithRetry(publicKey, 5);

    if (!signatures || signatures.length === 0) {
      logger.info(`No transactions found for wallet: ${WALLETS[address]}`);
      return;
    }

    const lastKnownSignature = latestSignatures[address];
    if (!lastKnownSignature) {
      // First run, just store the latest signature
      latestSignatures[address] = signatures[0].signature;
      logger.info(`Initialized ${WALLETS[address]} with signature: ${signatures[0].signature.substring(0, 10)}...`);
      return;
    }

    // Find new transactions
    const newTxs = [];
    for (const tx of signatures) {
      if (tx.signature === lastKnownSignature) break;
      newTxs.push(tx);
    }

    if (newTxs.length === 0) {
      logger.info(`No new transactions for wallet: ${WALLETS[address]}`);
      return;
    }

    logger.info(`Found ${newTxs.length} new transactions for wallet: ${WALLETS[address]}`);

    // Update the latest signature
    latestSignatures[address] = signatures[0].signature;

    // Process new transactions (check if they're incoming)
    for (const tx of newTxs) {
      const txDetails = await isIncomingTransaction(tx.signature, address);
      if (txDetails.incoming) {
        await sendTransactionAlert(address, tx, txDetails);
      }
    }
  } catch (error) {
    logger.error(`Error checking wallet ${address}: ${error.message}`);
  }
}

// Initialize the latest signatures with better rate limit handling
async function initializeLatestSignatures() {
  const walletAddresses = Object.keys(WALLETS);

  // Process each wallet one at a time
  for (let i = 0; i < walletAddresses.length; i++) {
    const address = walletAddresses[i];

    try {
      logger.info(`Initializing wallet ${i + 1}/${walletAddresses.length}: ${WALLETS[address]}`);
      const publicKey = new PublicKey(address);
      const signatures = await getSignaturesWithRetry(publicKey, 1);

      if (signatures && signatures.length > 0) {
        latestSignatures[address] = signatures[0].signature;
        logger.info(`Initialized ${WALLETS[address]} with signature: ${latestSignatures[address].substring(0, 10)}...`);
      } else {
        latestSignatures[address] = null;
        logger.info(`No transactions found for ${WALLETS[address]}`);
      }
    } catch (error) {
      logger.error(`Failed to initialize ${WALLETS[address]}: ${error.message}`);
      latestSignatures[address] = null;
    }

    // Add delay between wallet initializations to avoid rate limits
    if (i < walletAddresses.length - 1) {
      const delayTime = 10000; // 10 seconds between initializations
      logger.info(`Waiting ${delayTime / 1000} seconds before initializing next wallet...`);
      await delay(delayTime);
    }
  }
}

// Monitor all wallets with a 5-minute delay between each wallet check
async function monitorWallets() {
  const walletAddresses = Object.keys(WALLETS);

  // Process each wallet sequentially with a 5-minute delay between checks
  for (let i = 0; i < walletAddresses.length; i++) {
    const address = walletAddresses[i];

    try {
      await checkWallet(address);
    } catch (error) {
      logger.error(`Failed to check wallet ${WALLETS[address]}: ${error.message}`);
    }

    // Add 5-minute delay between wallet checks (300,000 ms)
    if (i < walletAddresses.length - 1) {
      const delayTime = 300000; // 5 minutes
      logger.info(`Finished checking wallet ${i + 1}/${walletAddresses.length}, waiting ${delayTime / 60000} minutes before checking next wallet...`);
      await delay(delayTime);
    }
  }
}

// Heartbeat function to check system status
async function sendHeartbeat() {
  try {
    const message = `
*💓 Wallet Monitor Heartbeat*
Status: Running
Monitoring: ${Object.keys(WALLETS).length} wallets
Time: ${new Date().toLocaleString()}
`;

    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, message, {
      parse_mode: "Markdown",
    });
    logger.info("Sent heartbeat message");
  } catch (error) {
    logger.error(`Failed to send heartbeat: ${error.message}`);
  }
}

// Main function
async function main() {
  logger.info("Starting Solana Realtime Transaction Notifier");

  try {
    // Initialize with the latest transaction for each wallet
    await initializeLatestSignatures();

    // Send startup message
    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, `*🚀 Solana Transaction Notifier Started*\nMonitoring ${Object.keys(WALLETS).length} wallets for incoming transactions.\nChecking each wallet with a 5-minute interval between checks.`, {
      parse_mode: "Markdown",
    });

    // Schedule heartbeat message every 6 hours
    setInterval(sendHeartbeat, 6 * 60 * 60 * 1000);

    // Set up our monitoring loop that processes all wallets with 5-minute delays between each
    const monitoringLoop = async () => {
      while (true) {
        try {
          await monitorWallets();

          // After processing all wallets, log completion
          logger.info("Completed full monitoring cycle of all wallets");

          // Wait a bit before starting the next cycle
          await delay(30000); // 30 seconds
          logger.info("Starting next monitoring cycle...");
        } catch (error) {
          logger.error(`Error in monitoring loop: ${error.message}`);
          await delay(60000); // Wait a minute before retrying if there's a major error
        }
      }
    };

    // Start the continuous monitoring
    monitoringLoop();
  } catch (error) {
    logger.error(`Error during startup: ${error.message}`);
    try {
      await telegramBot.sendMessage(TELEGRAM_CHAT_ID, `*❌ Error Starting Solana Transaction Notifier*\n${error.message}`, { parse_mode: "Markdown" });
    } catch (telegramError) {
      logger.error(`Failed to send error message to Telegram: ${telegramError.message}`);
    }
  }
}

// Handle errors and keep the bot running
process.on("uncaughtException", (error) => {
  logger.error(`Uncaught exception: ${error.message}`);
  logger.error(error.stack);
});

process.on("unhandledRejection", (error) => {
  logger.error(`Unhandled rejection: ${error.message}`);
  logger.error(error.stack);
});

// Start the bot
main().catch((error) => {
  logger.error(`Startup error: ${error.message}`);
  logger.error(error.stack);
});
