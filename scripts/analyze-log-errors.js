#!/usr/bin/env node
/**
 * Log Error Analysis Script
 * Analyzes 400 and 429 errors in Antigravity2Api log files
 *
 * Usage: node scripts/analyze-log-errors.js <log-file>
 */

const fs = require('fs');
const readline = require('readline');
const path = require('path');

const logFile = process.argv[2];
if (!logFile) {
  console.error('Usage: node analyze-log-errors.js <log-file>');
  process.exit(1);
}

if (!fs.existsSync(logFile)) {
  console.error(`File not found: ${logFile}`);
  process.exit(1);
}

// Statistics
const stats = {
  totalLines: 0,
  totalRequests: 0,
  responses: { 200: 0, 400: 0, 429: 0, other: 0 },

  // 400 error details
  error400: {
    total: 0,
    byMessage: {},     // Group by error message
    byHour: {},        // Group by hour
    byModel: {},       // Group by model
    byClient: {},      // Group by user-agent
    samples: []        // Sample error contexts
  },

  // 429 error details
  error429: {
    total: 0,
    byAccount: {},     // Group by account
    byHour: {},        // Group by hour
    returnedToClient: 0,  // 429 passed to client
    samples: []
  },

  // Account stats
  accounts: new Set(),
  accountErrors: {}
};

// Current request context (for correlating errors)
let currentContext = {
  requestId: null,
  model: null,
  messageCount: null,
  userAgent: null,
  timestamp: null
};

// Buffer for multi-line error messages
let errorBuffer = '';
let inErrorBlock = false;

// Parse timestamp
function parseTimestamp(line) {
  const match = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\]/);
  return match ? match[1] : null;
}

// Get hour from timestamp
function getHour(timestamp) {
  if (!timestamp) return 'unknown';
  return timestamp.substring(0, 13); // YYYY-MM-DDTHH
}

// Strip ANSI color codes
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Process a line
function processLine(line) {
  stats.totalLines++;
  const cleanLine = stripAnsi(line);
  const timestamp = parseTimestamp(cleanLine);

  // Track requests
  if (cleanLine.includes('[REQUEST]') && cleanLine.includes('POST')) {
    stats.totalRequests++;
    const reqMatch = cleanLine.match(/\[REQ-([A-Z0-9]+)-([A-Z0-9]+)\]/);
    if (reqMatch) {
      currentContext.requestId = `REQ-${reqMatch[1]}-${reqMatch[2]}`;
      currentContext.timestamp = timestamp;
    }
  }

  // Track user-agent
  if (cleanLine.includes('"user-agent":')) {
    const uaMatch = cleanLine.match(/"user-agent":\s*"([^"]+)"/);
    if (uaMatch) {
      currentContext.userAgent = uaMatch[1];
    }
  }

  // Track model and message count
  if (cleanLine.includes('"model":') && cleanLine.includes('claude')) {
    const modelMatch = cleanLine.match(/"model":\s*"([^"]+)"/);
    if (modelMatch) {
      currentContext.model = modelMatch[1];
    }
  }
  if (cleanLine.includes('"messageCount":')) {
    const msgMatch = cleanLine.match(/"messageCount":\s*(\d+)/);
    if (msgMatch) {
      currentContext.messageCount = parseInt(msgMatch[1]);
    }
  }

  // Track accounts
  const accountMatch = cleanLine.match(/@([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.json)/);
  if (accountMatch) {
    stats.accounts.add(accountMatch[1]);
  }

  // Track 429 responses
  if (cleanLine.includes('[RESPONSE]') && cleanLine.includes('429')) {
    stats.responses[429]++;
    stats.error429.returnedToClient++;
    const hour = getHour(timestamp);
    stats.error429.byHour[hour] = (stats.error429.byHour[hour] || 0) + 1;
  }

  // Track 429 quota responses (upstream)
  if (cleanLine.includes('收到 429 限流响应') || cleanLine.includes('[QUOTA]') && cleanLine.includes('429')) {
    stats.error429.total++;
    if (accountMatch) {
      const account = accountMatch[1];
      stats.error429.byAccount[account] = (stats.error429.byAccount[account] || 0) + 1;
    }
  }

  // Track 400 responses
  if (cleanLine.includes('[RESPONSE]') && cleanLine.includes('400')) {
    stats.responses[400]++;
    const hour = getHour(timestamp);
    stats.error400.byHour[hour] = (stats.error400.byHour[hour] || 0) + 1;

    // Record model
    if (currentContext.model) {
      stats.error400.byModel[currentContext.model] = (stats.error400.byModel[currentContext.model] || 0) + 1;
    }

    // Record client
    if (currentContext.userAgent) {
      // Simplify user-agent
      let client = 'unknown';
      if (currentContext.userAgent.includes('claude-vscode')) client = 'vscode';
      else if (currentContext.userAgent.includes('cli')) client = 'cli';
      else if (currentContext.userAgent.includes('agent-sdk')) client = 'agent-sdk';
      else client = currentContext.userAgent.substring(0, 30);
      stats.error400.byClient[client] = (stats.error400.byClient[client] || 0) + 1;
    }
  }

  // Track 400 upstream errors with details
  if (cleanLine.includes('[UPSTREAM]') && cleanLine.includes('400')) {
    stats.error400.total++;
    inErrorBlock = true;
    errorBuffer = cleanLine + '\n';
  } else if (inErrorBlock) {
    errorBuffer += line + '\n';

    // Check for error message in JSON
    if (cleanLine.includes('"message":')) {
      const msgMatch = line.match(/"message":\s*"(.+?)"/);
      if (msgMatch) {
        try {
          // The message is often escaped JSON
          let errorMsg = msgMatch[1];
          // Try to parse the inner JSON
          try {
            const innerJson = JSON.parse(errorMsg.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
            if (innerJson.error && innerJson.error.message) {
              errorMsg = innerJson.error.message;
            }
          } catch (e) {
            // Use as-is
          }

          // Normalize the error message (remove specific indices)
          const normalizedMsg = errorMsg.replace(/messages\.\d+/g, 'messages.N')
                                        .replace(/content\.\d+/g, 'content.N');

          stats.error400.byMessage[normalizedMsg] = (stats.error400.byMessage[normalizedMsg] || 0) + 1;

          // Save sample if we don't have many
          if (stats.error400.samples.length < 10) {
            stats.error400.samples.push({
              requestId: currentContext.requestId,
              timestamp: currentContext.timestamp,
              model: currentContext.model,
              messageCount: currentContext.messageCount,
              error: errorMsg
            });
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }

    // End of error block
    if (cleanLine.includes('}') && !cleanLine.includes('{')) {
      inErrorBlock = false;
      errorBuffer = '';
    }
  }

  // Track 200 responses
  if (cleanLine.includes('[RESPONSE]') && cleanLine.includes('200')) {
    stats.responses[200]++;
  }
}

// Main analysis
async function analyze() {
  console.log(`\n📊 Analyzing log file: ${logFile}`);
  console.log('=' .repeat(70));

  const fileStream = fs.createReadStream(logFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    processLine(line);
  }

  // Print results
  console.log('\n📈 SUMMARY');
  console.log('-'.repeat(70));
  console.log(`Total lines:     ${stats.totalLines.toLocaleString()}`);
  console.log(`Total requests:  ${stats.totalRequests.toLocaleString()}`);
  console.log(`Accounts used:   ${stats.accounts.size}`);

  console.log('\n📊 RESPONSE STATUS CODES');
  console.log('-'.repeat(70));
  const total = Object.values(stats.responses).reduce((a, b) => a + b, 0);
  console.log(`200 OK:          ${stats.responses[200].toLocaleString()} (${(stats.responses[200]/total*100).toFixed(1)}%)`);
  console.log(`400 Bad Request: ${stats.responses[400].toLocaleString()} (${(stats.responses[400]/total*100).toFixed(1)}%)`);
  console.log(`429 Too Many:    ${stats.responses[429].toLocaleString()} (${(stats.responses[429]/total*100).toFixed(1)}%)`);

  console.log('\n🚫 400 ERROR ANALYSIS');
  console.log('-'.repeat(70));
  console.log(`Total 400 upstream errors: ${stats.error400.total}`);
  console.log(`Returned to client:        ${stats.responses[400]}`);

  console.log('\n📝 Error Messages (grouped):');
  const sortedMessages = Object.entries(stats.error400.byMessage)
    .sort((a, b) => b[1] - a[1]);
  for (const [msg, count] of sortedMessages) {
    console.log(`  [${count}x] ${msg.substring(0, 80)}${msg.length > 80 ? '...' : ''}`);
  }

  console.log('\n📦 By Model:');
  for (const [model, count] of Object.entries(stats.error400.byModel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${model}: ${count}`);
  }

  console.log('\n👤 By Client:');
  for (const [client, count] of Object.entries(stats.error400.byClient).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${client}: ${count}`);
  }

  console.log('\n⏰ By Hour:');
  for (const [hour, count] of Object.entries(stats.error400.byHour).sort()) {
    console.log(`  ${hour}: ${count}`);
  }

  console.log('\n⏱️ 429 RATE LIMIT ANALYSIS');
  console.log('-'.repeat(70));
  console.log(`Total 429 upstream responses: ${stats.error429.total}`);
  console.log(`Returned to client:           ${stats.error429.returnedToClient}`);

  console.log('\n👤 By Account:');
  for (const [account, count] of Object.entries(stats.error429.byAccount).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${account}: ${count}`);
  }

  console.log('\n⏰ By Hour (returned to client):');
  for (const [hour, count] of Object.entries(stats.error429.byHour).sort()) {
    console.log(`  ${hour}: ${count}`);
  }

  if (stats.error400.samples.length > 0) {
    console.log('\n📋 SAMPLE 400 ERRORS');
    console.log('-'.repeat(70));
    for (const sample of stats.error400.samples.slice(0, 5)) {
      console.log(`\n  Request: ${sample.requestId}`);
      console.log(`  Time:    ${sample.timestamp}`);
      console.log(`  Model:   ${sample.model}`);
      console.log(`  MsgCnt:  ${sample.messageCount}`);
      console.log(`  Error:   ${sample.error}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('Analysis complete!\n');
}

analyze().catch(console.error);
